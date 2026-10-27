/**
 * 新增候选源的**成人内容泄漏检查**：这些源的分类表里出现了现有词表没覆盖的名字
 * （港台三级 / 伦理 / 韩国伦理 / 台湾剧 …），要确认加进软件后不会漏出成人内容，
 * 以及「剧」类分类是否被正确归桶。
 *
 * 用法：npx vite-node tools/audit/new-source-adult-check.ts
 */

import { classifyCategoryName, fetchSourceCategories } from '../../packages/core/src/categories';
import { isAdultContent, parseSearchList, cmsRequestHeaders } from '../../packages/core/src/cms';
import { createFetchHttp } from '../../packages/core/src/http';
import type { SourceConfig } from '../../packages/core/src/types';

const http = createFetchHttp();

const SOURCES: SourceConfig[] = [
  { key: 'k1', name: '电影天堂', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod' },
  { key: 'k2', name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod' },
  { key: 'k3', name: '百度资源', url: 'https://api.apibdzy.com/api.php/provide/vod' },
  { key: 'k4', name: '红牛资源', url: 'https://www.hongniuzy2.com/api.php/provide/vod' },
  { key: 'k5', name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod' },
];

/** 只看可能有问题的那几个分类：名字里带这些字 */
const SUSPECT = /三级|伦理|福利|无码|有码|情色|色情|成人|偷拍|自拍|擦边|里番|传媒/;

async function main() {
  for (const source of SOURCES) {
    const cats = await fetchSourceCategories(source, http, { timeoutMs: 15_000 });
    const suspects = cats.filter((c) => SUSPECT.test(c.name));
    const otherBucket = cats.filter((c) => classifyCategoryName(c.name) === 'other');

    console.log(`\n══ ${source.name}`);
    console.log(`  可疑分类 ${suspects.length} 个：${suspects.map((c) => c.name).join(' / ') || '无'}`);
    console.log(`  归入「其他」且不展示的分类 ${otherBucket.length} 个：${otherBucket.map((c) => c.name).join(' / ') || '无'}`);

    for (const cat of suspects) {
      const flagged = isAdultContent(cat.name);
      let sample = '';
      let leaked: string[] = [];
      try {
        const res = await http.request(`${source.url}?ac=videolist&t=${cat.id}&pg=1`, {
          timeoutMs: 15_000,
          headers: cmsRequestHeaders(),
        });
        const items = parseSearchList(JSON.parse(res.text), source);
        sample = items.slice(0, 4).map((i) => i.name).join(' / ');
        // 如果分类本身没被判为成人，就看标题兜底能不能拦住
        leaked = items.filter((i) => !isAdultContent(i.typeName, i.name, i.isAdult)).map((i) => i.name);
      } catch (err) {
        sample = `抓取失败 ${err instanceof Error ? err.message.slice(0, 30) : ''}`;
      }
      console.log(
        `    ${flagged ? '✅ 分类已识别为成人' : '⚠️  分类未识别为成人'}  「${cat.name}」(t=${cat.id})  样本：${sample}`
      );
      if (!flagged && leaked.length > 0) {
        console.log(`        ❗ 会有 ${leaked.length} 条漏出：${leaked.slice(0, 6).join(' / ')}`);
      }
    }
  }
}

void main();
