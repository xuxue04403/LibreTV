import {
  catalogItems,
  catalogSignature,
  dedupeItems,
  emptyCatalog,
  markCatalogChecked,
  searchCacheItems,
  staleCategories,
  withCatalogEntry,
  withSearchEntry,
  type CatalogSnapshot,
  type SearchCacheSnapshot,
  type CategoryKey,
  type SearchResultItem,
  type SourceConfig,
} from '@librextv/core';

/**
 * 分类目录的本地缓存（localStorage 适配层）。
 *
 * 纯逻辑在 `@librextv/core` 的 `catalog.ts`，这里只负责读写与「源变更时整体作废」。
 *
 * 为什么值得落盘：用户抱怨「每次切换分类、每次检索都像在重新加载播放源」。
 * 一次分类浏览要打 4 个源 × 最多 6 个子分类，冷启动约 2~6 秒；缓存命中是 0 毫秒。
 */

const KEY = 'librextv-catalog-v1';
const SEARCH_KEY = 'librextv-search-cache-v1';

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

/**
 * 只记「刚查过」，不动已有内容。
 *
 * 一趟刷新拿回空结果有两种可能：分类本来就空，或这次网络抽风。两种都不该清内容，
 * 但都必须记下时间——否则「空分类」永远不算新鲜，后台每小时都为它重打一轮
 * （4 源 × 8 分类 = 32 个请求），用户看到的还是同一片空白。
 *
 * 桌面端此前完全没有调用过它（只有安卓端 `AppViewModel` 在调），
 * 于是抓不到内容的分类永远停在 `entries` 缺席状态，被每小时重复预热。
 */
export function markCategoryChecked(
  sources: SourceConfig[],
  adultFilter: boolean,
  key: CategoryKey
): void {
  const signature = signatureOf(sources, adultFilter);
  writeCatalog(markCatalogChecked(readCatalog(signature), key));
}

/**
 * 搜索缓存必须连同「当时的源集合」一起存。
 *
 * 旧实现的键只有「关键词 + 成人开关」：删掉一个源、或在设置里关掉成人过滤，
 * 30 分钟内搜同一个词仍会命中旧结果——已经删掉的源条目照样出现在列表里，
 * 点开还能用它记着的 `sourceUrl` 经本地代理起播。也就是说「删源」和
 * 「成人过滤」都能被一份过期缓存绕过去。
 *
 * 这里在快照上记一个签名（源 url 集合 + 成人开关，与分类缓存同一份实现），
 * 签名不符就整份作废。
 */
interface SignedSearchCache extends SearchCacheSnapshot {
  signature?: string;
}

export function readSearchCache(): SignedSearchCache | undefined {
  return readJson<SignedSearchCache>(SEARCH_KEY);
}

export function cachedSearch(
  sources: SourceConfig[],
  adultFilter: boolean,
  word: string
): SearchResultItem[] | undefined {
  const snapshot = readSearchCache();
  if (!snapshot) return undefined;
  if (snapshot.signature !== signatureOf(sources, adultFilter)) return undefined;
  return searchCacheItems(snapshot, word, adultFilter);
}

export function rememberSearch(
  sources: SourceConfig[],
  adultFilter: boolean,
  word: string,
  items: SearchResultItem[]
): void {
  const signature = signatureOf(sources, adultFilter);
  const raw = readSearchCache();
  // 源集合变了就从空快照重来，别把旧签名下的条目一起带过去
  const base: SearchCacheSnapshot =
    raw && raw.signature === signature && raw.entries ? { entries: raw.entries } : { entries: {} };
  writeJson(SEARCH_KEY, {
    ...withSearchEntry(base, word, adultFilter, items),
    signature,
  } satisfies SignedSearchCache);
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
