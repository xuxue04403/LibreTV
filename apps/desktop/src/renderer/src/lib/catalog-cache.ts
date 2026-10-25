import {
  catalogItems,
  catalogSignature,
  dedupeItems,
  emptyCatalog,
  searchCacheItems,
  staleCategories,
  withCatalogEntry,
  withSearchEntry,
  type CatalogSnapshot,
  type SearchCacheSnapshot,
  type CategoryKey,
  type SearchResultItem,
  type SourceConfig,
} from '@libretv/core';

/**
 * 分类目录的本地缓存（localStorage 适配层）。
 *
 * 纯逻辑在 `@libretv/core` 的 `catalog.ts`，这里只负责读写与「源变更时整体作废」。
 *
 * 为什么值得落盘：用户抱怨「每次切换分类、每次检索都像在重新加载播放源」。
 * 一次分类浏览要打 4 个源 × 最多 6 个子分类，冷启动约 2~6 秒；缓存命中是 0 毫秒。
 */

const KEY = 'libretv-catalog-v1';
const SEARCH_KEY = 'libretv-search-cache-v1';

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满：缓存只是优化，失败不影响功能 */
  }
}

/** 读目录快照；签名不符（源集合或成人开关变了）就当作没有 */
export function readCatalog(signature: string): CatalogSnapshot {
  const cached = readJson<CatalogSnapshot>(KEY);
  if (!cached || cached.signature !== signature || typeof cached.entries !== 'object') {
    return emptyCatalog(signature);
  }
  return cached;
}

export function writeCatalog(snapshot: CatalogSnapshot): void {
  writeJson(KEY, snapshot);
}

/** 源集合签名：与 core 里同一份实现，保证两端缓存口径一致 */
export function signatureOf(sources: SourceConfig[], adultFilter: boolean): string {
  return catalogSignature(sources, adultFilter);
}

export function cachedItems(sources: SourceConfig[], adultFilter: boolean, key: CategoryKey): SearchResultItem[] | undefined {
  return catalogItems(readCatalog(signatureOf(sources, adultFilter)), key);
}

/** 把新抓到的结果并进缓存（空结果不覆盖，避免一次失败把旧内容清空） */
export function rememberItems(
  sources: SourceConfig[],
  adultFilter: boolean,
  key: CategoryKey,
  items: SearchResultItem[]
): CatalogSnapshot {
  const snapshot = withCatalogEntry(readCatalog(signatureOf(sources, adultFilter)), key, items);
  writeCatalog(snapshot);
  return snapshot;
}

export function missingCategories(
  sources: SourceConfig[],
  adultFilter: boolean,
  keys: CategoryKey[]
): CategoryKey[] {
  return staleCategories(readCatalog(signatureOf(sources, adultFilter)), keys);
}

export function readSearchCache(): SearchCacheSnapshot | undefined {
  return readJson<SearchCacheSnapshot>(SEARCH_KEY);
}

export function cachedSearch(word: string, adultFilter: boolean): SearchResultItem[] | undefined {
  return searchCacheItems(readSearchCache(), word, adultFilter);
}

export function rememberSearch(word: string, adultFilter: boolean, items: SearchResultItem[]): void {
  const base = readSearchCache() ?? { entries: {} };
  writeJson(SEARCH_KEY, withSearchEntry(base, word, adultFilter, items));
}

export function clearCatalogCache(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(SEARCH_KEY);
  } catch {
    /* ignore */
  }
}

export { dedupeItems };
