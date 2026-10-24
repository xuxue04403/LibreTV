/**
 * 中插广告实测：抓真实源的 m3u8，看播放列表里到底有没有「异源短段」。
 *
 * 用法：npx vite-node tools/audit/ad-splice.ts [关键词]
 */
import { fetchDetail, searchSources, createFetchHttp, stripAdGroups, type SourceConfig } from '../../packages/core/src';
const DEFAULT_SOURCES: SourceConfig[] = [
  { key: 'ffzy', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lziapi', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'moduapi', name: '魔都资源', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360zy', name: '360资源', url: 'https://www.360zy.com/api.php/provide/vod' },
];

const http = createFetchHttp();

interface Segment {
  url: string;
  seconds: number;
  discBefore: boolean;
}

function parseSegments(text: string, base: string): Segment[] {
  const lines = text.split('\n').map((l) => l.trim());
  const out: Segment[] = [];
  let seconds = 0;
  let disc = false;
  for (const line of lines) {
    if (!line) continue;
    if (line === '#EXT-X-DISCONTINUITY') {
      disc = true;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      seconds = parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;
    let abs = line;
    try {
      abs = new URL(line, base).href;
    } catch {
      /* 保留原样 */
    }
    out.push({ url: abs, seconds, discBefore: disc });
    seconds = 0;
    disc = false;
  }
  return out;
}

function signature(url: string): string {
  try {
    const u = new URL(url);
    const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
    return `${u.host}/${first}`;
  } catch {
    return url;
  }
}

/** 连续同名签名的段组成一「run」 */
function runs(segments: Segment[]): { sig: string; seconds: number; count: number; from: number; to: number }[] {
  const out: { sig: string; seconds: number; count: number; from: number; to: number }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const sig = signature(segments[i].url);
    const last = out[out.length - 1];
    if (last && last.sig === sig) {
      last.seconds += segments[i].seconds;
      last.count += 1;
      last.to = i;
    } else {
      out.push({ sig, seconds: segments[i].seconds, count: 1, from: i, to: i });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const keyword = process.argv[2] ?? '流浪地球';
  const sources: SourceConfig[] = DEFAULT_SOURCES;
  const found = await searchSources({ wd: keyword, sources, http, maxPages: 1, timeoutMs: 12_000, filterAdult: true });
  const items = found.list.slice(0, 2);
  console.log(`关键词「${keyword}」命中 ${found.list.length} 条，取样 ${items.length} 条\n`);

  for (const item of items) {
    const source = sources.find((s) => s.key === item.sourceKey);
    if (!source) continue;
    let detail;
    try {
      detail = await fetchDetail(source, item.vodId, http, { timeoutMs: 12_000 });
    } catch (err) {
      console.log(`${item.name} @${item.sourceName}: 详情失败 ${(err as Error).message}`);
      continue;
    }
    const m3u8 = detail.episodes.find((u) => /\.m3u8(\?|$)/i.test(u));
    if (!m3u8) {
      console.log(`${item.name} @${item.sourceName}: 无 m3u8（${detail.episodes.length} 集，首条 ${detail.episodes[0]?.slice(0, 60)}）`);
      continue;
    }
    let playlist = '';
    try {
      playlist = (await http.request(m3u8, { timeoutMs: 15_000, headers: { Accept: '*/*' } })).text;
    } catch (err) {
      console.log(`${item.name} @${item.sourceName}: 拉播放列表失败 ${(err as Error).message}`);
      continue;
    }
    if (!playlist.includes('#EXTINF')) {
      // 主播放列表：取第一档
      const variant = playlist.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (variant) {
        const abs = new URL(variant, m3u8).href;
        playlist = (await http.request(abs, { timeoutMs: 15_000, headers: { Accept: '*/*' } })).text;
      }
    }
    const segs = parseSegments(playlist, m3u8);
    const discCount = (playlist.match(/#EXT-X-DISCONTINUITY/g) ?? []).length;
    const rs = runs(segs);
    const total = segs.reduce((a, s) => a + s.seconds, 0);
    console.log(`—— ${item.name} @${item.sourceName}`);
    console.log(`   分片 ${segs.length} 个 / 总时长 ${total.toFixed(1)}s / DISCONTINUITY ${discCount} 处 / 不同来源 ${rs.length} 段`);
    rs.slice(0, 8).forEach((r, i) => {
      console.log(`   #${i} ${r.sig}  ${r.count} 片 / ${r.seconds.toFixed(1)}s`);
    });
    if (rs.length > 8) console.log(`   …共 ${rs.length} 段`);

    const before = playlist.length;
    const after = stripAdGroups(playlist).length;
    console.log(`   广告过滤：${before} → ${after} 字节（${before === after ? '未改动' : `减少 ${before - after}`}）\n`);
  }
}

void main();
