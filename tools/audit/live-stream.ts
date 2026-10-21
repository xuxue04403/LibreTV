/**
 * 直播列表加载实测：验证「边下边解析」是否真能把第一个频道提前。
 *
 * 直接调 packages/core 的 fetchLivePlaylist（依赖注入 Node fetch 版 HttpClient），
 * 记录首批频道到达时刻、总耗时与字节数，和「整串下载完再解析」的旧路径对比。
 *
 * 用法：npx vite-node tools/audit/live-stream.ts [url]
 */
import { createFetchHttp } from '../../packages/core/src/http';
import { fetchLivePlaylist } from '../../packages/core/src/live';

const DEFAULT_URL = 'https://iptv-org.github.io/iptv/countries/cn.m3u';

async function main() {
  const url = process.argv[2] ?? DEFAULT_URL;
  const http = createFetchHttp();

  console.log(`源：${url}`);

  // —— 旧路径：一次性 request + parseM3u（模拟改动前的行为）——
  const oldStart = Date.now();
  const res = await http.request(url, { timeoutMs: 120_000, headers: { Accept: '*/*' } });
  const oldDownload = Date.now() - oldStart;
  const { parseM3u } = await import('../../packages/core/src/m3u');
  const oldParseStart = Date.now();
  const oldChannels = parseM3u(res.text, url);
  const oldParse = Date.now() - oldParseStart;
  console.log(
    `旧路径：下载 ${oldDownload}ms（${(res.bytes / 1024).toFixed(0)}KB）+ 解析 ${oldParse}ms = ${oldDownload + oldParse}ms，${oldChannels.length} 个频道`,
  );

  // —— 新路径：流式渐进解析 ——
  let firstBatchAt = 0;
  let batches = 0;
  let bytesAtFirst = 0;
  let peak = 0;
  const start = Date.now();
  const playlist = await fetchLivePlaylist(url, http, {
    timeoutMs: 180_000,
    idleTimeoutMs: 30_000,
    onChannels: (added, progress) => {
      batches += 1;
      if (!firstBatchAt) {
        firstBatchAt = Date.now() - start;
        bytesAtFirst = progress.bytes;
      }
      peak = Math.max(peak, progress.channels);
    },
  });
  const total = Date.now() - start;

  console.log(
    `新路径：首个批次 ${firstBatchAt}ms（此时 ${(bytesAtFirst / 1024).toFixed(0)}KB），共 ${batches} 批，全部 ${total}ms，${playlist.channels.length} 个频道`,
  );
  console.log(`首批提速：${(oldDownload + oldParse - firstBatchAt)}ms（${((oldDownload + oldParse) / firstBatchAt).toFixed(1)}×）`);

  if (playlist.channels.length !== oldChannels.length) {
    console.log(`⚠️ 两条路径频道数不一致：${playlist.channels.length} vs ${oldChannels.length}`);
  } else {
    console.log('✅ 两条路径频道数一致');
  }

  // 抽样比对前几个频道，确认流式解析没把字段搞坏
  const sample = playlist.channels.slice(0, 3).map((c) => `${c.name} | ${c.group ?? '-'} | ${c.url.slice(0, 48)}`);
  console.log('样本：\n  ' + sample.join('\n  '));
}

main().catch((err) => {
  console.error('失败：', err);
  process.exit(1);
});
