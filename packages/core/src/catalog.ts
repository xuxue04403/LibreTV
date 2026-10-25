import type { CategoryKey } from './categories';
import type { SearchResultItem, SourceConfig } from './types';

/**
 * 分类目录与检索结果的「快照」缓存。
 *
 * 为什么要在 core 里做：桌面端用 localStorage、TV 端用 DataStore，落盘方式不同，
 * 但「什么时候算新鲜、条目怎么裁剪、签名怎么算」必须两端一致——否则会出现
 * 「桌面端切分类秒开、TV 端还在转圈」这种对不上的体验。
 *
 * 只放纯函数，不碰任何存储 API，两端各自写 30 行适配层即可。
 */

export interface CatalogEntry {
  at: number;
  items: SearchResultItem[];
}

export interface CatalogSnapshot {
  /** 启用源集合 + 成人过滤开关，任一变化都要整体换快照 */
  signature: string;
  entries: Partial<Record<CategoryKey, CatalogEntry>>;
}

/** 缓存有效期：超过就刷新，但界面仍先用旧内容顶上（总比空白好） */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/** 后台刷新周期：用户要求「每小时自动拉一次」 */
export const CATALOG_REFRESH_MS = 60 * 60 * 1000;

/** 单分类最多缓存这么多条：首页每个分类只展示十几条，分类页首屏也就一两屏 */
export const MAX_CATALOG_ITEMS = 240;

export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

/** 只保留最近这么多个关键词，避免无限增长 */
export const MAX_SEARCH_KEYWORDS = 20;

/** 单个关键词最多缓存这么多条 */
export const MAX_SEARCH_ITEMS = 300;

/**
 * 快照签名。
 *
 * 源地址排序后拼接，所以源在设置里的排列顺序变化不会让缓存失效；
 * 成人过滤开关必须编进来：关掉过滤时能搜到的内容更多，复用过滤后的缓存会少东西。
 */
export function catalogSignature(sources: SourceConfig[], adultFilter: boolean): string {
  return `${sources
    .map((source) => source.url)
    .sort()
    .join(',')}|${adultFilter ? 1 : 0}`;
}

export function emptyCatalog(signature: string): CatalogSnapshot {
  return { signature, entries: {} };
}

/**
 * 取某分类的缓存条目。
 *
 * 没有缓存过时返回 undefined 而不是空数组：界面要区分「没缓存（先显示骨架）」
 * 和「缓存里就是空的（显示空状态）」。
 */
export function catalogItems(snapshot: CatalogSnapshot, key: CategoryKey): SearchResultItem[] | undefined {
  const entry = snapshot.entries[key];
  if (!entry || entry.items.length === 0) return undefined;
  return entry.items;
}

export function isCatalogFresh(
  snapshot: CatalogSnapshot,
  key: CategoryKey,
  now: number = Date.now()
): boolean {
  const entry = snapshot.entries[key];
  if (!entry) return false;
  return now - entry.at < CATALOG_TTL_MS;
}

/**
 * 写入一个分类。
 *
 * 空列表不覆盖：刷新失败或源临时抽风时若用空结果覆盖，用户切回这个分类
 * 就只剩空页面，比保留旧内容糟糕得多。
 */
export function withCatalogEntry(
  snapshot: CatalogSnapshot,
  key: CategoryKey,
  items: SearchResultItem[],
  now: number = Date.now()
): CatalogSnapshot {
  if (items.length === 0) return snapshot;
  return {
    ...snapshot,
    entries: {
      ...snapshot.entries,
      [key]: { at: now, items: items.slice(0, MAX_CATALOG_ITEMS) },
    },
  };
}

/** 还该刷新的分类（没缓存过或已过期） */
export function staleCategories(
  snapshot: CatalogSnapshot,
  keys: CategoryKey[],
  now: number = Date.now()
): CategoryKey[] {
  return keys.filter((key) => !isCatalogFresh(snapshot, key, now));
}

export interface SearchCacheEntry {
  at: number;
  items: SearchResultItem[];
}

export interface SearchCacheSnapshot {
  entries: Record<string, SearchCacheEntry>;
}

/** 关键词键：大小写与首尾空格不影响命中，成人开关不同则不能共用 */
export function searchCacheKey(word: string, adultFilter: boolean): string {
  return `${word.trim().toLowerCase()}|${adultFilter ? 1 : 0}`;
}

export function searchCacheItems(
  snapshot: SearchCacheSnapshot | undefined,
  word: string,
  adultFilter: boolean,
  now: number = Date.now()
): SearchResultItem[] | undefined {
  const entry = snapshot?.entries[searchCacheKey(word, adultFilter)];
  if (!entry) return undefined;
  if (now - entry.at > SEARCH_CACHE_TTL_MS) return undefined;
  if (entry.items.length === 0) return undefined;
  return entry.items;
}

/** 写入一条检索结果，超过关键词上限时丢掉最旧的 */
export function withSearchEntry(
  snapshot: SearchCacheSnapshot,
  word: string,
  adultFilter: boolean,
  items: SearchResultItem[],
  now: number = Date.now()
): SearchCacheSnapshot {
  if (items.length === 0) return snapshot;
  const merged: Record<string, SearchCacheEntry> = {
    ...snapshot.entries,
    [searchCacheKey(word, adultFilter)]: { at: now, items: items.slice(0, MAX_SEARCH_ITEMS) },
  };
  const keys = Object.keys(merged);
  if (keys.length <= MAX_SEARCH_KEYWORDS) return { entries: merged };

  const kept: Record<string, SearchCacheEntry> = {};
  for (const key of keys.sort((a, b) => merged[b]!.at - merged[a]!.at).slice(0, MAX_SEARCH_KEYWORDS)) {
    kept[key] = merged[key]!;
  }
  return { entries: kept };
}

/** 合并时按「源:片 ID」去重，先出现的胜出 */
export function dedupeItems(items: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const item of items) {
    const id = `${item.sourceKey}:${item.vodId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}
