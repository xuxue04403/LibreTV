/**
 * 首页推荐抓取（主进程）。
 *
 * 与上游 LibreTV 的 `/api/{douban,bangumi/calendar,hot-list}` 对应：
 * - 浏览器/渲染层不直连第三方，只调本进程的白名单 IPC；
 * - 地址固定、参数只收枚举值（kind / 榜单 id / 推荐类型 / 标签），不接收任意 URL；
 * - 内存缓存按数据变化频率分层（豆瓣 10 分钟、Bangumi 30 分钟、榜单 1 小时）；
 * - 失败不写缓存：限流或断网恢复后，用户点重试就能拿到新数据。
 *
 * 用户 IP 只暴露给第三方一次（本机直连），不会像「浏览器直连」那样带上页面来源。
 */

import {
  BANGUMI_CALENDAR_URL,
  DOUBAN_SEARCH_URL,
  DOUBAN_TAGS,
  RECOMMEND_CACHE_TTL_MS,
  SIXTY_API_DEFAULT_BASE,
  SIXTY_API_FALLBACK_BASE,
  hotListPath,
  isHotListId,
  parseBangumiCalendar,
  parseDoubanSubjects,
  parseHotList,
  type HotListId,
  type RecommendItem,
  type RecommendSource,
} from '@libretv/core';
import { readLimited } from './proxy';

/** 推荐接口都是 JSON；4MB 足够（榜单/日历最大实测不到 200KB） */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

const DOUBAN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
/** Bangumi 要求 UA 带可识别标识，默认 undici UA 会被拒 */
const BANGUMI_UA = 'LibreTV-Desktop (+https://github.com/LibreSpark/LibreTV)';
const SIXTY_UA = 'LibreTV-Desktop (+https://github.com/LibreSpark/LibreTV)';

export type RecommendRequest =
  | { kind: 'bangumi' }
  | { kind: 'hot-list'; id: HotListId }
  | { kind: 'douban'; type: 'movie' | 'tv'; tag: string };

interface CacheEntry {
  at: number;
  items: RecommendItem[];
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<RecommendItem[]>>();

function cacheKey(request: RecommendRequest): string {
  switch (request.kind) {
    case 'bangumi':
      return 'bangumi';
    case 'hot-list':
      return `hot-list:${request.id}`;
    default:
      return `douban:${request.type}:${request.tag}`;
  }
}

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return '网络请求失败';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return '请求超时';
  const cause = (err as { cause?: { code?: string } }).cause;
  switch (cause?.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析失败';
    case 'ECONNREFUSED':
      return '连接被拒绝';
    case 'ECONNRESET':
      return '连接被重置';
    default:
      return err.message === 'fetch failed' ? '网络连接失败' : err.message;
  }
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      // 固定上游地址；重定向照常跟随即可，这里不接受渲染层传入的 URL
      redirect: 'follow',
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(describeNetworkError(err));
  }
  if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
  const buf = await readLimited(res, MAX_RESPONSE_BYTES);
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(buf));
  } catch {
    throw new Error('上游返回的不是 JSON');
  }
}

/** 自部署 60s 实例：只认 http(s)，非法值静默回退默认实例 */
function sixtyApiBase(): string {
  const raw = process.env['60S_API_BASE']?.trim();
  if (raw && /^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '');
  return SIXTY_API_DEFAULT_BASE;
}

async function loadBangumi(): Promise<RecommendItem[]> {
  const raw = await fetchJson(BANGUMI_CALENDAR_URL, { 'User-Agent': BANGUMI_UA });
  const items = parseBangumiCalendar(raw);
  if (items.length === 0) throw new Error('Bangumi 放送表没有可用条目');
  return items;
}

