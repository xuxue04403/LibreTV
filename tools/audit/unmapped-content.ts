/**
 * 判定「未归桶」的分类到底属于哪个桶：直接看内容（分集数、标题、时长线索）。
 *
 * 用法：npx vite-node tools/audit/unmapped-content.ts
 */

import { cmsRequestHeaders, parseSearchList } from '../../packages/core/src/cms';
import { createFetchHttp } from '../../packages/core/src/http';
import type { SourceConfig } from '../../packages/core/src/types';

const http = createFetchHttp();

const CASES: Array<[string, SourceConfig, Array<[string, string]>]> = [
  [
    '电影天堂',
    { key: 'a', name: '电影天堂', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod' },
    [
      ['14', '香港剧'],
      ['21', '台湾剧'],
    ],
  ],
  [
    '极速资源',
    { key: 'b', name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod' },
    [
      ['45', '古装仙侠'],
      ['46', '现代都市'],
      ['50', '反转爽剧'],
      ['54', 'AI漫剧'],
      ['42', '台球'],
    ],
  ],
  [
    '红牛资源',
    { key: 'c', name: '红牛资源', url: 'https://www.hongniuzy2.com/api.php/provide/vod' },
    [
      ['43', '古装仙侠'],
      ['44', '现代都市'],
      ['48', '反转爽剧'],
      ['50', '擦边短剧'],
      ['51', 'AI漫剧'],
      ['34', '台球'],
      ['13', '港澳剧'],
    ],
  ],
  [
    '百度资源',
    { key: 'd', name: '百度资源', url: 'https://api.apibdzy.com/api.php/provide/vod' },
    [
      ['13', '大陆剧'],
      ['17', '港澳剧'],
      ['23', '其他剧'],
      ['65', '反转爽剧'],
      ['66', '古装仙侠'],
      ['64', '女频恋爱'],
    ],
  ],
];

function median(nums: number[]): string {
  if (nums.length === 0) return '-';
  const sorted = [...nums].sort((a, b) => a - b);
  return String(sorted[Math.floor(sorted.length / 2)]);
}

async function main() {
  for (const [label, source, targets] of CASES) {
    console.log(`\n════ ${label}`);
    for (const [id, name] of targets) {
      try {
        const res = await http.request(`${source.url}?ac=videolist&t=${id}&pg=1`, {
          timeoutMs: 15_000,
          headers: cmsRequestHeaders(),
        });
        const items = parseSearchList(JSON.parse(res.text), source);
        const names = items.slice(0, 6).map((i) => i.name);
        // 分集数能反推是不是剧：单集 = 电影/短剧，多集 = 剧集
        const episodes: number[] = [];
        for (const item of items.slice(0, 4)) {
          try {
            const detail = await http.request(`${source.url}?ac=videolist&ids=${item.vodId}`, {
              timeoutMs: 12_000,
              headers: cmsRequestHeaders(),
            });
            const text = detail.text;
            const m = /vod_play_url":"(.*?)"/.exec(text);
            const raw = m?.[1] ?? '';
            episodes.push(raw.split('#').filter(Boolean).length);
          } catch {
            /* 忽略单条失败 */
          }
        }
        console.log(
          `  ${id}=${name}  ${items.length} 条  分集中位 ${median(episodes)}  「${names.join(' / ')}」`
        );
      } catch (err) {
        console.log(`  ${id}=${name}  失败 ${err instanceof Error ? err.message : ''}`);
      }
    }
  }
}

void main();
