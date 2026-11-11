/**
 * 标题归一化、相关性过滤、跨源同名聚合与排序。
 *
 * 移植自 packages/core/src/cms.ts（normalizeTitle / isRelevant /
 * filterRelevantResults）与 group.ts（groupSearchResults / rankSearchGroups）。
 *
 * 这几步是搜索体验的关键：采集站的搜索经常把「相关但不精确」的结果排在前面，
 * 甚至拿站点目录凑数。不做过滤的话，用户搜《庆余年》会看到一屏别的片子；
 * 不做排序的话，跨源合并后顺序基本是随机的（谁先回来谁在前）。
 */
import { SearchGroup, SearchItem } from '../model/Types';

/** 去掉空白、标点、符号，并转小写；CCTV-5 与 CCTV5 归一后相同 */
export function normalizeTitle(s: string): string {
  return (s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

interface SeasonSuffix {
  base: string;
  season: number;
  explicit: boolean;
}

/** 独立数字或「第 N 季」后缀 → 季数 */
function parseSeasonSuffix(title: string, allowAnnotations: boolean, bareNeedsSpace: boolean): SeasonSuffix | undefined {
  const explicitPattern = allowAnnotations
    ? new RegExp('^(.*?)\\s*第\\s*([1-9]\\d?|[一二两三四五六七八九十]{1,3})\\s*季.*$', 'u')
    : new RegExp('^(.*?)\\s*第\\s*([1-9]\\d?|[一二两三四五六七八九十]{1,3})\\s*季$', 'u');
  const explicit = title.trim().match(explicitPattern);
  const bare = title.trim().match(bareNeedsSpace ? new RegExp('^(.*?)\\s+([1-9]\\d?)$', 'u')
    : new RegExp('^(.*?)\\s*([1-9]\\d?)$', 'u'));
  const match = explicit !== null ? explicit : bare;
  if (match === null || normalizeTitle(match[1]).length === 0) {
    return undefined;
  }
  const value = match[2];
  const digits = '零一二三四五六七八九';
  let season = Number(value);
  if (!Number.isFinite(season)) {
    const chinese = value.replace('两', '二');
    if (new RegExp('^[一二三四五六七八九]$', 'u').test(chinese)) {
      season = digits.indexOf(chinese);
    } else if (new RegExp('^[一二三四五六七八九]?十[一二三四五六七八九]?$', 'u').test(chinese)) {
      const parts = chinese.split('十');
      const tens = parts.length > 1 ? parts[0] : '';
      const units = parts.length > 1 ? parts[1] : '';
      season = (tens.length > 0 ? digits.indexOf(tens) : 1) * 10 + (units.length > 0 ? digits.indexOf(units) : 0);
    }
  }
  if (!Number.isFinite(season)) {
    return undefined;
  }
  return { base: match[1], season: season, explicit: explicit !== null };
}

/** 数字必须完整命中，避免「第 2 季」误匹配 12 或 20 */
function includesKeyword(title: string, keyword: string): boolean {
  if (title.length === 0 || keyword.length === 0) {
    return false;
  }
  let index = title.indexOf(keyword);
  while (index >= 0) {
    const before = index > 0 ? title[index - 1] : '';
    const after = title.charAt(index + keyword.length);
    const digitKeywordStart = new RegExp('^\\d').test(keyword);
    const digitKeywordEnd = new RegExp('\\d$').test(keyword);
    const digitBefore = new RegExp('\\d').test(before);
    const digitAfter = new RegExp('\\d').test(after);
    if ((!digitKeywordStart || !digitBefore) && (!digitKeywordEnd || !digitAfter)) {
      return true;
    }
    index = title.indexOf(keyword, index + 1);
  }
  return false;
}

interface PreparedQuery {
  normalized: string;
  season?: SeasonSuffix;
  tokens: string[];
}

function prepareQuery(wd: string): PreparedQuery | undefined {
  const normalized = normalizeTitle(wd);
  if (normalized.length === 0) {
    return undefined;
  }
  const rawTokens = wd.trim().split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const t = normalizeTitle(rawTokens[i]);
    if (t.length > 0) {
      tokens.push(t);
    }
  }
  return { normalized: normalized, season: parseSeasonSuffix(wd, false, false), tokens: tokens };
}

function matchesPrepared(nName: string, query: PreparedQuery): boolean {
  if (includesKeyword(nName, query.normalized)) {
    return true;
  }
  if (query.tokens.length > 1) {
    for (let i = 0; i < query.tokens.length; i++) {
      if (!includesKeyword(nName, query.tokens[i])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function isRelevantPrepared(name: string, query: PreparedQuery): boolean {
  const nName = normalizeTitle(name);
  if (nName.length === 0) {
    return false;
  }
  const titleSeason = parseSeasonSuffix(name, true, true);
  const qSeason = query.season;
  if (qSeason !== undefined && titleSeason !== undefined) {
    if (qSeason.season !== titleSeason.season) {
      return false;
    }
    if (qSeason.explicit || titleSeason.explicit) {
      const baseQuery = prepareQuery(qSeason.base);
      if (baseQuery !== undefined) {
        return matchesPrepared(normalizeTitle(titleSeason.base), baseQuery);
      }
    }
  }
  return matchesPrepared(nName, query);
}

/** 判一条标题是否与关键词相关 */
export function isRelevant(name: string, wd: string): boolean {
  const query = prepareQuery(wd);
  if (query === undefined) {
    return true;
  }
  return isRelevantPrepared(name, query);
}

/** 丢弃无关结果；即使全部不相关，也不能把源站的原始目录当成搜索结果 */
export function filterRelevantItems(items: SearchItem[], wd: string): SearchItem[] {
  const query = prepareQuery(wd);
  if (query === undefined) {
    return items;
  }
  const out: SearchItem[] = [];
  for (let i = 0; i < items.length; i++) {
    if (isRelevantPrepared(items[i].name ?? '', query)) {
      out.push(items[i]);
    }
  }
  return out;
}

/** 同一源同一 vodId 只留一条（分页重复时会出现） */
export function dedupeItems(items: SearchItem[]): SearchItem[] {
  const seen = new Set<string>();
  const out: SearchItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const id = `${items[i].sourceKey}:${items[i].vodId}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(items[i]);
  }
  return out;
}

/** 分组键：标题 + 年份，避免「同名不同年」被强行合并 */
function groupKeyOf(item: SearchItem): string {
  const title = normalizeTitle(item.name ?? '');
  const year = (item.year ?? '').trim();
  return year.length > 0 ? `${title}#${year}` : title;
}

/**
 * 按同名聚合；组内按源名排序（让用户先看到常用的源），
 * 组间保持首条出现顺序，随后由 rankGroups 重排。
 */
export function groupSearchResults(items: SearchItem[]): SearchGroup[] {
  const map = new Map<string, SearchGroup>();
  const order: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = groupKeyOf(item);
    if (key.length === 0) {
      continue;
    }
    const existing = map.get(key);
    if (existing !== undefined) {
      existing.items.push(item);
    } else {
      map.set(key, { name: item.name, items: [item] });
      order.push(key);
    }
  }
  const groups: SearchGroup[] = [];
  for (let i = 0; i < order.length; i++) {
    const g = map.get(order[i]);
    if (g === undefined) {
      continue;
    }
    g.items.sort((a, b) => a.sourceName < b.sourceName ? -1 : (a.sourceName > b.sourceName ? 1 : 0));
    groups.push(g);
  }
  return groups;
}

/** 匹配强度：精确 > 前缀 > 靠前包含 > 靠后包含 > 分词命中 */
function titleMatchTier(name: string, wd: string): number {
  const query = normalizeTitle(wd);
  const title = normalizeTitle(name);
  if (query.length === 0 || title.length === 0) {
    return 0;
  }
  if (title === query) {
    return 100;
  }
  if (title.startsWith(query)) {
    return 70;
  }
  const index = title.indexOf(query);
  if (index >= 0) {
    return 50 - Math.min(index, 20);
  }
  const rawTokens = wd.trim().split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const t = normalizeTitle(rawTokens[i]);
    if (t.length > 0) {
      tokens.push(t);
    }
  }
  if (tokens.length > 1) {
    for (let i = 0; i < tokens.length; i++) {
      if (title.indexOf(tokens[i]) < 0) {
        return 0;
      }
    }
    return 25;
  }
  return 0;
}

function groupScore(group: SearchGroup, wd: string): number {
  return titleMatchTier(group.name, wd) + Math.min(group.items.length, 6) * 3;
}

/** 按相关性重排：精确命中优先，同分时源多的优先，再按标题长度与中文排序兜底 */
export function rankGroups(groups: SearchGroup[], wd: string): SearchGroup[] {
  const arr = groups.slice();
  arr.sort((a, b) => {
    const diff = groupScore(b, wd) - groupScore(a, wd);
    if (diff !== 0) {
      return diff;
    }
    if (a.name.length !== b.name.length) {
      return a.name.length - b.name.length;
    }
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return arr;
}
