/**
 * 识别「同源镜像」：不同采集接口如果指向同一套播放 CDN，内置多个毫无意义
 * （用户切源只是换了个域名，片子还是同一份，一起挂）。
 *
 * 做法：对每个源取同一关键词的首条结果，打印 m3u8 的 host 与路径，
 * 路径相同即同一份存储。
 *
 * 用法：npx vite-node tools/audit/source-dedupe.ts -- --file .tmp-upstream/candidates-clean.json [--wd 庆余年]
 */

import { readFileSync } from 'node:fs';
import { fetchDetail } from '../../packages/core/src/detail';
import { createFetchHttp } from '../../packages/core/src/http';
import { searchSources } from '../../packages/core/src/search';
import type { SourceConfig } from '../../packages/core/src/types';

const http = createFetchHttp();

async function main() {
  const args = process.argv.slice(2);
  const atFile = args.indexOf('--file');
  const file = atFile >= 0 ? args[atFile + 1] : 'defaults/sources.json';
  const atWd = args.indexOf('--wd');
  const wd = atWd >= 0 ? args[atWd + 1] : '庆余年';

  const raw = JSON.parse(readFileSync(file, 'utf8')) as { name: string; url: string }[];
  const sources: SourceConfig[] = raw.map((s, i) => ({ key: `k${i}`, name: s.name, url: s.url }));

  const rows: { name: string; api: string; vodName: string; m3u8: string; path: string }[] = [];

  for (const source of sources) {
    try {
      const res = await searchSources({ wd, sources: [source], http, maxPages: 1, timeoutMs: 12_000 });
      const item = res.list[0];
      if (!item) {
        console.log(`-- ${source.name.padEnd(14)} 无结果`);
        continue;
      }
      const detail = await fetchDetail(source, item.vodId, http, { timeoutMs: 12_000 });
      const episode = detail.episodes.find((u) => /\.m3u8/i.test(u)) ?? detail.episodes[0] ?? '';
      // 只留「/日期/集号_哈希/index.m3u8」这种与站点无关的部分，去掉协议与域名
      let path = episode;
      try {
        const u = new URL(episode);
        path = u.pathname.replace(/^\/+/, '');
      } catch {
        /* 留空 */
      }
      rows.push({ name: source.name, api: new URL(source.url).hostname, vodName: item.name, m3u8: episode, path });
      console.log(`✓✓ ${source.name.padEnd(14)} 《${item.name}》 ${episode.slice(0, 100)}`);
    } catch (err) {
      console.log(`✗✗ ${source.name.padEnd(14)} ${(err as Error).message.slice(0, 50)}`);
    }
  }

  // 按 path 归组：同一 path 前缀（前两段）视为同一存储
  console.log('\n=========== 同源归组（按 m3u8 路径前两段） ===========');
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.path.split('/').slice(0, 2).join('/');
    const arr = groups.get(key) ?? [];
    arr.push(`${row.name}(${row.api})`);
    groups.set(key, arr);
  }
  for (const [key, members] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${String(members.length).padStart(2)}× ${key}  ← ${members.join(' , ')}`);
  }
}

void main();
