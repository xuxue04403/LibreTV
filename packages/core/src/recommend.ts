/**
 * 首页推荐（外部内容发现层）。
 *
 * 移植自 LibreTV 官方文档《首页推荐》与 `.tmp-upstream/src/lib/{bangumi,douban,douban-weekly}.ts`：
 * 推荐数据和片源完全解耦，只负责「发现」，点击后仍按标题走本地多源搜索。
 * 因此冷启动、一个源都没配、源里没有分类内容时，首页也有内容可看。
 *
 * 这一层只放**纯函数与常量**：HTTP、缓存与 UA/Referer 伪装留在宿主
 * （桌面端主进程 `apps/desktop/src/main/recommend.ts`），便于复用与单测。
 */

import { isAdultContent } from './cms';
import type { RecommendSource } from './types';

export interface RecommendItem {
  /** 数据源内的稳定 id；百度榜没有 id，用榜单内序号 */
  id: string;
  title: string;
  cover: string;
  /** 评分：Bangumi 一位小数、豆瓣原样、百度榜没有 */
  rating?: string;
  year?: string;
  isTv: boolean;
  source: RecommendSource;
  /** Bangumi 每日放送：1=周一 … 7=周日 */
  weekday?: number;
  /** 影视榜单：属于哪个榜 */
  listId?: HotListId;
}

// —— 数据源地址与缓存 ——

export const BANGUMI_CALENDAR_URL = 'https://api.bgm.tv/calendar';
export const DOUBAN_SEARCH_URL = 'https://movie.douban.com/j/search_subjects';
/** 60s API：默认社区实例，失败回退官方公共实例；可用 60S_API_BASE 指向自部署实例 */
export const SIXTY_API_DEFAULT_BASE = 'https://60s.crystelf.top';
export const SIXTY_API_FALLBACK_BASE = 'https://60s.viki.moe';

/**
 * 按数据变化频率分层缓存（与上游一致）：
 * 豆瓣标签 10 分钟、Bangumi 放送表 30 分钟、周榜 1 小时。
 */
export const RECOMMEND_CACHE_TTL_MS: Record<RecommendSource, number> = {
  douban: 10 * 60 * 1000,
  bangumi: 30 * 60 * 1000,
  'hot-list': 60 * 60 * 1000,
};

// —— 影视榜单 ——

export type HotListId =
  | 'douban_movie_weekly'
  | 'douban_tv_chinese'
  | 'douban_tv_global'
  | 'douban_show_chinese'
  | 'douban_show_global'
  | 'baidu_teleplay';

export interface HotListSource {
  id: HotListId;
  label: string;
  /** 榜单内容是否剧集/综艺（豆瓣电影周榜是电影） */
  isTv: boolean;
}

/** 影视热榜：豆瓣五个周榜 + 百度热播剧榜 */
export const HOT_LISTS: HotListSource[] = [
  { id: 'douban_movie_weekly', label: '电影周榜', isTv: false },
  { id: 'douban_tv_chinese', label: '国产剧周榜', isTv: true },
  { id: 'douban_tv_global', label: '海外剧周榜', isTv: true },
  { id: 'douban_show_chinese', label: '国内综艺', isTv: true },
  { id: 'douban_show_global', label: '海外综艺', isTv: true },
  { id: 'baidu_teleplay', label: '百度热播剧', isTv: true },
];

const DOUBAN_WEEKLY_CATEGORY: Partial<Record<HotListId, string>> = {
  douban_movie_weekly: 'movie',
  douban_tv_chinese: 'tv_chinese',
  douban_tv_global: 'tv_global',
  douban_show_chinese: 'show_chinese',
  douban_show_global: 'show_global',
};

export function isHotListId(value: unknown): value is HotListId {
  return typeof value === 'string' && HOT_LISTS.some((l) => l.id === value);
}

export function hotListSource(id: HotListId): HotListSource {
  return HOT_LISTS.find((l) => l.id === id) ?? { id: 'douban_movie_weekly', label: '电影周榜', isTv: false };
}

/** 60s API 路径：豆瓣周榜或百度热播剧 */
export function hotListPath(id: HotListId): string {
  const category = DOUBAN_WEEKLY_CATEGORY[id];
  return category ? `/v2/douban/weekly/${category}` : '/v2/baidu/teleplay';
}

// —— 豆瓣标签 ——

export const DOUBAN_TAGS: Record<'movie' | 'tv', string[]> = {
  movie: ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动画'],
  tv: ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'],
};

export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function recommendSourceLabel(source: RecommendSource): string {
  switch (source) {
    case 'bangumi':
      return 'Bangumi 每日放送';
    case 'douban':
      return '豆瓣推荐';
    default:
      return '影视榜单';
  }
}

// —— 归一化 ——

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 评分统一成「最多一位小数」的字符串；0/负数/非数字视为没有评分 */
function ratingText(value: unknown): string | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return number.toFixed(1);
}

function bangumiWeekday(value: unknown): number | undefined {
  const id = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(id) && id >= 1 && id <= 7 ? id : undefined;
}

