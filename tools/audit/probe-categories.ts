/**
 * 验证「首页隐藏空分类 + 电影电视剧靠前」在真实源上的表现。
 *
 * 用法：npx vite-node tools/audit/probe-categories.ts
 */
import { createFetchHttp, probeCategories, categoryLabel, HOME_CATEGORIES, type SourceConfig } from '../../packages/core/src/index';

const sources: SourceConfig[] = [
  { key: 'ffzy', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lziapi', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'moduapi', name: '魔都资源', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360zy', name: '360资源', url: 'https://www.360zy.com/api.php/provide/vod' },
];

const http = createFetchHttp();

const started = Date.now();
const results = await probeCategories({
  sources,
  http,
  filterAdult: true,
  timeoutMs: 15_000,
});

const elapsed = Date.now() - started;
console.log(`\n探测 ${results.length} 个分类，耗时 ${elapsed}ms\n`);
console.log('顺序 | 分类 | 可用 | 有内容的源数 | 样本');
console.log('-----|------|------|--------------|------');
for (const r of results) {
  const label = categoryLabel(r.key);
  console.log(
    `${String(HOME_CATEGORIES.findIndex((c) => c.key === r.key) + 1).padStart(4)} | ${label.padEnd(4)} | ${
      r.available ? ' ✅ ' : ' ❌ '
    } | ${String(r.hits).padStart(12)} | ${r.sample?.name ?? '-'}`
  );
}

const visible = results.filter((r) => r.available).map((r) => categoryLabel(r.key));
const hidden = results.filter((r) => !r.available).map((r) => categoryLabel(r.key));
console.log(`\n首页会显示：${visible.join('、') || '（无）'}`);
console.log(`首页会隐藏：${hidden.join('、') || '（无）'}`);
console.log(`\n前两位是否为电影/电视剧：${results[0]?.key === 'movie' && results[1]?.key === 'tv' ? '是' : '否'}`);
