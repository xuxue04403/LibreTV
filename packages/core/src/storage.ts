/**
 * 本地状态模型与纯函数（历史 / 收藏 / 设置导入导出）。
 *
 * 上游把观看进度放在浏览器 IndexedDB（src/lib/db.ts），
 * 客户端这边由宿主注入持久化（桌面 localStorage、TV DataStore），
 * 这里只提供与存储无关的数据结构与变更函数，便于双端共享语义与单测。
 */

import type {
  AppSettings,
  FavoriteEntry,
  HistoryEntry,
  LiveFavoriteEntry,
  LiveSourceConfig,
  SourceConfig,
} from './types';
import { normalizeTitle } from './cms';
import { clampEpisodeIndex } from './format';

export const DEFAULT_SETTINGS: AppSettings = {
  adultFilter: true,
  adFilter: true,
  autoplayNext: true,
  theme: 'dark',
  resumePlayback: true,
};

export const HISTORY_LIMIT = 200;
export const FAVORITE_LIMIT = 500;

/** 设置快照（导入/导出用） */
export interface AppSnapshot {
  version: 1;
  settings: AppSettings;
  sources: SourceConfig[];
  selectedKeys: string[];
  liveSources: LiveSourceConfig[];
  liveSelectedKeys: string[];
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
  liveFavorites: LiveFavoriteEntry[];
}

export function historyId(sourceKey: string, vodId: string): string {
  return `${sourceKey}:${vodId}`;
}

/**
 * 观看记录的分组键：同一部影片只留一条记录。
 *
 * 记录本身的 `id` 是 `${sourceKey}:${vodId}`（续播要靠它定位到具体哪个源），
 * 但「继续观看」是按影片排的：同一部片子先从非凡资源播、后从量子资源播，
 * 按 id 去重就会留下两张一模一样的卡片。所以去重改按归一化片名 + 年份做。
 *
 * 为什么必须带年份：`西游记`、`射雕英雄传`、`红楼梦` 这类片名在采集站有多个年份的
 * 版本互不相同的片子，只按片名合并会把用户另一部剧的记录**直接删掉**。
 * 老记录没有 year 字段，这时退回「只按片名」，保证升级前的数据仍然能合并。
 */
export function historyGroupKey(title: string, year?: string): string {
  const normalized = normalizeTitle(title);
  const y = (year ?? '').trim();
  return y ? `${normalized}|${y}` : normalized;
}

/**
 * 两条记录是否指同一部片子：片名归一化后相同，且年份不冲突。
 *
 * 任一方缺年份就按片名算同一部——旧数据没存年份，如果严格要求年份相等，
 * 升级后同一次播放会产生「带年份」和「不带年份」两条记录。
 */