interface BangumiSubject {
  id?: unknown;
  name?: unknown;
  name_cn?: unknown;
  images?: { large?: unknown; common?: unknown; medium?: unknown; small?: unknown; grid?: unknown };
  rating?: { score?: unknown };
}

function bangumiSubjectToItem(subject: BangumiSubject, weekday: number): RecommendItem | undefined {
  const id = subject.id === undefined || subject.id === null ? '' : String(subject.id);
  // 中文名优先：采集站里 Bangumi 原名（日文）几乎搜不到，name_cn 命中率高得多
  const title = text(subject.name_cn) ?? text(subject.name);
  const cover =
    text(subject.images?.large) ??
    text(subject.images?.common) ??
    text(subject.images?.medium) ??
    text(subject.images?.small) ??
    text(subject.images?.grid);
  if (!id || !title || !cover) return undefined;
  return {
    id,
    title,
    cover,
    rating: ratingText(subject.rating?.score),
    isTv: true,
    source: 'bangumi',
    weekday,
  };
}

/**
 * Bangumi `/calendar` → 统一条目。
 * `weekday.id` 偶发返回 8 等非法值，直接丢弃该天。
 */
export function parseBangumiCalendar(raw: unknown): RecommendItem[] {
  if (!Array.isArray(raw)) return [];
  const items: RecommendItem[] = [];
  for (const day of raw as { weekday?: { id?: unknown }; items?: unknown }[]) {
    const weekday = bangumiWeekday(day?.weekday?.id);
    if (!weekday || !Array.isArray(day.items)) continue;
    for (const subject of day.items as BangumiSubject[]) {
      const item = bangumiSubjectToItem(subject, weekday);
      if (item) items.push(item);
    }
  }
  return items;
}

interface DoubanSubject {
  id?: unknown;
  title?: unknown;
  cover?: unknown;
  rate?: unknown;
}

function doubanSubjectToItem(subject: DoubanSubject, isTv: boolean): RecommendItem | undefined {
  const id = subject.id === undefined || subject.id === null ? '' : String(subject.id);
  const title = text(subject.title);
  const cover = text(subject.cover);
  if (!id || !title || !cover) return undefined;
  return {
    id,
    title,
    cover,
    rating: ratingText(subject.rate),
    isTv,
    source: 'douban',
  };
}

/** 豆瓣 `j/search_subjects` → 统一条目 */
export function parseDoubanSubjects(raw: unknown, type: 'movie' | 'tv'): RecommendItem[] {
  const subjects = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { subjects?: unknown }).subjects)
      ? (raw as { subjects: unknown[] }).subjects
      : [];
  return subjects
    .map((subject) => doubanSubjectToItem(subject as DoubanSubject, type === 'tv'))
    .filter((item): item is RecommendItem => item !== undefined);
}

interface WeeklyRaw {
  id?: unknown;
  title?: unknown;
  rating?: unknown;
  cover?: unknown;
  cover_proxy?: unknown;
}

/** 豆瓣周榜条目：原生图床优先，镜像仅兜底；缺封面直接丢弃 */
function weeklyToItem(raw: WeeklyRaw, isTv: boolean, listId: HotListId): RecommendItem | undefined {
  const id = raw.id === undefined || raw.id === null ? '' : String(raw.id);
  const title = text(raw.title);
  const cover = text(raw.cover) ?? text(raw.cover_proxy);
  if (!id || !title || !cover) return undefined;
  return {
    id,
    title,
    cover,
    rating: ratingText(raw.rating),
    isTv,
    source: 'hot-list',
    listId,
  };
}

function baiduToItem(raw: { title?: unknown; cover?: unknown }, index: number): RecommendItem | undefined {
  const title = text(raw.title);
  const cover = text(raw.cover);
  if (!title || !cover) return undefined;
  return {
    // 百度榜没有稳定 id，用榜单内序号保证 key 唯一
    id: `baidu_${index}`,
    title,
    cover,
    isTv: true,
    source: 'hot-list',
    listId: 'baidu_teleplay',
  };
}

/**
 * 60s API 响应 → 统一条目。
 * 豆瓣周榜按 `data[]` 解析；百度热播剧同样取 `data[]`，但只有标题与海报。
 */
export function parseHotList(raw: unknown, listId: HotListId): RecommendItem[] {
  const data =
    raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
      ? ((raw as { data: unknown[] }).data)
      : [];
  const list = hotListSource(listId);
  if (listId === 'baidu_teleplay') {
    return data
      .map((entry, index) => baiduToItem(entry as { title?: unknown; cover?: unknown }, index))
      .filter((item): item is RecommendItem => item !== undefined);
  }
  return data
    .map((entry) => weeklyToItem(entry as WeeklyRaw, list.isTv, listId))
    .filter((item): item is RecommendItem => item !== undefined);
}

/** 推荐内容同样要过成人过滤，避免首页出现搜索里已经被屏蔽的内容 */
export function filterAdultRecommendItems(items: RecommendItem[], enabled: boolean): RecommendItem[] {
  if (!enabled) return items;
  return items.filter((item) => !isAdultContent(undefined, item.title));
}
