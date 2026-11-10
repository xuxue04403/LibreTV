/**
 * 点播源健康体检：分类表 → 搜索 → 详情 → m3u8 列表 → 视频分片。
 *
 * 逐层判定，任何一层失败都记下是哪一层、为什么 —— 「能搜到但播不了」是最容易被
 * 误判成可用的状态，必须一路验到分片字节。
 *
 * 用法：
 *   npx vite-node tools/audit/source-health.ts                      # 体检 defaults/sources.json
 *   npx vite-node tools/audit/source-health.ts -- --file x.json      # 体检指定清单
 *   npx vite-node tools/audit/source-health.ts -- --file x.json --json out.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { classifyCategoryName, fetchSourceCategories } from '../../packages/core/src/categories';
import { fetchDetail } from '../../packages/core/src/detail';
import { createFetchHttp } from '../../packages/core/src/http';
import { searchSources } from '../../packages/core/src/search';
import type { HttpClient } from '../../packages/core/src/http';
import type { SourceConfig } from '../../packages/core/src/types';
import { probeHls } from './hls';

export interface SourceReport {
  name: string;
  url: string;
  /** 分类表条数（0 = 分类接口不可用，首页分类浏览会退化为搜索） */
  categories: number;
  buckets: Record<string, number>;
  /** 两个关键词的搜索命中总数 */
  searchHits: number;
  searchMs: number;
  detailOk: boolean;
  episodes: number;
  /** 首集与末集的分片探测结果 */
  playlistOk: boolean;
  variants: number;
  segments: number;
  segmentOk: boolean;
  segmentBytes: number;
  /** 末集分片是否也通（首集通不代表整剧可播） */
  tailOk: boolean;
  stage: 'search' | 'detail' | 'playlist' | 'segment' | 'ok';
  note: string;
}

const http: HttpClient = createFetchHttp();

/** 判断详情里的播放地址是不是能直接当 HLS 播的（排除网盘/magnet 之类） */
function pickPlayable(episodes: string[]): string | undefined {
  return episodes.find((u) => /\.m3u8(\?|$)/i.test(u)) ?? episodes.find((u) => /^https?:\/\//i.test(u));
}

export async function checkSource(source: SourceConfig): Promise<SourceReport> {
  const report: SourceReport = {
    name: source.name,
    url: source.url,
    categories: 0,
    buckets: {},
    searchHits: 0,
    searchMs: 0,
    detailOk: false,
    episodes: 0,
    playlistOk: false,
    variants: 0,
    segments: 0,
    segmentOk: false,
    segmentBytes: 0,
    tailOk: false,
    stage: 'search',
    note: '',
  };

  // 1. 分类
  try {
    const cats = await fetchSourceCategories(source, http, { timeoutMs: 15_000 });
    report.categories = cats.length;
    for (const c of cats) {
      const key = classifyCategoryName(c.name);
      if (key === 'other') continue;
      report.buckets[key] = (report.buckets[key] ?? 0) + 1;
    }
  } catch (err) {
    report.note = `分类失败：${errText(err)}`;
  }

  // 2. 搜索（用两个不同关键词，避开某站点只收录部分新剧的偶发情况）
  let item: { vodId: string; name: string } | undefined;
  for (const wd of ['庆余年', '流浪地球']) {
    try {
      const res = await searchSources({ wd, sources: [source], http, maxPages: 1, timeoutMs: 15_000 });
      const failure = res.failures[0];
      if (failure) {
        report.note = `搜索失败：${failure.error}`;
        continue;
      }
      report.searchMs = Math.max(report.searchMs, res.outcomes[0]?.ms ?? 0);
      report.searchHits += res.list.length;
      item ??= res.list[0] ? { vodId: res.list[0].vodId, name: res.list[0].name } : undefined;
    } catch (err) {
      report.note = `搜索异常：${errText(err)}`;
    }
  }
  if (!item) {
    report.stage = 'search';
    report.note ||= '搜索无结果';
    return report;
  }

  // 3. 详情
  let episodes: string[];
  try {
    const detail = await fetchDetail(source, item.vodId, http, { timeoutMs: 15_000 });
    report.detailOk = true;
    episodes = detail.episodes;
    report.episodes = episodes.length;
  } catch (err) {
    report.stage = 'detail';
    report.note = `详情失败：${errText(err)}`;
    return report;
  }

  const head = pickPlayable(episodes);
  if (!head) {
    report.stage = 'detail';
    report.note = '详情无播放地址';
    return report;
  }

  // 4. 首集：列表 + 分片
  const first = await probeHls(http, head);
  report.variants = first.variants;
  report.segments = first.segments;
  report.segmentOk = first.ok;
  report.segmentBytes = first.bytes;
  report.playlistOk = first.segments > 0 || first.note.startsWith('分片') || first.ok;
  report.note = first.note;

  if (!first.ok) {
    // 区分「列表就挂了」和「列表能拿但分片不行」
    report.stage = first.segments > 0 ? 'segment' : 'playlist';
    return report;
  }

  // 5. 末集抽检：只有首集通、整剧不一定通
  const tail = episodes.length > 1 ? pickPlayable([episodes[episodes.length - 1]]) : undefined;
  if (tail && tail !== head) {
    const last = await probeHls(http, tail);
    report.tailOk = last.ok;
    if (!last.ok) report.note = `${first.note}；末集不通：${last.note}`;
  } else {
    report.tailOk = true;
  }

  report.stage = 'ok';
  return report;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80);
}

