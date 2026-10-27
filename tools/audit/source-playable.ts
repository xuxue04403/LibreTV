/**
 * 对入选的候选源做「真能播」验证：取详情 → 拿 m3u8 → 下载 master/首分片。
 *
 * 用法：npx vite-node tools/audit/source-playable.ts
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

interface Check {
  source: string;
  title: string;
  episodes: number;
  playlistOk: boolean;
  playlistMs: number;
  variants: number;
  segmentOk: boolean;
  segmentMs: number;
  bytes: number;
  note: string;
}

async function probePlaylist(url: string): Promise<{ ok: boolean; ms: number; variants: number; text: string }> {
  const started = Date.now();
  try {
    const res = await http.request(url, { timeoutMs: 12_000 });
    const ms = Date.now() - started;
    if (!res.ok || !res.text.includes('#EXTM3U')) return { ok: false, ms, variants: 0, text: '' };
    const variants = (res.text.match(/#EXT-X-STREAM-INF/g) ?? []).length;
    return { ok: true, ms, variants, text: res.text };
  } catch {
    return { ok: false, ms: Date.now() - started, variants: 0, text: '' };
  }
}

async function probeSegment(playlistUrl: string, text: string): Promise<{ ok: boolean; ms: number; bytes: number }> {
  const started = Date.now();
  // master → 取第一个子列表
  let target = playlistUrl;
  let body = text;
  if (text.includes('#EXT-X-STREAM-INF')) {
    const child = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (child) {
      target = new URL(child, playlistUrl).toString();
      const sub = await http.request(target, { timeoutMs: 12_000 }).catch(() => undefined);
      if (!sub?.ok) return { ok: false, ms: Date.now() - started, bytes: 0 };
      body = sub.text;
    }
  }
  const seg = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!seg) return { ok: false, ms: Date.now() - started, bytes: 0 };
  try {
    const res = await http.request(new URL(seg, target).toString(), { timeoutMs: 15_000 });
    return { ok: res.ok && res.bytes.byteLength > 0, ms: Date.now() - started, bytes: res.bytes.byteLength };
  } catch {
    return { ok: false, ms: Date.now() - started, bytes: 0 };
  }
}

async function main() {
  const out: Check[] = [];
  for (const source of CANDIDATES) {
    for (const title of TITLES) {
      const check: Check = {
        source: source.name,
        title,
        episodes: 0,
        playlistOk: false,
        playlistMs: 0,
        variants: 0,
        segmentOk: false,
        segmentMs: 0,
        bytes: 0,
        note: '',
      };
      try {
        const search = await searchSources({ wd: title, sources: [source], http, maxPages: 1, timeoutMs: 14_000 });
        const item = search.list[0];
        if (!item) {
          check.note = '搜索无结果';
          out.push(check);
          continue;
        }
        check.title = item.name;
        const detail = await fetchDetail(source, item.vodId, http, { timeoutMs: 15_000 });
        check.episodes = detail.episodes.length;
        const first = detail.episodes.find((u) => /\.m3u8/i.test(u)) ?? detail.episodes[0];
        if (!first) {
          check.note = '无分集地址';
          out.push(check);
          continue;
        }
        const pl = await probePlaylist(first);
        check.playlistOk = pl.ok;
        check.playlistMs = pl.ms;
        check.variants = pl.variants;
        if (pl.ok) {
          const seg = await probeSegment(first, pl.text);
          check.segmentOk = seg.ok;
          check.segmentMs = seg.ms;
          check.bytes = seg.bytes;
        }
      } catch (err) {
        check.note = err instanceof Error ? err.message.slice(0, 60) : '失败';
      }
      out.push(check);
      const mark = check.segmentOk ? '✓✓' : check.playlistOk ? '✓·' : '✗✗';
      console.log(
        `${mark} ${source.name.padEnd(8)} ${check.title.padEnd(12)} 分集 ${String(check.episodes).padStart(3)} 列表 ${check.playlistMs}ms/${check.variants}变体 分片 ${check.segmentMs}ms/${check.bytes}B ${check.note}`
      );
    }
  }

  console.log('\n=========== 汇总 ===========');
  for (const source of CANDIDATES) {
    const rows = out.filter((r) => r.source === source.name);
    const okRows = rows.filter((r) => r.segmentOk);
    console.log(
      `${source.name.padEnd(8)} 分片可下 ${okRows.length}/${rows.length}  平均列表 ${Math.round(
        okRows.reduce((s, r) => s + r.playlistMs, 0) / Math.max(1, okRows.length)
      )}ms`
    );
  }
}

void main();
