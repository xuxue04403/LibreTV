/**
 * 拼音检索可行性实测：各源「最新列表」里到底有没有能被 qmmk 命中的片子，
 * 以及需要翻多少页才够。
 *
 * 用法：npx vite-node tools/audit/pinyin-recall.ts [首字母]
 */
import { createFetchHttp, parseSearchList, pinyinInitials, type SourceConfig } from '../../packages/core/src';

const http = createFetchHttp();

const SOURCES: SourceConfig[] = [
  { key: 'ffzy', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lziapi', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'moduapi', name: '魔都资源', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360zy', name: '360资源', url: 'https://www.360zy.com/api.php/provide/vod' },
];

async function main(): Promise<void> {
  const query = (process.argv[2] ?? 'qmmk').toLowerCase();
  let scanned = 0;
  const hits = new Map<string, { name: string; source: string; page: number }>();

  for (const source of SOURCES) {
    const base = source.url.trimEnd('/');
    let pages = 0;
    for (let page = 1; page <= 30; page++) {
      let parsed;
      try {
        const text = (await http.request(`${base}?ac=videolist&pg=${page}`, { timeoutMs: 15_000 })).text;
        parsed = parseSearchList(JSON.parse(text), source);
      } catch {
        break;
      }
      if (!parsed.length) break;
      pages += 1;
      scanned += parsed.length;
      for (const item of parsed) {
        const initials = pinyinInitials(item.name);
        if (initials.includes(query) && !hits.has(item.name)) {
          hits.set(item.name, { name: item.name, source: item.source.name, page });
        }
      }
      if (parsed.length < 20) break;
    }
    console.log(`${source.name}: 翻了 ${pages} 页`);
  }

  console.log(`\n共扫描 ${scanned} 条，命中 ${hits.size} 条：`);
  [...hits.values()].slice(0, 20).forEach((h) => console.log(`  ${h.name}  @${h.source} (第${h.page}页)`));
  if (hits.size === 0) console.log('  （没有命中：说明这些源的最新列表里确实没有该片）');
}

void main();
