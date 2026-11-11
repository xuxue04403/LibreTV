import type { LiveChannel, LivePlaylist } from '@librextv/core';

/**
 * 直播频道列表的本地缓存。
 *
 * 为什么必须缓存：iptv-org 的 index.m3u 有 2.5MB，实测服务器限速到 ~35KB/s，
 * 每次进直播页都重下要等一分钟以上。频道列表一天内基本不变，缓存 6 小时
 * 就能把「进直播页」从一分钟降到 0（命中即渲染），后台再静默刷新。
 */
const CACHE_KEY = 'librextv-live-cache-v1';
const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 只保留最近一次写入的那一份（当前源集合 + 当前成人开关）。
 *
 * 早先按 `源集合#开关` 各自留一份，切一次成人过滤就会多存一整份全量频道：
 * iptv-org 全球榜有一万多个频道、单份 1~3MB，两份就顶爆 localStorage 的 5MB 配额。
 * 一旦 `setItem` 抛错就被 catch 吞掉，表现为「缓存永远不生效、每次启动都重下 70 秒」。
 */
const MAX_CHANNELS = 24000;

export interface CachedChannel extends LiveChannel {
  sourceKey: string;
  sourceName: string;
  epg?: string;
}

interface CacheEntry {
  at: number;
  sources: string;
  adultFilter: boolean;
  channels: CachedChannel[];
  /** 写时就知道有没有被裁剪过，读的时候不必再猜 */
  truncated?: boolean;
}

type CacheMap = Record<string, CacheEntry>;

function read(): CacheMap {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CacheMap) : {};
  } catch {
    return {};
  }
}

function write(map: CacheMap): boolean {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
    return true;
  } catch {
    /* 配额满：缓存只是优化，失败不影响功能 */
    return false;
  }
}

/** 缓存键：源地址集合 + 成人过滤开关（任一变化都要重新拉） */
export function liveCacheKey(urls: string[], adultFilter: boolean): string {
  return `${[...urls].sort().join('|')}#${adultFilter ? 1 : 0}`;
}

/** 逐项校验：脏缓存一律丢弃，绝不让它流进 filterChannels 把整页打白 */
function toCachedChannel(raw: unknown): CachedChannel | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Partial<CachedChannel>;
  if (typeof item.url !== 'string' || item.url === '') return undefined;
  if (typeof item.name !== 'string') return undefined;
  if (typeof item.id !== 'string' || item.id === '') return undefined;
  if (typeof item.sourceKey !== 'string' || item.sourceKey === '') return undefined;
  if (typeof item.sourceName !== 'string') return undefined;
  const channel: CachedChannel = {
    id: item.id,
    url: item.url,
    name: item.name,
    sourceKey: item.sourceKey,
    sourceName: item.sourceName,
  };
  // 可选字段只接受字符串/布尔，类型不对就当没有——保留频道的其余信息仍然有用
  if (typeof item.logo === 'string') channel.logo = item.logo;
  if (typeof item.group === 'string') channel.group = item.group;
  if (typeof item.tvgId === 'string') channel.tvgId = item.tvgId;
  if (typeof item.rawName === 'string') channel.rawName = item.rawName;
  if (typeof item.epg === 'string') channel.epg = item.epg;
  return channel;
}

export function readLiveCache(key: string): CachedChannel[] | undefined {
  const entry = read()[key];
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  if (!Array.isArray(entry.channels)) return undefined;
  // 之前这里直接 `return entry.channels`：只要 localStorage 里那条记录被外部改过
  // （老版本写的、手工编辑过、写一半断电截断），数组里就可能混进 null 或
  // 缺 url 的对象，随后 filterChannels/filterAdultChannels 里 `ch.group.toLowerCase()`
  // 抛 TypeError，被 ErrorBoundary 接住后整页白屏，而且刷新也没用——脏数据还在，
  // 每次进直播页都必崩。这里逐项校验，坏的直接丢掉。
  const safe: CachedChannel[] = [];
  for (const item of entry.channels) {
    const channel = toCachedChannel(item);
    if (channel) safe.push(channel);
  }
  return safe.length > 0 ? safe : undefined;
}

/**
 * 写缓存：真正落盘推迟到浏览器空闲时。
 *
 * 一万多个频道的 JSON.stringify 在主线程上要几十毫秒，而这次调用正好发生在
 * 「刚下载完、要立刻把列表铺满屏幕」的那一刻——同步写会把这一帧卡住。
 * 合并同一轮里的多次写，只保留最后一份（本来就只存一份），
 * 空闲时再序列化。
 */
let pendingWrite: { key: string; channels: CachedChannel[]; adultFilter: boolean } | null = null;
let writeScheduled = false;

function flushWrite(): void {
  writeScheduled = false;
  const job = pendingWrite;
  pendingWrite = null;
  if (!job) return;
  doWrite(job.key, job.channels, job.adultFilter);
}

function scheduleWrite(key: string, channels: CachedChannel[], adultFilter: boolean): void {
  pendingWrite = { key, channels, adultFilter };
  if (writeScheduled) return;
  writeScheduled = true;
  // requestIdleCallback 在 Chromium 里可用；没有就退化成宏任务
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof ric === 'function') ric(flushWrite, { timeout: 2_000 });
  else window.setTimeout(flushWrite, 0);
}

function doWrite(key: string, channels: CachedChannel[], adultFilter: boolean): void {
  const now = Date.now();
  const capped = channels.length > MAX_CHANNELS ? channels.slice(0, MAX_CHANNELS) : channels;
  const entry: CacheEntry = {
    at: now,
    sources: key,
    adultFilter,
    channels: capped,
    truncated: capped.length < channels.length,
  };
  // 只留这一份：旧键（换过源或换过成人开关）整份作废，不再同时积压多份全量频道
  if (!write({ [key]: entry })) {
    // 写不下就退一步只存前 4000 条，保证「进直播页秒出前几屏」这个主要收益还在
    const fallback = { ...entry, channels: capped.slice(0, 4000), truncated: true };
    write({ [key]: fallback });
  }
}

export function writeLiveCache(key: string, channels: CachedChannel[], adultFilter: boolean): void {
  scheduleWrite(key, channels, adultFilter);
}

/** 立刻把待写的缓存落盘（页面要关/要跳走时调用，避免丢缓存） */
export function flushLiveCacheWrite(): void {
  if (pendingWrite) flushWrite();
}

export function clearLiveCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* 同上 */
  }
}

/** 供播放页使用：从缓存或正在加载的列表里找到某频道在「当前可见列表」中的位置 */
export type PlaylistLike = LivePlaylist & { epgUrl?: string };
