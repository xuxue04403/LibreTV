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

function write(map: CacheMap): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {
    /* 配额满：缓存只是优化，失败不影响功能 */
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
  const map = read();
  const now = Date.now();
  // 顺手清掉过期项，避免 localStorage 被历史源占满
  for (const [k, v] of Object.entries(map)) {
    if (now - v.at > TTL_MS) delete map[k];
  }
  map[key] = { at: now, sources: key, adultFilter, channels };
  write(map);
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
