/**
 * 成人内容屏蔽的**真实源实测**（不是单测，跑真实采集站）。
 *
 * 用法：npx vite-node tools/audit/adult-filter-live.ts
 *
 * 目的：验证 filterAdultResults 在真实数据上是否真的挡住了内容，
 * 并统计「漏网」样本，用于补充关键词。
 */
import { createFetchHttp, filterAdultResults, isAdultContent, searchSources, browseCategory } from '../../packages/core/src/index';
import type { SourceConfig, SearchResultItem } from '../../packages/core/src/types';

const SOURCES: SourceConfig[] = [
  { key: 'ffzy', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lz', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'modu', name: '魔都资源', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360', name: '360资源', url: 'https://www.360zy.com/api.php/provide/vod' },
];

const http = createFetchHttp();

interface Row {
  source: string;
  typeName: string;
  name: string;
}

async function main() {
  // —— 1. 直接抓每个源的全部分类，找出成人类目 ——
  console.log('=== 1. 各源分类表里的成人类目 ===');
  const adultTypeNames = new Set<string>();
  const allTypeNames = new Set<string>();

  for (const source of SOURCES) {
    try {
      const res = await http.request(`${source.url.replace(/\/+$/, '')}?ac=list&pg=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeoutMs: 15000,
      });
      const json = JSON.parse(res.text) as { class?: Array<{ type_id: number; type_name: string; type_pid: number }> };
      const classes = json.class ?? [];
      console.log(`\n[${source.name}] ${classes.length} 个分类`);
      for (const c of classes) {
        allTypeNames.add(c.type_name);
        const hit = isAdultContent(c.type_name);
        if (hit) adultTypeNames.add(c.type_name);
        console.log(`  ${hit ? '🚫 命中' : '  放行'}  id=${c.type_id}  ${c.type_name}`);
      }
    } catch (err) {
      console.log(`[${source.name}] 拉分类失败：${err instanceof Error ? err.message : err}`);
    }
  }

  // —— 2. 用几个"敏感词"搜索，看过滤前后数量 ——
  console.log('\n\n=== 2. 敏感词搜索：过滤前 vs 过滤后 ===');
  const probes = ['伦理', '福利', '无码', '自拍', '主播', '麻豆', '三级', '蜜桃', '黑料'];
  const leaked: Row[] = [];

  for (const wd of probes) {
    try {
      const result = await searchSources({ wd, sources: SOURCES, http, filterAdult: false, maxPages: 1, timeoutMs: 15000 });
      const raw = result.list;
      const kept = filterAdultResults(raw, true);
      const blocked = raw.length - kept.length;
      if (raw.length > 0) {
        console.log(`  "${wd}": 原始 ${raw.length} 条，屏蔽 ${blocked} 条，保留 ${kept.length} 条`);
      }
      // 记录"看起来像成人内容但被保留"的
      for (const item of kept) {
        if (/伦理|福利|无码|有码|自拍|偷拍|主播|麻豆|传媒|三级|蜜桃|黑料|里番|门事件|午夜|催情|裸|情色|色情|成人|限制级|A片/i.test(item.name)) {
          leaked.push({ source: item.sourceName ?? '-', typeName: item.typeName ?? '-', name: item.name });
        }
      }
    } catch (err) {
      console.log(`  "${wd}" 搜索失败：${err instanceof Error ? err.message : err}`);
    }
  }

  // —— 3. 分类浏览：电影桶里是否混入成人内容 ——
  console.log('\n\n=== 3. 分类浏览（电影 / 其他）过滤前后 ===');
  for (const key of ['movie', 'other'] as const) {
    for (const filter of [false, true]) {
      try {
        const result = await browseCategory({ sources: SOURCES, key, http, filterAdult: filter, pages: 1 });
        const adultType = result.items.filter((i) => isAdultContent(i.typeName));
        console.log(
          `  ${key} filterAdult=${String(filter).padEnd(5)} -> ${String(result.items.length).padStart(4)} 条` +
            (filter ? `  (其中成人类型 ${adultType.length})` : `  (其中成人类型 ${adultType.length})`)
        );
        if (filter && adultType.length > 0) {
          for (const a of adultType.slice(0, 5)) {
            console.log(`     ❌ 漏网: ${a.name} [${a.typeName}]`);
          }
        }
      } catch (err) {
        console.log(`  ${key} filter=${filter} 失败：${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // —— 4. 结论 ——
  console.log('\n\n=== 4. 结论 ===');
  console.log(`采集站出现过的分类名（去重 ${allTypeNames.size} 个）：`);
  console.log('  ' + [...allTypeNames].join(' / '));
  console.log(`\n被 ADULT_KEYWORDS 命中的分类名：${[...adultTypeNames].join(' / ') || '（无）'}`);

  const missedTypes = [...allTypeNames].filter((t) =>
    /伦理|福利|无码|有码|自拍|偷拍|主播|麻豆|传媒|三级|蜜桃|黑料|里番|门事件|午夜|催情|情色|色情|成人|限制|写真|热舞|丝袜|少女/i.test(t) && !isAdultContent(t)
  );
  console.log(`\n疑似成人但**未被关键词命中**的分类名（需补词）：${missedTypes.join(' / ') || '（无）'}`);

  if (leaked.length > 0) {
    console.log(`\n⚠️ 标题疑似成人但被放行 ${leaked.length} 条（前 15）：`);
    for (const row of leaked.slice(0, 15)) console.log(`   [${row.typeName}] ${row.name}  <${row.source}>`);
  } else {
    console.log('\n✅ 未发现标题疑似成人却放行的结果');
  }
}

main().catch((err) => {
  console.error('实测脚本失败：', err);
  process.exit(1);
});
