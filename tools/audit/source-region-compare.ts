/**
 * 逐源逐片名验证「真能播」，每步带重试，输出稳定可比的结果。
 *
 * 与 source-playable.ts 的区别：串行 + 重试 + 记录每次失败原因，
 * 避免并发触发的 fetch failed 被误判为「源不可用」。
 *
 * 用法：npx vite-node tools/audit/source-region-compare.ts
 */

import { fetchDetail } from '../../packages/core/src/detail';
import { createFetchHttp } from '../../packages/core/src/http';
import { searchSources } from '../../packages/core/src/search';
import type { SourceConfig } from '../../packages/core/src/types';

const http = createFetchHttp();

const CANDIDATES: SourceConfig[] = [
  { key: 'c1', name: '电影天堂', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod' },
  { key: 'c2', name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod' },
  { key: 'c3', name: '百度资源', url: 'https://api.apibdzy.com/api.php/provide/vod' },
  { key: 'c4', name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod' },
  { key: 'c5', name: '红牛资源', url: 'https://www.hongniuzy2.com/api.php/provide/vod' },
  { key: 'c6', name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod' },
];

const TITLES = ['流浪地球2', '三体', '庆余年'];
const RETRY = 3;

function msg(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string } };
  return e?.cause?.code ? `${e.message ?? 'error'} (${e.cause.code})` : (e?.message ?? String(err));
}

async function attempt<T>(label: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let last = '';
  for (let i = 1; i <= RETRY; i += 1) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      last = msg(err);
      if (i < RETRY) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  return { ok: false, error: `${label}: ${last}` };
}

/** m3u8 若是 master，往下钻一层拿真正的分片列表；返回首个分片地址。 */
async function firstSegment(playlistUrl: string): Promise<{ ok: boolean; first: string; variants: number; error?: string }> {
  const res = await http.request(playlistUrl, { timeoutMs: 15_000, headers: { Accept: '*/*' } });
  if (!res.ok) return { ok: false, first: '', variants: 0, error: `HTTP ${res.status}` };
  if (!res.text.includes('#EXTM3U')) return { ok: false, first: '', variants: 0, error: '不是 m3u8（可能被拦或返回网页）' };

  const base = res.url || playlistUrl;
  const lines = res.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  const variants = lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF')).length;

  if (isMaster) {
    const child = lines.find((l) => !l.startsWith('#'));
    if (!child) return { ok: false, first: '', variants, error: 'master 里没有子列表' };
    return firstSegment(new URL(child, base).href);
  }

  const seg = lines.find((l) => !l.startsWith('#'));
  if (!seg) return { ok: false, first: '', variants, error: '列表里没有分片' };
  return { ok: true, first: new URL(seg, base).href, variants };
}

interface Row {
  source: string;
  title: string;
  episodes: number;
  listMs: number;
  segMs: number;
  bytes: number;
  ok: boolean;
  note: string;
}

async function main(): Promise<void> {
  const rows: Row[] = [];

  for (const source of CANDIDATES) {
    for (const title of TITLES) {
      const started = Date.now();
      const found = await attempt('搜索', async () => {
        const result = await searchSources({
          wd: title,
          sources: [source],
          http,
          maxPages: 1,
          timeoutMs: 15_000,
          filterAdult: false,
        });
        const item = result.list[0];
        if (!item) throw new Error('搜索无结果');
        return item;
      });

      if (!found.ok) {
        rows.push({ source: source.name, title, episodes: 0, listMs: 0, segMs: 0, bytes: 0, ok: false, note: found.error });
        continue;
      }

      const detail = await attempt('详情', () => fetchDetail(source, found.value.vodId, http, { timeoutMs: 15_000 }));
      if (!detail.ok || detail.value.episodes.length === 0) {
        rows.push({
          source: source.name,
          title,
          episodes: 0,
          listMs: 0,
          segMs: 0,
          bytes: 0,
          ok: false,
          note: detail.ok ? '详情无分集' : detail.error,
        });
        continue;
      }
      const listMs = Date.now() - started;
      const episodeUrl = detail.value.episodes[0];

      const seg = await attempt('列表', () => firstSegment(episodeUrl));
      if (!seg.ok) {
        rows.push({ source: source.name, title, episodes: detail.value.episodes.length, listMs, segMs: 0, bytes: 0, ok: false, note: seg.error });
        continue;
      }
      if (!seg.value.ok) {
        rows.push({
          source: source.name,
          title,
          episodes: detail.value.episodes.length,
          listMs,
          segMs: 0,
          bytes: 0,
          ok: false,
          note: seg.value.error ?? '列表不可用',
        });
        continue;
      }

      const segStart = Date.now();
      const got = await attempt('分片', () => http.request(seg.value.first, { timeoutMs: 20_000, headers: { Accept: '*/*' } }));
      const segMs = Date.now() - segStart;
      if (!got.ok) {
        rows.push({ source: source.name, title, episodes: detail.value.episodes.length, listMs, segMs, bytes: 0, ok: false, note: got.error });
        continue;
      }
      const bytes = got.value.bytes.byteLength;
      rows.push({
        source: source.name,
        title,
        episodes: detail.value.episodes.length,
        listMs,
        segMs,
        bytes,
        ok: got.value.ok && bytes > 1024,
        note: got.value.ok ? (bytes > 1024 ? `${seg.value.variants} 变体` : `分片仅 ${bytes}B`) : `HTTP ${got.value.status}`,
      });
    }
  }

  console.log('\n=========== 明细 ===========');
  for (const row of rows) {
    const flag = row.ok ? '✓✓' : '✗✗';
    console.log(
      `${flag} ${row.source.padEnd(6)} ${row.title.padEnd(10)} 分集 ${String(row.episodes).padStart(3)} ` +
        `列表 ${String(row.listMs).padStart(5)}ms 分片 ${String(row.segMs).padStart(5)}ms ` +
        `${String(row.bytes).padStart(8)}B ${row.note}`,
    );
  }

  console.log('\n=========== 汇总 ===========');
  for (const source of CANDIDATES) {
    const mine = rows.filter((r) => r.source === source.name);
    const ok = mine.filter((r) => r.ok).length;
    const okRows = mine.filter((r) => r.ok);
    const avgList = okRows.length ? Math.round(okRows.reduce((a, b) => a + b.listMs, 0) / okRows.length) : 0;
    const avgSeg = okRows.length ? Math.round(okRows.reduce((a, b) => a + b.segMs, 0) / okRows.length) : 0;
    const why = mine.find((r) => !r.ok)?.note ?? '';
    console.log(
      `${source.name.padEnd(6)} 分片可下 ${ok}/${mine.length}  列表均 ${String(avgList).padStart(5)}ms  ` +
        `分片均 ${String(avgSeg).padStart(5)}ms${ok === 0 ? `  原因: ${why}` : ''}`,
    );
  }
}

void main().catch((err) => {
  console.error('脚本异常:', err);
  process.exitCode = 1;
});
