/**
 * 中插广告成因分析：随机采样多个源 / 多部片子，统计播放列表里广告的「长相」。
 *
 * 关注三件事：
 * 1. 广告是不是被 DISCONTINUITY 分组标出来的；
 * 2. 广告分片是不是换了域名/目录（异源拼接）；
 * 3. 我们现有的过滤到底拦下了多少。
 */
import {
  createFetchHttp,
  fetchDetail,
  searchSources,
  stripAdGroups,
  filterAdultResults,
  type SourceConfig,
} from '../../packages/core/src';

const http = createFetchHttp();

const SOURCES: SourceConfig[] = [
  { key: 'ffzy', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lziapi', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'moduapi', name: '魔都资源', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360zy', name: '360资源', url: 'https://www.360zy.com/api.php/provide/vod' },
];

const KEYWORDS = ['流浪地球', '沙丘', '庆余年', '三体', '狂飙', '斗破苍穹'];

interface Seg {
  url: string;
  seconds: number;
  disc: number;
}

function parse(text: string, base: string): Seg[] {
  const out: Seg[] = [];
  let seconds = 0;
  let disc = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '#EXT-X-DISCONTINUITY') {
      disc += 1;
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
      /* 原样保留 */
    }
    out.push({ url: abs, seconds, disc });
    seconds = 0;
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

async function pickMaster(playlist: string, base: string): Promise<string> {
  if (playlist.includes('#EXTINF')) return playlist;
  const variant = playlist
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!variant) return playlist;
  const abs = new URL(variant, base).href;
  return (await http.request(abs, { timeoutMs: 15_000, headers: { Accept: '*/*' } })).text;
}

async function main(): Promise<void> {
  const stats = {
    playlists: 0,
    withDisc: 0,
    withMultiHost: 0,
    modified: 0,
    droppedSeconds: 0,
    samples: [] as string[],
  };

  for (const keyword of KEYWORDS) {
    const found = await searchSources({
      wd: keyword,
      sources: SOURCES,
      http,
      maxPages: 1,
      timeoutMs: 12_000,
      filterAdult: true,
    });
    const items = filterAdultResults(found.list, true).slice(0, 2);
    for (const item of items) {
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
        const raw = (await http.request(m3u8, { timeoutMs: 15_000, headers: { Accept: '*/*' } })).text;
        playlist = await pickMaster(raw, m3u8);
      } catch {
        continue;
      }
      if (!playlist.includes('#EXTINF')) continue;

      stats.playlists += 1;
      const segs = parse(playlist, m3u8);
      const discCount = (playlist.match(/#EXT-X-DISCONTINUITY/g) ?? []).length;
      const hosts = new Set(segs.map((s) => hostOf(s.url)));
      if (discCount > 0) stats.withDisc += 1;
      if (hosts.size > 1) stats.withMultiHost += 1;

      const filtered = stripAdGroups(playlist);
      const changed = filtered.length !== playlist.length;
      if (changed) stats.modified += 1;
      const keptSeconds = parse(filtered, m3u8).reduce((a, s) => a + s.seconds, 0);
      const allSeconds = segs.reduce((a, s) => a + s.seconds, 0);
      stats.droppedSeconds += Math.max(0, allSeconds - keptSeconds);

      stats.samples.push(
        `${item.name}@${item.sourceName}: ${segs.length}片/${allSeconds.toFixed(0)}s, 主机${hosts.size}个, DISC${discCount}, 过滤${changed ? `-${(allSeconds - keptSeconds).toFixed(0)}s` : '未改动'}`
      );
    }
  }

  console.log('—— 采样结果');
  stats.samples.forEach((s) => console.log('  ' + s));
  console.log('\n—— 汇总');
  console.log(`  播放列表 ${stats.playlists} 份`);
  console.log(`  含 DISCONTINUITY 分组：${stats.withDisc} 份`);
  console.log(`  含多个主机（异源拼接）：${stats.withMultiHost} 份`);
  console.log(`  现有过滤改动过的：${stats.modified} 份，累计去掉 ${stats.droppedSeconds.toFixed(0)}s`);
}

void main();
