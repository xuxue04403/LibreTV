/**
 * 单独看一个点播源的 m3u8 与分片实况（排查为什么「列表 ok 但分片失败」）。
 *
 * 用法：npx vite-node tools/audit/source-m3u8.ts "非凡资源" [关键词]
 */

import { fetchDetail } from '../../packages/core/src/detail';
import { createFetchHttp } from '../../packages/core/src/http';
import { searchSources } from '../../packages/core/src/search';
import type { SourceConfig } from '../../packages/core/src/types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const ALL: SourceConfig[] = [
  { key: 'k0', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'k1', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'k2', name: '电影天堂', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod' },
];

const http = createFetchHttp();

async function main() {
  const wanted = process.argv[2] ?? '非凡资源';
  const wd = process.argv[3] ?? '庆余年';
  const source = ALL.find((s) => s.name === wanted);
  if (!source) throw new Error(`没有这个源：${wanted}`);

  const search = await searchSources({ wd, sources: [source], http, maxPages: 1, timeoutMs: 15_000 });
  const item = search.list[0];
  if (!item) throw new Error('搜索无结果');
  console.log(`搜索命中：${item.name} vodId=${item.vodId}`);

  const detail = await fetchDetail(source, item.vodId, http, { timeoutMs: 15_000 });
  const first = detail.episodes.find((u) => /\.m3u8/i.test(u)) ?? detail.episodes[0];
  console.log(`分集 ${detail.episodes.length}，首个：${first}`);

  const pl = await http.request(first, { timeoutMs: 12_000, headers: { 'User-Agent': UA } });
  console.log(`列表 HTTP ${pl.status}，${pl.bytes.byteLength}B，content-type=${pl.headers['content-type']}`);
  console.log(pl.text.slice(0, 600));

  const lines = pl.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  console.log(`\n分片 ${lines.length} 条，逐个试前 3 个与最后 1 个：`);
  for (const idx of [0, 1, 2, lines.length - 1]) {
    const seg = lines[idx];
    if (!seg) continue;
    const abs = new URL(seg, first).toString();
    const started = Date.now();
    try {
      const res = await http.request(abs, { timeoutMs: 15_000, headers: { 'User-Agent': UA } });
      console.log(
        `  [${idx}] HTTP ${res.status} ${res.bytes.byteLength}B ${Date.now() - started}ms ${res.headers['content-type'] ?? ''} ${abs.slice(0, 110)}`
      );
    } catch (err) {
      console.log(`  [${idx}] 失败 ${(err as Error).message} ${abs.slice(0, 110)}`);
    }
  }
}

void main();
