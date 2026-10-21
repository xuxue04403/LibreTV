/**
 * 直播列表加载耗时审计。
 *
 * 直播慢的原因和点播不同：点播慢在「多源并行 + 分页」，直播慢在
 * 「单个 M3U 文件极大」（iptv-org index.m3u 近万频道、数 MB），
 * 一次拉全量再全量渲染，用户要等几十秒。
 *
 * 用法：npx vite-node tools/audit/live-load.ts
 */
import { createFetchHttp, fetchLivePlaylist, filterAdultChannels } from '../../packages/core/src/index';
import { readFileSync } from 'node:fs';

const http = createFetchHttp();
const sources = JSON.parse(readFileSync('defaults/sources.json', 'utf8')).liveSources as {
  name: string;
  url: string;
}[];

for (const source of sources) {
  const started = Date.now();
  try {
    const res = await http.request(source.url, { timeoutMs: 30_000 });
    const fetched = Date.now();
    const playlist = await fetchLivePlaylist(source.url, http, { timeoutMs: 30_000 });
    const parsed = Date.now();
    const safe = filterAdultChannels(playlist.channels, true);
    console.log(
      `${source.name}: 下载 ${(res.bytes.byteLength / 1024 / 1024).toFixed(2)}MB / ${fetched - started}ms，` +
        `解析 ${parsed - fetched}ms，${playlist.channels.length} 频道（过滤后 ${safe.length}），` +
        `${playlist.groups.length} 分组，总 ${Date.now() - started}ms`
    );
  } catch (err) {
    console.log(`${source.name}: 失败 ${err instanceof Error ? err.message : err}（${Date.now() - started}ms）`);
  }
}
