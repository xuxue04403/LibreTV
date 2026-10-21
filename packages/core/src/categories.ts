/**
 * 首页分类入口：从采集站的 `?ac=list` 接口读取分类表，映射到统一分类桶后按类型浏览。
 *
 * Apple CMS 的 type_id 各家不同（有的把「动作片」当顶级分类，有的挂在「电影」下），
 * 所以不能写死 1=电影。这里以「分类名 → 统一桶」的方式建立映射，再回查该源自己的 type_id。
 */

import { cmsRequestHeaders, parseSearchList } from './cms';
import { HttpError, type HttpClient } from './http';
import type { SearchResultItem, SourceConfig } from './types';
export type CategoryKey = 'movie' | 'tv' | 'variety' | 'anime' | 'kids' | 'doc' | 'short' | 'sports' | 'other';

export interface CategoryBucket {
  key: CategoryKey;
  label: string;
  /** 名称命中这些关键词即归入该桶（按顺序判定，越靠前越先匹配） */
  keywords: string[];
}

/**
 * 顺序很重要：判定按数组顺序短路。
 * 「少儿动画」「纪录电影」这类带修饰的名字必须先命中专属桶，否则会被通用的「片」抢走。
 */
export const CATEGORY_BUCKETS: CategoryBucket[] = [
  { key: 'kids', label: '少儿', keywords: ['少儿', '儿童', '亲子', '益智', '儿歌'] },
  { key: 'doc', label: '纪录片', keywords: ['纪录片', '记录片', '纪实', '纪录'] },
  { key: 'anime', label: '动漫', keywords: ['动漫', '动画', '番剧', '国漫', '日漫'] },
  { key: 'variety', label: '综艺', keywords: ['综艺', '真人秀', '脱口秀', '选秀', '晚会'] },
  { key: 'short', label: '短剧', keywords: ['短剧', '微短剧', '竖屏剧'] },
  { key: 'tv', label: '电视剧', keywords: ['电视剧', '连续剧', '剧集', '国产剧', '港台剧', '日韩剧', '欧美剧', '海外剧', '泰剧', '美剧', '韩剧', '日剧'] },
  { key: 'sports', label: '体育', keywords: ['体育', '赛事', '足球', '篮球'] },
  { key: 'movie', label: '电影', keywords: ['电影', '片'] },
  { key: 'other', label: '其他', keywords: [] },
];

/** 首页分类入口的展示顺序（去掉「其他」） */
export const HOME_CATEGORIES: CategoryBucket[] = CATEGORY_BUCKETS.filter((bucket) => bucket.key !== 'other');

/** 采集站的一条分类 */
export interface SourceCategory {
  id: string;
  name: string;
  /** 父分类 id，'0' / 空表示顶级 */
  parentId?: string;
}

/** 名称 → 分类桶（未命中返回 'other'） */
export function classifyCategoryName(name: string): CategoryKey {
  const text = (name || '').trim();
  if (!text) return 'other';
  for (const bucket of CATEGORY_BUCKETS) {
    if (bucket.key === 'other') continue;
    if (bucket.keywords.some((keyword) => text.includes(keyword))) return bucket.key;
  }
  return 'other';
}

/** 分类桶的展示名 */
export function categoryLabel(key: CategoryKey): string {
  return CATEGORY_BUCKETS.find((bucket) => bucket.key === key)?.label ?? '其他';
}

/** 解析 `?ac=list` 响应里的分类表（字段名在各类采集站间有差异，做宽容处理） */
export function parseSourceCategories(data: unknown): SourceCategory[] {
  if (!data || typeof data !== 'object') return [];
  const raw = (data as { class?: unknown; classes?: unknown }).class ?? (data as { classes?: unknown }).classes;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SourceCategory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rawId = record.type_id ?? record.typeId ?? record.id;
    const id = rawId === undefined || rawId === null ? '' : String(rawId).trim();
    const name = String(record.type_name ?? record.typeName ?? record.name ?? '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const rawParent = record.type_pid ?? record.typePid ?? record.parent_id ?? record.parentId;
    const parentId = rawParent === undefined || rawParent === null ? undefined : String(rawParent).trim();
    out.push({ id, name, parentId: parentId && parentId !== '0' ? parentId : undefined });
  }
  return out;
}

