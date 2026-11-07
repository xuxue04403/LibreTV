/**
 * 同名影片跨源聚合：把多个采集站返回的同名结果合并成一张卡片。
 * 与上游首页/搜索页的分组展示语义一致（上游在页面层实现，这里抽为纯函数）。
 */

import { normalizeTitle } from './cms';
import type { AggregatedGroup, SearchResultItem } from './types';

/**
 * 分组键：优先用标题 + 年份，避免「同名不同年」被强行合并。
 * 年份缺失时只用标题（宁可多合并，也不要漏掉跨源同片）。
 */
export function groupKeyOf(item: SearchResultItem): string {
  const title = normalizeTitle(item.name || '');
  const year = (item.year || '').trim();
  return year ? `${title}#${year}` : title;
}

/** 按分组键聚合，组内按源名排序，组间按首条出现顺序（大致对应源健康度） */
export function groupSearchResults(items: SearchResultItem[]): AggregatedGroup[] {
  const map = new Map<string, AggregatedGroup>();
  for (const item of items) {
    const key = groupKeyOf(item);
    if (!key) continue;
    const existing = map.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      map.set(key, { key, name: item.name, items: [item] });
    }
  }
  const groups = [...map.values()];
  for (const group of groups) {
    group.items.sort((a, b) => a.sourceName.localeCompare(b.sourceName, 'zh-CN'));
  }
  return groups;
}

/** 组内去重：同一源同一 vodId 只保留一条（分页重复时可能出现） */
export function dedupeResults(items: SearchResultItem[]): SearchResultItem[] {
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

/**
 * 标题与关键词的匹配强度：精确 > 前缀 > 靠前包含 > 靠后包含 > 分词命中。
 *
 * 采集站的搜索经常把「相关但不精确」的结果排在最前（甚至拿站点目录凑数），
 * 跨源合并后又按「哪个源先回来」排列，用户看到的顺序基本是随机的。
 * 这里只负责排序，不负责过滤——过滤在 `filterRelevantResults`，两者要分开：
 * 过滤丢掉的是「不相关」，排序解决的是「都相关时谁先出现」。
 */
export function titleMatchTier(name: string, wd: string): number {
  const query = normalizeTitle(wd);
  const title = normalizeTitle(name);
  if (!query || !title) return 0;
  if (title === query) return 100;
  if (title.startsWith(query)) return 70;
  const index = title.indexOf(query);
  if (index >= 0) return 50 - Math.min(index, 20);
  const tokens = wd
    .trim()
    .split(/\s+/)
    .map(normalizeTitle)
    .filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => title.includes(token))) return 25;
  return 0;
}

/** 给一组聚合结果打分：匹配强度 + 跨源数量（同名片源越多，通常越可靠） */
export function groupRelevanceScore(group: AggregatedGroup, wd: string): number {
  return titleMatchTier(group.name, wd) + Math.min(group.items.length, 6) * 3;
}

/**
 * 按相关性重排聚合结果：精确命中优先，其次前缀、包含位置；同分时源多的优先，
 * 再按标题长度（越短越像片名）和中文排序兜底，保证顺序稳定可复现。
 */
export function rankSearchGroups(groups: AggregatedGroup[], wd: string): AggregatedGroup[] {
  return [...groups].sort((a, b) => {
    const diff = groupRelevanceScore(b, wd) - groupRelevanceScore(a, wd);
    if (diff !== 0) return diff;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

