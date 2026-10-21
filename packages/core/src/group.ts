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