/** 在分类表里找某个桶对应的 type_id；优先顶级分类，其次 id 小的（通常是主分类） */
export function matchTypeId(categories: SourceCategory[], key: CategoryKey): string | undefined {
  return matchTypeIds(categories, key, 1)[0];
}

/**
 * 找出某个桶对应的全部 type_id。
 *
 * 关键：Apple CMS 的父分类**不聚合**子分类内容——`?t=1`（电影片）只返回 type_id 恰好
 * 为 1 的条目，动作片/喜剧片是独立 type_id。因此要优先取「叶子分类」，
 * 只有没有子分类时才回退到父分类本身，否则分类页会几乎空白。
 */
export function matchTypeIds(categories: SourceCategory[], key: CategoryKey, limit = 6): string[] {
  const matched = categories.filter((category) => classifyCategoryName(category.name) === key);
  if (matched.length === 0) return [];

  const childCount = new Map<string, number>();
  for (const category of categories) {
    if (!category.parentId) continue;
    childCount.set(category.parentId, (childCount.get(category.parentId) ?? 0) + 1);
  }

  const numeric = (id: string) => {
    const n = Number(id);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };

  const leaves = matched.filter((category) => !childCount.has(category.id));
  const parents = matched.filter((category) => childCount.has(category.id));

  const ordered = [
    ...leaves.sort((a, b) => numeric(a.id) - numeric(b.id)),
    // 父分类只在没有可用叶子时兜底（例如只给了「电影」一个顶级分类的源）
    ...parents.filter((parent) => !matched.some((m) => m.parentId === parent.id)).sort((a, b) => numeric(a.id) - numeric(b.id)),
  ];

  return ordered.slice(0, Math.max(1, limit)).map((category) => category.id);
}

export interface CategoryFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 读取某源的分类表：`?ac=list` 会带回 class 数组 */
export async function fetchSourceCategories(
  source: SourceConfig,
  http: HttpClient,
  opts: CategoryFetchOptions = {}
): Promise<SourceCategory[]> {
  const base = source.url.replace(/\/+$/, '');
  const url = `${base}?ac=list&pg=1`;
  const res = await http.request(url, {
    headers: cmsRequestHeaders(),
    timeoutMs: opts.timeoutMs ?? 10_000,
    signal: opts.signal,
  });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
  let data: unknown;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new HttpError('返回内容不是合法 JSON', res.status);
  }
  return parseSourceCategories(data);
}

export interface CategoryBrowsePage {
  items: SearchResultItem[];
  /** 源站总页数（供 UI 判断是否还能加载更多） */
  pageCount: number;
}

/** 按类型浏览某源的一页内容 */
export async function browseSourceCategory(
  source: SourceConfig,
  typeId: string,
  page: number,
  http: HttpClient,
  opts: CategoryFetchOptions = {}
): Promise<CategoryBrowsePage> {
  const base = source.url.replace(/\/+$/, '');
  const url = `${base}?ac=videolist&t=${encodeURIComponent(typeId)}&pg=${Math.max(1, page)}`;
  const res = await http.request(url, {
    headers: cmsRequestHeaders(),
    timeoutMs: opts.timeoutMs ?? 12_000,
    signal: opts.signal,
  });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
  let data: unknown;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new HttpError('返回内容不是合法 JSON', res.status);
  }
  const items = parseSearchList(data, source);
  const rawCount = parseInt(String((data as { pagecount?: unknown }).pagecount ?? '1'), 10);
  const pageCount = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 1;
  return { items, pageCount };
}

/** 分类表缓存：分类不常变，按源地址缓存 6 小时，避免每次切分类都打上游 */
const categoryCache = new Map<string, { at: number; categories: SourceCategory[] }>();
const CATEGORY_TTL_MS = 6 * 60 * 60 * 1000;

export function getCachedCategories(url: string): SourceCategory[] | undefined {
  const hit = categoryCache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CATEGORY_TTL_MS) {
    categoryCache.delete(url);
    return undefined;
  }
  return hit.categories;
}

export function setCachedCategories(url: string, categories: SourceCategory[]): void {
  categoryCache.set(url, { at: Date.now(), categories });
}

