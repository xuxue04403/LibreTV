/**
 * 覆盖度互补性分析：判断多个点播源到底是「真的各有各的片」还是「同一份库不同域名」。
 *
 * 只看单源可播没有意义——社区里大量采集站是同一套片库换域名转卖，
 * 内置五个这样的源，用户看到的是五个搜索结果、五个一样的列表，还一起挂。
 *
 * 做法：拿一组「新旧/冷热/国别」跨度大的片名，对每个源搜一遍，得到「源 × 片名」矩阵；
 * 再算每对源的重合率（Jaccard），重合高的只保留一个。
 *
 * 用法：npx vite-node tools/audit/source-coverage.ts -- --file x.json [--concurrency 6]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createFetchHttp } from '../../packages/core/src/http';
import { searchSources } from '../../packages/core/src/search';
import type { SourceConfig } from '../../packages/core/src/types';

const http = createFetchHttp();

/** 刻意混入：热门新剧、老经典、冷门片、纪录片、动画、韩剧、日剧、粤语片 */
const TITLES = [
  '庆余年',
  '流浪地球',
  '狂飙',
  '繁花',
  '三体',
  '漫长的季节',
  '肖申克的救赎',
  '星际穿越',
  '霸王别姬',
  '大明王朝1566',
  '走向共和',
  '请回答1988',
  '进击的巨人',
  '鬼灭之刃',
  '海贼王',
  '怪物猎人',
  '舌尖上的中国',
  '人生一串',
  '无间道',
  '让子弹飞',
  '我的阿勒泰',
  '唐朝诡事录',
  '甄嬛传',
  '亮剑',
];

interface Row {
  name: string;
  url: string;
  hits: Record<string, number>;
  ms: number;
  failures: number;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const atFile = args.indexOf('--file');
  const file = atFile >= 0 ? args[atFile + 1] : 'defaults/sources.json';
  const atConc = args.indexOf('--concurrency');
  const concurrency = atConc >= 0 ? Number(args[atConc + 1]) : 6;
  const atOut = args.indexOf('--out');
  const outFile = atOut >= 0 ? args[atOut + 1] : '.tmp-upstream/coverage.json';

  // 清单既可能是裸数组，也可能是 {sources:[...]} 的完整 defaults 结构
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as
    | { name: string; url: string }[]
    | { sources: { name: string; url: string }[] };
  const raw = Array.isArray(parsed) ? parsed : parsed.sources;
  const sources: SourceConfig[] = raw.map((s, i) => ({ key: `c${i}`, name: s.name, url: s.url }));

  const rows = await pool(sources, concurrency, async (source) => {
    const row: Row = { name: source.name, url: source.url, hits: {}, ms: 0, failures: 0 };
    for (const wd of TITLES) {
      try {
        const res = await searchSources({ wd, sources: [source], http, maxPages: 1, timeoutMs: 12_000 });
        if (res.failures.length > 0) {
          row.failures += 1;
          row.hits[wd] = -1;
          continue;
        }
        row.hits[wd] = res.list.length;
        row.ms += res.outcomes[0]?.ms ?? 0;
      } catch {
        row.failures += 1;
        row.hits[wd] = -1;
      }
    }
    const covered = TITLES.filter((t) => (row.hits[t] ?? 0) > 0).length;
    console.log(
      `${row.failures > TITLES.length / 3 ? '✗' : '✓'} ${row.name.padEnd(12)} 覆盖 ${String(covered).padStart(
        2
      )}/${TITLES.length}  失败 ${row.failures}  平均 ${Math.round(row.ms / Math.max(1, TITLES.length - row.failures))}ms`
    );
    return row;
  });

  // —— 两两重合度：同一片名双方都有 ≥1 条即算重合 ——
  console.log('\n=========== 两两重合率（Jaccard，越低越互补） ===========');
  const pairs: { a: string; b: string; j: number }[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      let both = 0;
      let either = 0;
      for (const t of TITLES) {
        const a = (rows[i].hits[t] ?? 0) > 0;
        const b = (rows[j].hits[t] ?? 0) > 0;
        if (a && b) both += 1;
        if (a || b) either += 1;
      }
      pairs.push({ a: rows[i].name, b: rows[j].name, j: either === 0 ? 1 : both / either });
    }
  }
  pairs.sort((x, y) => y.j - x.j);
  for (const p of pairs.slice(0, 15)) {
    console.log(`  ${(p.j * 100).toFixed(0).padStart(3)}%  ${p.a} ↔ ${p.b}`);
  }

  // —— 贪心挑选：在已选集合上每次挑新增覆盖最多的源 ——
  console.log('\n=========== 贪心选源（目标是覆盖并集最大） ===========');
  const remaining = new Set(rows.map((_, i) => i));
  const chosen: number[] = [];
  const coveredSet = new Set<string>();
  while (remaining.size > 0 && chosen.length < 12) {
    let best = -1;
    let bestGain = 0;
    for (const idx of remaining) {
      const gain = TITLES.filter((t) => (rows[idx].hits[t] ?? 0) > 0 && !coveredSet.has(t)).length;
      if (gain > bestGain) {
        bestGain = gain;
        best = idx;
      }
    }
    // 已经不能再带来新覆盖就停（剩下的都是同质源）
    if (best < 0 || bestGain === 0) break;
    remaining.delete(best);
    chosen.push(best);
    for (const t of TITLES) if ((rows[best].hits[t] ?? 0) > 0) coveredSet.add(t);
    console.log(`  +${String(bestGain).padStart(2)}  ${rows[best].name}  （累计覆盖 ${coveredSet.size}/${TITLES.length}）`);
  }

  writeFileSync(outFile, JSON.stringify({ titles: TITLES, rows, pairs }, null, 2));
  console.log(`\n结果已写入 ${outFile}`);
}

void main();
