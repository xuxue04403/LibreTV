/**
 * 批量体检候选点播源：只跑「搜索 → 详情 → 首集分片」三层，先筛掉明显挂掉的，
 * 通过者再用 source-health.ts 做完整体检（含分类表与末集）。
 *
 * 用法：npx vite-node tools/audit/candidate-batch.ts -- --file .tmp-upstream/candidates.json [--concurrency 6]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fetchDetail } from '../../packages/core/src/detail';
import { createFetchHttp } from '../../packages/core/src/http';
import { searchSources } from '../../packages/core/src/search';
import type { HttpClient } from '../../packages/core/src/http';
import type { SourceConfig } from '../../packages/core/src/types';
import { probeHls } from './hls';

const http: HttpClient = createFetchHttp();

export interface CandidateReport {
  name: string;
  url: string;
  hits: number;
  searchMs: number;
  detailOk: boolean;
  episodes: number;
  segmentOk: boolean;
  bytes: number;
  stage: 'search' | 'detail' | 'playlist' | 'segment' | 'ok';
  note: string;
}

export async function checkCandidate(source: SourceConfig): Promise<CandidateReport> {
  const r: CandidateReport = {
    name: source.name,
    url: source.url,
    hits: 0,
    searchMs: 0,
    detailOk: false,
    episodes: 0,
    segmentOk: false,
    bytes: 0,
    stage: 'search',
    note: '',
  };

  let item: { vodId: string } | undefined;
  try {
    // 单关键词就够：这一步只是筛「采集接口活着且能搜到东西」
    const res = await searchSources({ wd: '庆余年', sources: [source], http, maxPages: 1, timeoutMs: 12_000 });
    if (res.failures[0]) {
      r.note = `搜索失败 ${res.failures[0].error}`;
      return r;
    }
    r.searchMs = res.outcomes[0]?.ms ?? 0;
    r.hits = res.list.length;
    item = res.list[0] ? { vodId: res.list[0].vodId } : undefined;
  } catch (err) {
    r.note = `搜索异常 ${msg(err)}`;
    return r;
  }
  if (!item) {
    r.note = '搜索无结果';
    return r;
  }

  let episodes: string[];
  try {
    const detail = await fetchDetail(source, item.vodId, http, { timeoutMs: 12_000 });
    r.detailOk = true;
    episodes = detail.episodes;
    r.episodes = episodes.length;
  } catch (err) {
    r.stage = 'detail';
    r.note = `详情失败 ${msg(err)}`;
    return r;
  }

  const head = episodes.find((u) => /\.m3u8(\?|$)/i.test(u)) ?? episodes.find((u) => /^https?:\/\//i.test(u));
  if (!head) {
    r.stage = 'detail';
    r.note = '无播放地址';
    return r;
  }

  const hls = await probeHls(http, head);
  r.segmentOk = hls.ok;
  r.bytes = hls.bytes;
  r.note = hls.note;
  r.stage = hls.ok ? 'ok' : hls.segments > 0 ? 'segment' : 'playlist';
  return r;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 60) : String(err).slice(0, 60);
}

function load(file: string): SourceConfig[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { name: string; url: string }[];
  return raw.map((s, i) => ({ key: `cand_${i}`, name: s.name || `候选${i}`, url: s.url }));
}

/** 有上限的并发池，避免一次性打爆本机连接或触发对端限流 */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const atFile = args.indexOf('--file');
  const file = atFile >= 0 ? args[atFile + 1] : '.tmp-upstream/candidates.json';
  const atConc = args.indexOf('--concurrency');
  const concurrency = atConc >= 0 ? Number(args[atConc + 1]) : 6;
  const atOut = args.indexOf('--out');
  const outFile = atOut >= 0 ? args[atOut + 1] : '.tmp-upstream/candidates-report.json';

  const sources = load(file);
  console.log(`体检 ${sources.length} 个候选源（并发 ${concurrency}）\n`);

  const reports = await pool(sources, concurrency, async (source) => {
    const r = await checkCandidate(source);
    console.log(
      `${r.stage === 'ok' ? '✓✓' : '✗✗'} ${r.name.padEnd(14)} 搜${String(r.hits).padStart(3)}条/${String(
        r.searchMs
      ).padStart(5)}ms 分集${String(r.episodes).padStart(3)} 分片${r.segmentOk ? `${r.bytes}B` : '--'} ${r.note}`
    );
    return r;
  });

  writeFileSync(outFile, JSON.stringify(reports, null, 2));
  const ok = reports.filter((r) => r.stage === 'ok');
  console.log(`\n可用 ${ok.length}/${reports.length}，结果已写入 ${outFile}`);
  for (const r of ok) console.log(`  ✓ ${r.name}  ${r.url}  (${r.hits}条/${r.bytes}B)`);
}

if (import.meta.url.replace(/\\/g, '/').endsWith('candidate-batch.ts')) void main();
