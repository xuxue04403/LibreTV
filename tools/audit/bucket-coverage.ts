/**
 * 8 个内置源（4 旧 + 4 新）的分类桶覆盖实测：
 * 每个源分别看 8 个首页分类能否对上 type_id，以及实际能拉到多少条。
 *
 * 用法：npx vite-node tools/audit/bucket-coverage.ts
 */

import { browseCategory, fetchSourceCategories, HOME_CATEGORY_ORDER, categoryLabel, matchTypeIds } from '../../packages/core/src/categories';
import { clearCategoryCache, setCachedCategories } from '../../packages/core/src/categories';
import { createFetchHttp } from '../../packages/core/src/http';
import type { SourceConfig } from '../../packages/core/src/types';

const http = createFetchHttp();

const SOURCES: SourceConfig[] = [
  { key: 'b0', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'b1', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'b2', name: '魔都资源', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: 'b3', name: '360 资源', url: 'https://www.360zy.com/api.php/provide/vod' },
  { key: 'b4', name: '电影天堂', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod' },
  { key: 'b5', name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod' },
  { key: 'b6', name: '红牛资源', url: 'https://www.hongniuzy2.com/api.php/provide/vod' },
  { key: 'b7', name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod' },
];

async function main() {
  clearCategoryCache();
  const cats = new Map<string, Awaited<ReturnType<typeof fetchSourceCategories>>>();

  for (const source of SOURCES) {
    try {
      const list = await fetchSourceCategories(source, http, { timeoutMs: 15_000 });
      cats.set(source.url, list);
      setCachedCategories(source.url, list);
    } catch (err) {
      console.log(`${source.name} 分类表失败：${err instanceof Error ? err.message : err}`);
    }
  }

  console.log('\n每源每分类命中的 type_id 数：');
  for (const source of SOURCES) {
    const list = cats.get(source.url);
    if (!list) continue;
    const row = HOME_CATEGORY_ORDER.map((key) => {
      const ids = matchTypeIds(list, key, 4);
      return `${categoryLabel(key)}:${ids.length}`;
    });
    console.log(`  ${source.name.padEnd(10)} ${row.join('  ')}`);
  }

  console.log('\n实际抓取（每分类每源 1 页）：');
  for (const key of HOME_CATEGORY_ORDER) {
    const started = Date.now();
    const result = await browseCategory({ sources: SOURCES, key, http, pages: 1, typeLimit: 2, timeoutMs: 15_000 });
    const perSource = result.outcomes
      .map((o) => `${o.sourceName}${o.ok ? (o.supported ? `:${o.count}` : ':无') : ':x'}`)
      .join(' ');
    console.log(
      `  ${categoryLabel(key).padEnd(4)} 共 ${String(result.items.length).padStart(4)} 条  ${Date.now() - started}ms  ${perSource}`
    );
  }
}

void main();