function loadSources(file: string): SourceConfig[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    sources?: { name: string; url: string; detail?: string; isAdult?: boolean }[];
  };
  return (raw.sources ?? []).map((s, i) => ({
    key: `audit_${i}`,
    name: s.name,
    url: s.url,
    detail: s.detail,
    isAdult: s.isAdult,
  }));
}

export function reportsToJson(reports: SourceReport[]): string {
  return JSON.stringify(reports, null, 2);
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--file');
  const file = at >= 0 && args[at + 1] ? args[at + 1] : 'defaults/sources.json';
  const atJson = args.indexOf('--json');
  const jsonOut = atJson >= 0 ? args[atJson + 1] : undefined;
  const sources = loadSources(file);
  console.log(`体检 ${sources.length} 个源（${file}）\n`);

  const reports: SourceReport[] = [];
  // 逐个跑：并发打 10 个采集站容易触发对方限流，测出来的数不准
  for (const source of sources) {
    const r = await checkSource(source);
    reports.push(r);
    const mark = r.stage === 'ok' ? (r.tailOk ? '✓✓' : '✓·') : '✗✗';    console.log(
      `${mark} ${r.name.padEnd(10)} 分类${String(r.categories).padStart(3)} 搜索${String(r.searchHits).padStart(3)}条/${String(
        r.searchMs
      ).padStart(5)}ms 分集${String(r.episodes).padStart(3)} 分片${r.segmentOk ? `${r.segmentBytes}B` : '--'} ${
        r.stage === 'ok' ? '' : `[${r.stage}] `
      }${r.note}`
    );
  }

  console.log('\n=========== 汇总 ===========');
  // 两种口径分开数：
  // - 「首集可用」是用户点开一部片子能不能看，这是硬指标。
  // - 「末集也通」只用来发现「前面几集能放、后面几集掉了」这种部分失效，
  //   采集站的分片 CDN 抖动很常见，末集抽检偶发超时不该把整个源判死。
  const played = reports.filter((r) => r.stage === 'ok');
  const full = reports.filter((r) => r.stage === 'ok' && r.tailOk);
  console.log(`首集可用：${played.length}/${reports.length}`);
  console.log(`末集也通：${full.length}/${reports.length}`);
  for (const r of reports.filter((x) => x.stage !== 'ok')) {
    console.log(`  ✗ ${r.name}：${r.stage} / ${r.note}`);
  }
  for (const r of reports.filter((x) => x.stage === 'ok' && !x.tailOk)) {
    console.log(`  · ${r.name}：首集正常，末集抽检失败 / ${r.note}`);
  }

  if (jsonOut) writeFileSync(jsonOut, reportsToJson(reports));
}

// 只在直接运行时跑 main（被 import 时不执行）。
// 注意 vite-node 下 process.argv[1] 是 vite-node 自己，必须看 import.meta.url。
if (import.meta.url.replace(/\\/g, '/').endsWith('source-health.ts')) void main();
