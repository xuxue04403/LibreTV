/**
 * M3U 解析耗时基准：直播慢到底慢在下载还是慢在解析。
 *
 * 背景：iptv-org 的 index.m3u 有 2.5MB / 近万频道，需要知道解析本身
 * 是否也需要优化，还是只靠「渐进渲染 + 缓存」就够。
 *
 * 用法：npx vite-node tools/audit/live-parse-bench.ts [本地 m3u 路径]
 * 没有样本文件时会生成一份等量的合成列表（1 万频道）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { parseM3u, collectGroups, filterChannels, filterAdultChannels } from '../../packages/core/src/index';

function synthetic(count: number): string {
  const lines = ['#EXTM3U'];
  for (let i = 0; i < count; i++) {
    lines.push(
      `#EXTINF:-1 tvg-id="ch${i}.tv" tvg-name="Channel ${i}" tvg-logo="https://logo.example.com/${i}.png" group-title="Group ${i % 40}",Channel ${i} HD`
    );
    lines.push(`https://stream.example.com/live/${i}/index.m3u8`);
  }
  return lines.join('\n');
}

const path = process.argv[2] ?? '.tmp/index.m3u';
const text = existsSync(path) ? readFileSync(path, 'utf8') : synthetic(10_000);
console.log(`样本 ${(text.length / 1024 / 1024).toFixed(2)}MB / ${text.split(/\r?\n/).length} 行 / 来源 ${existsSync(path) ? path : '合成'}`);

const time = <T>(label: string, fn: () => T): T => {
  const t = performance.now();
  const value = fn();
  const ms = performance.now() - t;
  console.log(`  ${label}: ${ms.toFixed(1)}ms`);
  return value;
};

const channels = time('parseM3u', () => parseM3u(text, 'https://example.com/index.m3u'));
console.log(`  频道 ${channels.length}`);
time('collectGroups', () => collectGroups(channels));
time('filterAdultChannels', () => filterAdultChannels(channels, true));
time('filterChannels(全部)', () => filterChannels(channels, {}));
time('filterChannels(关键词)', () => filterChannels(channels, { keyword: 'cctv' }));
// 参照：JSON 序列化/反序列化一份等量数据，用于判断缓存方案的成本
const json = time('JSON.stringify', () => JSON.stringify(channels));
console.log(`  JSON 体积 ${(json.length / 1024).toFixed(0)}KB`);
time('JSON.parse', () => JSON.parse(json));
