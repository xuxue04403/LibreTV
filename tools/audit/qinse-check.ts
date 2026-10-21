/** 验证「情色/色情」加入标题词后的真实效果。 */
import { createFetchHttp, filterAdultResults, parseSearchList } from '../../packages/core/src/index';

const http = createFetchHttp();
const S = [
  { key: 'ffzy', name: '非凡', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lz', name: '量子', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'modu', name: '魔都', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360', name: '360', url: 'https://www.360zy.com/api.php/provide/vod' },
];

async function main() {
  for (const wd of ['情色', '色情', '伦理', '三级']) {
    const raw: Array<{ name: string; typeName?: string }> = [];
    for (const s of S) {
      try {
        const r = await http.request(`${s.url}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=1`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeoutMs: 15000,
        });
        raw.push(...parseSearchList(JSON.parse(r.text), s));
      } catch {
        /* ignore */
      }
    }
    const kept = filterAdultResults(raw, true);
    console.log(`"${wd}": 原始 ${raw.length} → 保留 ${kept.length}（屏蔽 ${raw.length - kept.length}）`);
    console.log('  保留样本: ' + (kept.slice(0, 10).map((i) => i.name).join(' / ') || '（全部屏蔽）'));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
