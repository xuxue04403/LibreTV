/**
 * 直播源网络侧实测：确认「慢」是带宽、gzip 还是服务器限速。
 *
 * 用 Node 内置 fetch（与 Electron 主进程同源 undici 栈），
 * 分别测「默认协商」和「显式 gzip」下的耗时/体积。
 */
const url = process.argv[2] ?? 'https://iptv-org.github.io/iptv/index.m3u';

async function probe(label: string, headers: Record<string, string>) {
  const started = performance.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(90_000) });
    const ttfb = performance.now() - started;
    const buf = new Uint8Array(await res.arrayBuffer());
    const total = performance.now() - started;
    console.log(
      `${label}: HTTP ${res.status}，TTFB ${ttfb.toFixed(0)}ms，总计 ${total.toFixed(0)}ms，` +
        `${(buf.byteLength / 1024 / 1024).toFixed(2)}MB（解压后），content-encoding=${res.headers.get('content-encoding') ?? '无'}`
    );
  } catch (err) {
    console.log(`${label}: 失败 ${(err as Error).message}（${(performance.now() - started).toFixed(0)}ms）`);
  }
}

await probe('默认协商', {});
await probe('显式 gzip', { 'Accept-Encoding': 'gzip' });
