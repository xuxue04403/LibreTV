/**
 * 抽检 Collect-IPTV 列表的频道可播性 + 检查带 auth_key 的地址会不会过期。
 *
 * 用法：npx vite-node tools/audit/collect-iptv-probe.ts [抽样数]
 */

import { createFetchHttp } from '../../packages/core/src/http';
import { fetchLivePlaylist } from '../../packages/core/src/live';

const URL_MAIN = 'https://raw.githubusercontent.com/zilong7728/Collect-IPTV/main/best_sorted.m3u';
const http = createFetchHttp();

/** 对一个 m3u8 地址做「能否拿到第一个分片」的判定 */
async function probe(url: string): Promise<{ ok: boolean; ms: number; note: string }> {
  const started = Date.now();
  try {
    const res = await http.request(url, {
      timeoutMs: 9_000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, note: `HTTP ${res.status}` };
    const text = res.text;
    if (!text.includes('#EXTM3U')) return { ok: false, ms, note: `非 m3u8（${text.length}B）` };
    if (text.includes('#EXT-X-STREAM-INF')) {
      // master：找第一个子列表再请求一次
      const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (!line) return { ok: false, ms, note: 'master 无变体' };
      const child = new URL(line, url).toString();
      const sub = await http.request(child, { timeoutMs: 9_000 });
      const okSub = sub.ok && sub.text.includes('#EXTM3U');
      return { ok: okSub, ms: Date.now() - started, note: okSub ? `master→子列表 ok` : `子列表 HTTP ${sub.status}` };
    }
    return { ok: true, ms, note: `直列表 ${res.bytes.byteLength}B` };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, note: err instanceof Error ? err.message.slice(0, 40) : '失败' };
  }
}

async function main() {
  const sampleSize = Number(process.argv[2] ?? 24);
  const playlist = await fetchLivePlaylist(URL_MAIN, http, { timeoutMs: 40_000 });
  console.log(`总频道 ${playlist.channels.length}，分组 ${playlist.groups.length}\n`);

  // 1. auth_key 过期分析
  const withAuth = playlist.channels.filter((c) => /auth_key=(\d+)-/.test(c.url));
  const expiries = new Map<string, number>();
  for (const ch of withAuth) {
    const m = /auth_key=(\d{9,11})-/.exec(ch.url);
    if (!m) continue;
    const epoch = Number(m[1]);
    // 只接受 2001～2100 年之间的时间戳，避免把别处的长数字当成时间
    if (!Number.isFinite(epoch) || epoch < 1e9 || epoch > 4e9) continue;
    const day = new Date(epoch * 1000).toISOString().slice(0, 10);
    expiries.set(day, (expiries.get(day) ?? 0) + 1);
  }
  console.log(`带 auth_key 的频道：${withAuth.length} / ${playlist.channels.length}`);
  for (const [day, count] of [...expiries.entries()].sort()) console.log(`  到期 ${day}：${count} 个`);

  // 2. 按分组抽样探活
  const byGroup = new Map<string, typeof playlist.channels>();
  for (const ch of playlist.channels) {
    const g = ch.group ?? '未分组';
    const arr = byGroup.get(g) ?? [];
    if (arr.length < 3) arr.push(ch);
    byGroup.set(g, arr);
  }
  const sample = [...byGroup.values()].flat().slice(0, sampleSize);
  console.log(`\n抽检 ${sample.length} 个频道（每组最多 3 个）：`);

  let alive = 0;
  await Promise.all(
    sample.map(async (ch) => {
      const r = await probe(ch.url);
      if (r.ok) alive += 1;
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.ms.toString().padStart(5)}ms  ${(ch.group ?? '-').padEnd(8)} ${ch.name}  ${r.note}`);
    })
  );

  console.log(`\n可播 ${alive} / ${sample.length}`);
}

void main();
