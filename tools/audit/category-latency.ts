/**
 * 分类加载耗时分解 —— 找出「还是慢」的真正瓶颈。
 *
 * 关注三件事：
 *   1. 每个源各自花了多久（是不是某一两个慢源拖住了整体）
 *   2. `?ac=list` 分类表 vs 子分类列表各占多少
 *   3. 整体是 max(源) 还是 sum(页)
 */
import { createFetchHttp, browseCategory, DEFAULT_SOURCES as _unused } from '@libretv/core';
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(new URL('../../defaults/sources.json', import.meta.url), 'utf8'));
const sources = raw.sources.map((s: { key: string; name: string; url: string }) => ({
  key: s.key,
  name: s.name,
  url: s.url,
}));

const http = createFetchHttp();

function now() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

async function main() {
  console.log('源：', sources.map((s: { name: string }) => s.name).join(' / '));

  // 先跑一次「冷」分类浏览（分类表都还没缓存）
  const t0 = now();
  const first = await browseCategory({
    sources,
    key: 'movie',
    http,
    pages: 1,
    timeoutMs: 12_000,
  });
  const cold = now() - t0;
  console.log(`\n[冷] movie 总耗时 ${cold.toFixed(0)}ms，${first.items.length} 部`);
  for (const o of first.outcomes) {
    console.log(`  ${o.sourceName}: ${o.ms}ms ok=${o.ok} supported=${o.supported} count=${o.count} ${o.error ?? ''}`);
  }
  console.log(`  各源耗时: max=${Math.max(...first.outcomes.map((o) => o.ms))}ms sum=${first.outcomes.reduce((a, o) => a + o.ms, 0)}ms`);

  // 再跑一次同样的分类（内存缓存 5 分钟）
  const t1 = now();
  const second = await browseCategory({ sources, key: 'movie', http, pages: 1, timeoutMs: 12_000 });
  console.log(`\n[热·同分类] ${(now() - t1).toFixed(0)}ms，${second.items.length} 部`);

  // 换一个分类：分类表应该命中缓存，只剩子分类列表请求
  const t2 = now();
  const tv = await browseCategory({ sources, key: 'tv', http, pages: 1, timeoutMs: 12_000 });
  const tvMs = now() - t2;
  console.log(`\n[换分类] tv ${tvMs.toFixed(0)}ms，${tv.items.length} 部`);
  for (const o of tv.outcomes) {
    console.log(`  ${o.sourceName}: ${o.ms}ms ok=${o.ok} supported=${o.supported} count=${o.count} ${o.error ?? ''}`);
  }

  // typeLimit 的影响：只看 2 个子分类 vs 6 个
  const t3 = now();
  const few = await browseCategory({ sources, key: 'anime', http, pages: 1, typeLimit: 2, timeoutMs: 12_000 });
  console.log(`\n[typeLimit=2] anime ${(now() - t3).toFixed(0)}ms，${few.items.length} 部`);
  for (const o of few.outcomes) {
    console.log(`  ${o.sourceName}: ${o.ms}ms count=${o.count}`);
  }
}

void main();