export function isSameWork(
  a: Pick<HistoryEntry, 'title' | 'year'>,
  b: Pick<HistoryEntry, 'title' | 'year'>
): boolean {
  if (normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  const ay = (a.year ?? '').trim();
  const by = (b.year ?? '').trim();
  if (!ay || !by) return true;
  return ay === by;
}

/** 写入/更新观看进度：按「影片」去重（跨源）、移到最前、裁剪上限 */
export function upsertHistory(
  list: HistoryEntry[],
  entry: Omit<HistoryEntry, 'updatedAt'> & { updatedAt?: number },
  limit = HISTORY_LIMIT
): HistoryEntry[] {
  const item: HistoryEntry = { ...entry, updatedAt: entry.updatedAt ?? Date.now() };
  const rest = list.filter((h) => h.id !== item.id && !isSameWork(h, item));
  return [item, ...rest].slice(0, limit);
}

/**
 * 把记录里的集数夹进 `[0, episodeCount-1]`。
 *
 * 「看完一集」原本会把 `episodeIndex` 推到 `episodeCount`（见播放页的 finished 分支），
 * 于是首页卡片出现「第 17 / 16 集」这种自相矛盾的数字，而且各处 `Math.min`
 * 兜的边界不同，很容易演成「显示第 15 集、实际播第 2 集」。
 * 读取时统一走这里，历史数据即使已经越界也能正确显示。
 */
export function normalizeHistoryEntry(entry: HistoryEntry): HistoryEntry {
  if (!Number.isFinite(entry.episodeCount) || entry.episodeCount <= 0) return entry;
  const index = clampEpisodeIndex(entry.episodeIndex, entry.episodeCount);
  return index === entry.episodeIndex ? entry : { ...entry, episodeIndex: index };
}

/**
 * 清理历史里已有的重复记录（老版本按 id 去重留下的）。
 *
 * 列表按时间倒序，同一部片子只保留最靠前的那条（也就是最近播放的），
 * 幂等，可以在每次启动时跑一遍。
 */
export function dedupeHistory(list: HistoryEntry[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const h of list) {
    if (out.some((kept) => isSameWork(kept, h))) continue;
    out.push(h);
  }
  return out;
}

/** 取续播信息：同一影片返回上次的集数与位置 */
export function findResumePoint(
  list: HistoryEntry[],
  sourceKey: string,
  vodId: string
): HistoryEntry | undefined {
  const id = historyId(sourceKey, vodId);
  return list.find((h) => h.id === id);
}

/**
 * 按片名查续播（跨源）。
 *
 * 详情页一次只能选中一个源，而上次可能是在另一个源上播的；
 * 按 id 查不到时用它兜底，否则「继续播放」按钮不会出现。
 */
export function findResumeByTitle(
  list: HistoryEntry[],
  title: string,
  year?: string
): HistoryEntry | undefined {
  return list.find((h) => isSameWork(h, { title, year }));
}

/** 收藏开关：已存在则移除，否则置顶插入 */
export function toggleFavorite(list: FavoriteEntry[], entry: Omit<FavoriteEntry, 'createdAt'>, limit = FAVORITE_LIMIT): FavoriteEntry[] {
  const exists = list.some((f) => f.id === entry.id);
  if (exists) return list.filter((f) => f.id !== entry.id);
  return [{ ...entry, createdAt: Date.now() }, ...list].slice(0, limit);
}

export function toggleLiveFavorite(list: LiveFavoriteEntry[], entry: Omit<LiveFavoriteEntry, 'createdAt'>): LiveFavoriteEntry[] {
  const exists = list.some((f) => f.url === entry.url);
  if (exists) return list.filter((f) => f.url !== entry.url);
  return [{ ...entry, createdAt: Date.now() }, ...list];
}

export function isFavorite(list: FavoriteEntry[], id: string): boolean {
  return list.some((f) => f.id === id);
}

export function isLiveFavorite(list: LiveFavoriteEntry[], url: string): boolean {
  return list.some((f) => f.url === url);
}

/** 合并设置（缺字段用默认值补齐，兼容旧快照） */
export function normalizeSettings(raw: unknown): AppSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>;
  return {
    adultFilter: typeof obj.adultFilter === 'boolean' ? obj.adultFilter : DEFAULT_SETTINGS.adultFilter,
    adFilter: typeof obj.adFilter === 'boolean' ? obj.adFilter : DEFAULT_SETTINGS.adFilter,
    autoplayNext: typeof obj.autoplayNext === 'boolean' ? obj.autoplayNext : DEFAULT_SETTINGS.autoplayNext,
    theme: obj.theme === 'light' || obj.theme === 'system' || obj.theme === 'dark' ? obj.theme : DEFAULT_SETTINGS.theme,
    resumePlayback:
      typeof obj.resumePlayback === 'boolean' ? obj.resumePlayback : DEFAULT_SETTINGS.resumePlayback,
  };
}

/** 生成导出快照 */
export function buildSnapshot(state: Omit<AppSnapshot, 'version'>): AppSnapshot {
  return { version: 1, ...state };
}

/** 校验并规范化导入快照；返回 null 表示不是可识别的快照 */
export function parseSnapshot(text: string): AppSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<AppSnapshot> & { customAPIs?: SourceConfig[] };
  const sources = Array.isArray(obj.sources)
    ? obj.sources
    : Array.isArray(obj.customAPIs)
      ? obj.customAPIs
      : [];
  const validSources = sources.filter(
    (s): s is SourceConfig => Boolean(s && typeof s.key === 'string' && typeof s.url === 'string')
  );
  return {
    version: 1,
    settings: normalizeSettings(obj.settings),
    sources: validSources,
    selectedKeys: Array.isArray(obj.selectedKeys) ? obj.selectedKeys.filter((k): k is string => typeof k === 'string') : validSources.map((s) => s.key),
    liveSources: Array.isArray(obj.liveSources)
      ? obj.liveSources.filter((s): s is LiveSourceConfig => Boolean(s && typeof s.key === 'string' && typeof s.url === 'string'))
      : [],
    liveSelectedKeys: Array.isArray(obj.liveSelectedKeys)
      ? obj.liveSelectedKeys.filter((k): k is string => typeof k === 'string')
      : [],
    history: Array.isArray(obj.history) ? (obj.history as HistoryEntry[]) : [],
    favorites: Array.isArray(obj.favorites) ? (obj.favorites as FavoriteEntry[]) : [],
    liveFavorites: Array.isArray(obj.liveFavorites) ? (obj.liveFavorites as LiveFavoriteEntry[]) : [],
  };
}

export function serializeSnapshot(snapshot: AppSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}
