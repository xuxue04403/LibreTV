/**
 * 逐组分析：把一份 m3u8 按 DISCONTINUITY 切成组，打印每组的时长与是否被现有规则剔除。
 * 用来判断「放宽阈值」会不会误伤正片。
 *
 * 用法：npx vite-node tools/audit/ad-groups.ts [关键词]
 */
import { createFetchHttp, fetchDetail, searchSources, stripInterstitialAdGroups, type SourceConfig } from '../../packages/core/src';

const http = createFetchHttp();

const SOURCES: SourceConfig[] = [
  { key: 'ffzy', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lziapi', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'moduapi', name: '魔都资源', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360zy', name: '360资源', url: 'https://www.360zy.com/api.php/provide/vod' },
];

function groups(text: string): { seconds: number; count: number }[] {
  const out: { seconds: number; count: number }[] = [];
  let cur = { seconds: 0, count: 0 };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '#EXT-X-DISCONTINUITY') {
      out.push(cur);
      cur = { seconds: 0, count: 0 };
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      cur.seconds += parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;
    cur.count += 1;
  }
  out.push(cur);
  return out;
}

async function main(): Promise<void> {
  const keyword = process.argv[2] ?? '三体';
  const found = await searchSources({
    wd: keyword,
    sources: SOURCES,
    http,
    maxPages: 1,
    timeoutMs: 12_000,
    filterAdult: true,
  });
  for (const item of found.list.slice(0, 3)) {
    const source = SOURCES.find((s) => s.key === item.sourceKey);
    if (!source) continue;
    let detail;
    try {
      detail = await fetchDetail(source, item.vodId, http, { timeoutMs: 12_000 });
    } catch {
      continue;
    }
    const m3u8 = detail.episodes.find((u) => /\.m3u8(\?|$)/i.test(u));
    if (!m3u8) continue;
    let playlist: string;
    try {
      playlist = (await http.request(m3u8, { timeoutMs: 15_000, headers: { Accept: '*/*' } })).text;
    } catch {
      continue;
    }
    if (!playlist.includes('#EXTINF')) {
      const variant = playlist.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (!variant) continue;
      playlist = (await http.request(new URL(variant, m3u8).href, { timeoutMs: 15_000, headers: { Accept: '*/*' } })).text;
    }
    const gs = groups(playlist);
    const dropped = stripInterstitialAdGroups(playlist);
    const after = groups(dropped);
    const droppedGroups = gs.length - after.length;

    console.log(`—— ${item.name} @${item.sourceName}：${gs.length} 组 / DISC ${gs.length - 1} 处 / 被剔除 ${droppedGroups} 组`);
    gs.forEach((g, i) => {
      const prev = gs[i - 1];
      const next = gs[i + 1];
      const mark = i > 0 && g.count > 0 && g.seconds > 0 && g.seconds <= 30 && prev && prev.seconds >= 120 && next && next.seconds >= 120 ? ' ← 会被剔除' : '';
      if (i < 6 || g.seconds < 150 || mark) {
        console.log(`   组${i}: ${g.count} 片 / ${g.seconds.toFixed(1)}s${mark}`);
      }
    });
    console.log('');
  }
}

void main();