async function loadHotList(id: HotListId): Promise<RecommendItem[]> {
  const primary = sixtyApiBase();
  // 主实例限流/宕机时回退官方公共实例；两者相同则只试一次
  const bases = primary === SIXTY_API_FALLBACK_BASE ? [primary] : [primary, SIXTY_API_FALLBACK_BASE];
  let lastError: unknown;
  for (const base of bases) {
    try {
      const raw = await fetchJson(`${base}${hotListPath(id)}`, { 'User-Agent': SIXTY_UA });
      const items = parseHotList(raw, id);
      // 榜单为空通常是上游限流或接口变更，不能写入缓存
      if (items.length === 0) throw new Error('榜单数据为空');
      return items;
    } catch (err) {
      lastError = err;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : '请求失败';
  throw new Error(`榜单获取失败：${reason}`);
}

/** 豆瓣直连被拒时，允许部署者通过 FALLBACK_CORS_PROXY 走公共代理（与上游一致） */
function fallbackCorsProxy(): string | undefined {
  const raw = process.env.FALLBACK_CORS_PROXY?.trim();
  if (raw && /^https?:\/\//i.test(raw)) return raw;
  return undefined;
}

async function fetchDoubanJson(target: string): Promise<unknown> {
  const headers = { 'User-Agent': DOUBAN_UA, Referer: 'https://movie.douban.com/' };
  try {
    return await fetchJson(target, headers);
  } catch (directError) {
    const proxy = fallbackCorsProxy();
    if (!proxy) throw directError;
    try {
      return await fetchJson(proxy + encodeURIComponent(target), {});
    } catch {
      throw directError;
    }
  }
}

async function loadDouban(type: 'movie' | 'tv', tag: string): Promise<RecommendItem[]> {
  const params = new URLSearchParams({
    type,
    tag,
    sort: 'recommend',
    page_limit: '50',
    page_start: '0',
  });
  const raw = await fetchDoubanJson(`${DOUBAN_SEARCH_URL}?${params.toString()}`);
  const items = parseDoubanSubjects(raw, type);
  if (items.length === 0) throw new Error('豆瓣没有返回可用条目（可能触发限流）');
  return items;
}

function normalizeRequest(input: unknown): { request: RecommendRequest; source: RecommendSource } {
  if (!input || typeof input !== 'object') throw new Error('推荐请求格式不正确');
  const kind = (input as { kind?: unknown }).kind;
  if (kind === 'bangumi') return { request: { kind }, source: 'bangumi' };
  if (kind === 'hot-list') {
    const id = (input as { id?: unknown }).id;
    if (!isHotListId(id)) throw new Error('未知榜单');
    return { request: { kind, id }, source: 'hot-list' };
  }
  if (kind === 'douban') {
    const type = (input as { type?: unknown }).type;
    const tag = (input as { tag?: unknown }).tag;
    if (type !== 'movie' && type !== 'tv') throw new Error('未知推荐类型');
    // 标签只接受内置枚举：不允许渲染层拼任意查询串
    if (typeof tag !== 'string' || !DOUBAN_TAGS[type].includes(tag)) throw new Error('未知推荐标签');
    return { request: { kind, type, tag }, source: 'douban' };
  }
  throw new Error('未知推荐类型');
}

async function load(request: RecommendRequest): Promise<RecommendItem[]> {
  switch (request.kind) {
    case 'bangumi':
      return loadBangumi();
    case 'hot-list':
      return loadHotList(request.id);
    default:
      return loadDouban(request.type, request.tag);
  }
}

/**
 * 拉取推荐（带缓存与同键合并）。
 * 同 key 的并发请求共享一个 Promise：首页/设置来回切换不会打出多倍请求。
 */
export async function fetchRecommend(input: unknown): Promise<RecommendItem[]> {
  const { request, source } = normalizeRequest(input);
  const key = cacheKey(request);

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < RECOMMEND_CACHE_TTL_MS[source]) {
    return cached.items;
  }

  const running = inflight.get(key);
  if (running) return running;

  const task = load(request)
    .then((items) => {
      cache.set(key, { at: Date.now(), items });
      return items;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

/** 测试/诊断用：清空缓存 */
export function clearRecommendCache(): void {
  cache.clear();
}
