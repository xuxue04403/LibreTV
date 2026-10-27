/**
 * 看采集站分类表的父子结构：确认「香港剧」「古装仙侠」这类未归类分类到底挂在哪里。
 *
 * 用法：npx vite-node tools/audit/category-tree.ts
 */

import { classifyCategoryName } from '../../packages/core/src/categories';
import { createFetchHttp } from '../../packages/core/src/http';
import { parseSourceCategories } from '../../packages/core/src/categories';
import { cmsRequestHeaders } from '../../packages/core/src/cms';

const http = createFetchHttp();

const URLS = [
  ['电影天堂', 'http://caiji.dyttzyapi.com/api.php/provide/vod'],
  ['极速资源', 'https://jszyapi.com/api.php/provide/vod'],
  ['百度资源', 'https://api.apibdzy.com/api.php/provide/vod'],
  ['红牛资源', 'https://www.hongniuzy2.com/api.php/provide/vod'],
  ['如意资源', 'https://cj.rycjapi.com/api.php/provide/vod'],
  ['360资源(现有)', 'https://www.360zy.com/api.php/provide/vod'],
] as const;

async function main() {
  for (const [name, url] of URLS) {
    const res = await http.request(`${url}?ac=list&pg=1`, { timeoutMs: 15_000, headers: cmsRequestHeaders() });
    const cats = parseSourceCategories(JSON.parse(res.text));
    const byId = new Map(cats.map((c) => [c.id, c]));
    const roots = cats.filter((c) => !c.parentId);
    const children = cats.filter((c) => c.parentId);

    console.log(`\n══ ${name}  共 ${cats.length} 个分类，顶级 ${roots.length}，子级 ${children.length}`);
    console.log(`  顶级：${roots.map((c) => `${c.id}=${c.name}`).join(' ')}`);

    const other = cats.filter((c) => classifyCategoryName(c.name) === 'other');
    console.log(`  未归桶 ${other.length} 个：`);
    for (const c of other) {
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      console.log(
        `    ${c.id}=${c.name}${parent ? `  ← 父 ${parent.id}=${parent.name}（父归桶：${classifyCategoryName(parent.name)}）` : '  （顶级）'}`
      );
    }
  }
}

void main();
