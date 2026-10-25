/**
 * 预取实测：直接起真实的媒体代理，量「预取命中」与「回源」的差距。
 *
 * 需要一个本地 HLS 源（默认 mock CMS 8099，MEDIA_DIR=.artifacts/hls）。
 * 用法：npx vite-node tools/audit/prefetch-check.ts
 */
import { startMediaProxy } from '../../apps/desktop/src/main/proxy';

process.env.LTV_ALLOW_PRIVATE_MEDIA = '1';

const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:8099';

async function timed(url: string): Promise<{ ms: number; bytes: number; status: number }> {
  const started = Date.now();
  const res = await fetch(url);
  const body = await res.arrayBuffer();
  return { ms: Date.now() - started, bytes: body.byteLength, status: res.status };
}

const playlistUrl = `${MOCK}/hls/index.m3u8`;
const proxy = await startMediaProxy();

try {
  const playlist = await (await fetch(playlistUrl)).text();
  const segments = playlist
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  console.log(`分片数 ${segments.length}`);

  // 1) 先量「没有预取」的单片耗时
  const seg1 = new URL(segments[0], playlistUrl).href;
  const cold = await timed(`${proxy.base}/p?url=${encodeURIComponent(seg1)}`);
  console.log(`[未预取] 首片 ${cold.ms}ms ${cold.bytes}B status=${cold.status}`);

  // 2) 触发预取：只取前 1 片，末片留作「未命中」对照
  const prefetchUrl = `${proxy.base}/prefetch?url=${encodeURIComponent(playlistUrl)}&count=1`;
  const started = Date.now();
  const result = (await (await fetch(prefetchUrl)).json()) as {
    ok: boolean;
    cached: number;
    bytes: number;
    playlist: boolean;
  };
  console.log(
    `[预取] ${Date.now() - started}ms ok=${result.ok} playlist=${result.playlist} cached=${result.cached} bytes=${result.bytes}`
  );

  // 3) 预取之后再取同一片：应当明显更快（内存命中，零 RTT）
  const warmRuns: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const seg = new URL(segments[0], playlistUrl).href;
    const hit = await timed(`${proxy.base}/p?url=${encodeURIComponent(seg)}`);
    warmRuns.push(hit.ms);
    if (i === 0) console.log(`[预取命中] 首片 ${hit.ms}ms ${hit.bytes}B status=${hit.status}`);
  }
  console.log(`[预取命中] 三次耗时 ${warmRuns.join(' / ')}ms`);

  // 4) 换一个没预取过的分片做对照（只预取了第 1 片，末片必然未命中）
  const tail = new URL(segments[segments.length - 1], playlistUrl).href;
  const miss = await timed(`${proxy.base}/p?url=${encodeURIComponent(tail)}`);
  console.log(`[未命中] 末片 ${miss.ms}ms ${miss.bytes}B`);
} finally {
  await proxy.close();
}