export function clearCategoryCache(): void {
  categoryCache.clear();
}

export interface CategorySourceOutcome {
  sourceKey: string;
  sourceName: string;
  ok: boolean;
  /** 该源是否有这个分类（没有时 UI 显示「该源无此分类」而非失败） */
  supported: boolean;
  count: number;
  error?: string;
  timedOut?: boolean;
  ms: number;
}

export interface CategoryBrowseResult {
  items: SearchResultItem[];
  outcomes: CategorySourceOutcome[];
  /** 命中该分类的源数量 */
  supportedSources: number;
}

export interface CategoryBrowseOptions {
  sources: SourceConfig[];
  key: CategoryKey;
  http: HttpClient;
  /** 每个源抓取的页数（默认 1，翻页由调用方追加） */
  pages?: number;
  /** 单源最多并行抓取的子分类数（默认 6） */
  typeLimit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onSource?: (outcome: CategorySourceOutcome) => void;
}

/** 取某源的分类表（带 6 小时缓存） */
async function categoriesOf(
  source: SourceConfig,
  http: HttpClient,
  opts: CategoryFetchOptions
): Promise<SourceCategory[]> {
  const cached = getCachedCategories(source.url);
  if (cached) return cached;
  const categories = await fetchSourceCategories(source, http, opts);
  setCachedCategories(source.url, categories);
  return categories;
}

/**
 * 按分类聚合浏览：每个源先查自己的分类表，找到该分类（及其子分类）的 type_id 再拉内容。
 * 某个源没有这个分类属于正常情况，不计入失败。
 */
export async function browseCategory(opts: CategoryBrowseOptions): Promise<CategoryBrowseResult> {
  const pages = Math.min(20, Math.max(1, opts.pages ?? 1));
  const typeLimit = Math.min(20, Math.max(1, opts.typeLimit ?? 6));
  const timeoutMs = opts.timeoutMs ?? 12_000;

  interface SourceCollected {
    outcome: CategorySourceOutcome;
    items: SearchResultItem[];
  }

  const collected = await Promise.all(
    opts.sources.map(async (source): Promise<SourceCollected> => {
      const started = Date.now();
      const finish = (
        outcome: Omit<CategorySourceOutcome, 'ms' | 'sourceKey' | 'sourceName'>,
        items: SearchResultItem[] = []
      ): SourceCollected => ({
        outcome: {
          sourceKey: source.key,
          sourceName: source.name,
          ms: Date.now() - started,
          ...outcome,
        },
        items,
      });

      try {
        const categories = await categoriesOf(source, opts.http, { timeoutMs, signal: opts.signal });
        const typeIds = matchTypeIds(categories, opts.key, typeLimit);
        if (typeIds.length === 0) return finish({ ok: true, supported: false, count: 0 });

        // 子分类并行抓取：父分类不聚合子分类，只抓父级会几乎空白
        const batches = await Promise.all(
          typeIds.map(async (typeId) => {
            const list: SearchResultItem[] = [];
            for (let page = 1; page <= pages; page++) {
              const result = await browseSourceCategory(source, typeId, page, opts.http, {
                timeoutMs,
                signal: opts.signal,
              });
              list.push(...result.items);
              if (page >= result.pageCount) break;
            }
            return list;
          })
        );

        const list = batches.flat();
        return finish({ ok: true, supported: true, count: list.length }, list);
      } catch (err) {
        const timedOut = err instanceof HttpError && err.status === 408;
        return finish({
          ok: false,
          supported: false,
          count: 0,
          error: err instanceof Error ? err.message : '失败',
          timedOut,
        });
      }
    })
  );

  const outcomes = collected.map((entry) => entry.outcome);
  for (const outcome of outcomes) {
    try {
      opts.onSource?.(outcome);
    } catch {
      /* 回调异常不影响整体 */
    }
  }

  const items: SearchResultItem[] = [];
  const seen = new Set<string>();
  for (const entry of collected) {
    for (const item of entry.items) {
      const id = `${item.sourceKey}:${item.vodId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(item);
    }
  }

  return {
    items,
    outcomes,
    supportedSources: outcomes.filter((outcome) => outcome.supported).length,
  };
}
