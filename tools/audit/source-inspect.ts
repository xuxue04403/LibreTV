/**
 * 单源体检细看：把分类表、搜索结果、首集播放地址与分片情况全打出来，
 * 用于人工判断一个候选源是否值得内置（内容是否合法、是否重复、是否只有几条）。
 *
 * 用法：npx vite-node tools/audit/source-inspect.ts <url> [名称]
 */

import { classifyCategoryName, fetchSourceCategories } from '../../packages/core/src/categories';
import { createFetchHttp } from '../../packages/core/src/http';
import { searchSources } from '../../packages/core/src/search';
import type { SourceConfig } from '../../packages/core/src/types';

const http = createFetchHttp();

async function main() {
  const url = process.argv[2];
  const name = process.argv[3] ?? url;
  if (!url) throw new Error('需要传入采集接口地址');
  const source: SourceConfig = { key: 'probe', name, url };

  console.log(`=== ${name}  ${url} ===`);

  try {
    const cats = await fetchSourceCategories(source, http, { timeoutMs: 15_000 });
    const buckets: Record<string, number> = {};
    for (const c of cats) {
      const k = classifyCategoryName(c.name);
      buckets[k] = (buckets[k] ?? 0) + 1;
    }
    console.log(`分类 ${cats.length} 条：${JSON.stringify(buckets)}`);
    console.log(`  全部：${cats.map((c) => `${c.name}(${c.typeId})`).join(' / ')}`);
  } catch (err) {
    console.log(`分类失败：${(err as Error).message.slice(0, 60)}`);
  }

  for (const wd of ['庆余年', '流浪地球', '狂飙']) {
    try {
      const res = await searchSources({ wd, sources: [source], http, maxPages: 1, timeoutMs: 12_000 });
      const names = res.list.slice(0, 6).map((i) => `${i.name}${i.year ? `(${i.year})` : ''}`);
      console.log(`搜索「${wd}」：${res.list.length} 条 ${res.failures[0]?.error ?? ''} ${names.join(' | ')}`);
    } catch (err) {
      console.log(`搜索「${wd}」异常：${(err as Error).message.slice(0, 60)}`);
    }
  }
}

void main();
