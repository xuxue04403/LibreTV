/**
 * 入选源的最终体检：分类表（含成人分类识别）、搜索相关性、分页、并发压力。
 *
 * 用法：npx vite-node tools/audit/source-final.ts
 */

import { classifyCategoryName, fetchSourceCategories } from '../../packages/core/src/categories';
import { cmsRequestHeaders, parseSearchList, isAdultContent } from '../../packages/core/src/cms';
import { createFetchHttp } from '../../packages/core/src/http';
import type { SourceConfig } from '../../packages/core/src/types';

const http = createFetchHttp();

const SOURCES: SourceConfig[] = [
  { key: 'k1', name: '电影天堂', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod' },
  { key: 'k2', name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod' },
  { key: 'k3', name: '百度资源', url: 'https://api.apibdzy.com/api.php/provide/vod' },
  { key: 'k4', name: '红牛资源', url: 'https://www.hongniuzy2.com/api.php/provide/vod' },
  { key: 'k5', name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod' },
];

async function main() {
  for (const source of SOURCES) {
    console.log(`\n══ ${source.name}  ${source.url}`);

    // 1. 分类表
    try {
      const cats = await fetchSourceCategories(source, http, { timeoutMs: 15_000 });
      const buckets = new Map<string, string[]>();
      let adult = 0;
      for (const c of cats) {
        const key = classifyCategoryName(c.name);
        if (key === 'other') continue;
        const arr = buckets.get(key) ?? [];
        arr.push(c.name);
        buckets.set(key, arr);
        if (isAdultContent(c.name)) adult += 1;
      }
      console.log(`  分类 ${cats.length} 个，成人分类 ${adult} 个`);
      for (const [bucket, names] of [...buckets.entries()].sort()) {
        console.log(`    ${bucket.padEnd(8)} ${names.slice(0, 8).join('/')}${names.length > 8 ? ` …共${names.length}` : ''}`);
      }
      const unmapped = cats.filter((c) => classifyCategoryName(c.name) === 'other').map((c) => c.name);
      if (unmapped.length) console.log(`    未归类    ${unmapped.slice(0, 12).join('/')}${unmapped.length > 12 ? ` …共${unmapped.length}` : ''}`);
    } catch (err) {
      console.log(`  分类失败：${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. 搜索相关性 + 分页
    for (const wd of ['庆余年', '沙丘']) {
      const started = Date.now();
      try {
        const res = await http.request(`${source.url}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=1`, {
          timeoutMs: 15_000,
          headers: cmsRequestHeaders(),
        });
        const data = JSON.parse(res.text) as { pagecount?: unknown; total?: unknown };
        const items = parseSearchList(data, source);
        const ms = Date.now() - started;
        const adultHit = items.filter((it) => isAdultContent(it.typeName, it.name, it.isAdult)).length;
        console.log(
          `  「${wd}」 ${ms}ms  pagecount=${String(data.pagecount)} total=${String(data.total)}  解析 ${items.length} 条，成人 ${adultHit}  样本：${items.slice(0, 3).map((i) => i.name).join(' / ')}`
        );
      } catch (err) {
        console.log(`  「${wd}」失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 3. 并发压力：5 源同时搜同一词
  console.log('\n══ 5 源并发搜索（模拟真实使用）');
  const started = Date.now();
  const results = await Promise.all(
    SOURCES.map(async (source) => {
      const t = Date.now();
      try {
        const res = await http.request(`${source.url}?ac=videolist&wd=${encodeURIComponent('流浪地球')}&pg=1`, {
          timeoutMs: 15_000,
          headers: cmsRequestHeaders(),
        });
        const items = parseSearchList(JSON.parse(res.text), source);
        return { name: source.name, ok: true, count: items.length, ms: Date.now() - t };
      } catch {
        return { name: source.name, ok: false, count: 0, ms: Date.now() - t };
      }
    })
  );
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(8)} ${String(r.ms).padStart(5)}ms  ${r.count} 条`);
  console.log(`  总耗时 ${Date.now() - started}ms`);
}

void main();
