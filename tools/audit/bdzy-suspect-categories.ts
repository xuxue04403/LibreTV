/**
 * 看百度资源那几个「未识别」的分类里到底装了什么：
 * 判断该补哪些词，以及补了会不会误伤。
 *
 * 用法：npx vite-node tools/audit/bdzy-suspect-categories.ts
 */

import { cmsRequestHeaders, parseSearchList } from '../../packages/core/src/cms';
import { createFetchHttp } from '../../packages/core/src/http';
import type { SourceConfig } from '../../packages/core/src/types';

const http = createFetchHttp();
const source: SourceConfig = {
  key: 'k3',
  name: '百度资源',
  url: 'https://api.apibdzy.com/api.php/provide/vod',
};

const TARGETS = [
  ['55', '伦理'],
  ['56', '港台三级'],
  ['58', '西方伦理'],
  ['60', '两性课堂'],
  ['61', '写真热舞'],
  ['53', '影视解说'],
  ['47', '演唱会'],
] as const;

async function main() {
  for (const [id, name] of TARGETS) {
    try {
      const res = await http.request(`${source.url}?ac=videolist&t=${id}&pg=1`, {
        timeoutMs: 15_000,
        headers: cmsRequestHeaders(),
      });
      const items = parseSearchList(JSON.parse(res.text), source);
      console.log(`\n── t=${id} ${name}  共 ${items.length} 条`);
      console.log('   ' + items.slice(0, 12).map((i) => i.name).join(' / '));
    } catch (err) {
      console.log(`\n── t=${id} ${name}  抓取失败：${err instanceof Error ? err.message : err}`);
    }
  }
}

void main();
