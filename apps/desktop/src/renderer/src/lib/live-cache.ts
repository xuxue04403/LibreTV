import type { LiveChannel, LivePlaylist } from '@libretv/core';

/**
 * 直播频道列表的本地缓存。
 *
 * 为什么必须缓存：iptv-org 的 index.m3u 有 2.5MB，实测服务器限速到 ~35KB/s，
 * 每次进直播页都重下要等一分钟以上。频道列表一天内基本不变，缓存 6 小时
 * 就能把「进直播页」从一分钟降到 0（命中即渲染），后台再静默刷新。
 */
const CACHE_KEY = 'libretv-live-cache-v1';
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

export function readLiveCache(key: string): CachedChannel[] | undefined {
  const entry = read()[key];
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) return undefined;
  return entry.channels;
}

export function writeLiveCache(key: string, channels: CachedChannel[], adultFilter: boolean): void {
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

export function clearLiveCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* 同上 */
  }
}

/** 供播放页使用：从缓存或正在加载的列表里找到某频道在「当前可见列表」中的位置 */
export type PlaylistLike = LivePlaylist & { epgUrl?: string };
