/**
 * 验证 Collect-IPTV 的 m3u 能否被本项目的直播链路正确解析，并抽检若干频道的可播性。
 *
 * 用法：npx vite-node tools/audit/collect-iptv-check.ts
 */

import { createFetchHttp } from '../../packages/core/src/http';
import { fetchLivePlaylist } from '../../packages/core/src/live';

const http = createFetchHttp();

const MIRRORS = [
  'https://raw.githubusercontent.com/zilong7728/Collect-IPTV/main/best_sorted.m3u',
  'https://cdn.jsdelivr.net/gh/zilong7728/Collect-IPTV@main/best_sorted.m3u',
  'https://ghfast.top/https://raw.githubusercontent.com/zilong7728/Collect-IPTV/main/best_sorted.m3u',
  'https://gh-proxy.com/raw.githubusercontent.com/zilong7728/Collect-IPTV/main/best_sorted.m3u',
];

async function main() {
  for (const url of MIRRORS) {
    const started = Date.now();
    try {
      let batches = 0;
      let firstAt = 0;
      const playlist = await fetchLivePlaylist(url, http, {
        timeoutMs: 40_000,
        idleTimeoutMs: 20_000,
        onChannels: () => {
          batches += 1;
          if (!firstAt) firstAt = Date.now() - started;
        },
      });
      const ms = Date.now() - started;
      console.log(
        `\n${url}\n  耗时 ${ms}ms（首批 ${firstAt}ms，${batches} 批）  频道 ${playlist.channels.length}  分组 ${playlist.groups.length}`
      );
      console.log(`  分组：${playlist.groups.slice(0, 12).join(' / ')}`);
      console.log(`  样例：${playlist.channels.slice(0, 3).map((c) => `${c.name}[${c.group ?? '-'}]`).join(' | ')}`);
      const noGroup = playlist.channels.filter((c) => !c.group).length;
      const noLogo = playlist.channels.filter((c) => !c.logo).length;
      console.log(`  无分组 ${noGroup} 个，无台标 ${noLogo} 个，EPG=${playlist.epgUrl ?? '无'}`);
      return;
    } catch (err) {
      console.log(`\n${url}\n  失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

void main();
