/**
 * 成人屏蔽的**精确**验证：不靠宽泛正则猜，直接打印真实字段。
 *
 * 用法：npx vite-node tools/audit/adult-filter-precise.ts
 *
 * 关键问题：filterAdultResults 只看 typeName。
 * 若采集站把成人内容放在普通分类下（标题隐晦），过滤会漏。
 * 这里要回答：真实数据里到底漏没漏、漏了多少、漏的是什么。
 */
import { createFetchHttp, filterAdultResults, isAdultContent, parseSearchList, ADULT_KEYWORDS } from '../../packages/core/src/index';
import type { SourceConfig } from '../../packages/core/src/types';

const SOURCES: SourceConfig[] = [
  { key: 'ffzy', name: '非凡', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lz', name: '量子', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'modu', name: '魔都', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360', name: '360', url: 'https://www.360zy.com/api.php/provide/vod' },
];

const http = createFetchHttp();

/** 严格成人词：只在"几乎不可能是正经内容"时才命中，避免"福利院""伦理学"误报 */
const HARD_ADULT = [
  '无码', '有码', '里番', '麻豆', '黑料', '门事件', '三级片', 'A片', '自拍偷拍',
  '国产自拍', '国产传媒', '蜜桃传媒', '果冻传媒', '天美传媒', '星空传媒', '91视频',
  '麻豆传媒', '成人片', '色情', '情色片', '限制级', '午夜剧场', '催情', '裸聊',
  '福利视频', '福利片', '伦理片', '韩国伦理', '日本伦理',
];

function hardHit(text: string | undefined): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const k of HARD_ADULT) if (lower.includes(k.toLowerCase())) return k;
  return null;
}

async function fetchCategory(source: SourceConfig, typeId: string, page = 1) {
  const base = source.url.replace(/\/+$/, '');
  const res = await http.request(`${base}?ac=videolist&t=${typeId}&pg=${page}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    timeoutMs: 20000,
  });
  return parseSearchList(JSON.parse(res.text), source);
}

async function main() {
  console.log('=== A. 「伦理片」分类（id=34）的真实内容与过滤效果 ===');
  for (const source of SOURCES) {
    try {
      const items = await fetchCategory(source, '34');
      if (items.length === 0) {
        console.log(`  [${source.name}] 该源无此分类或为空`);
        continue;
      }
      const kept = filterAdultResults(items, true);
      console.log(`  [${source.name}] 抓到 ${items.length} 条，过滤后 ${kept.length} 条`);
      console.log(`     样例 typeName: ${[...new Set(items.map((i) => i.typeName))].join(' / ')}`);
      if (kept.length > 0) {
        console.log(`     ❌ 漏网 ${kept.length} 条：`);
        for (const k of kept.slice(0, 5)) console.log(`        [${k.typeName}] ${k.name}`);
      } else {
        console.log('     ✅ 全部拦下');
      }
    } catch (err) {
      console.log(`  [${source.name}] 失败：${err instanceof Error ? err.message : err}`);
    }
  }

  console.log('\n\n=== B. 搜索敏感词：逐条看 typeName 是否被识别 ===');
  const probes = ['无码', '麻豆', '黑料', '里番', '三级', '蜜桃', '果冻', '天美', '星空', '91'];
  for (const wd of probes) {
    for (const source of SOURCES) {
      try {
        const base = source.url.replace(/\/+$/, '');
        const res = await http.request(`${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=1`, {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          timeoutMs: 15000,
        });
        const items = parseSearchList(JSON.parse(res.text), source);
        if (items.length === 0) continue;
        const kept = filterAdultResults(items, true);
        const blocked = items.length - kept.length;
        console.log(`\n  "${wd}" @ ${source.name}: ${items.length} 条 → 屏蔽 ${blocked} / 放行 ${kept.length}`);
        for (const k of kept.slice(0, 4)) {
          const tag = hardHit(k.name) ? '❌ 标题含硬成人词' : '✔ 标题无硬词';
          console.log(`     ${tag}  [${k.typeName}] ${k.name}`);
        }
      } catch {
        /* 单源失败忽略 */
      }
    }
  }

  console.log('\n\n=== C. 标题含硬成人词却被放行的样本（真实漏网） ===');
  const leaked: Array<{ typeName: string; name: string; from: string }> = [];
  for (const wd of [...probes, '伦理', '福利', '主播', '自拍', '偷拍', '成人', '情色']) {
    for (const source of SOURCES) {
      try {
        const base = source.url.replace(/\/+$/, '');
        const res = await http.request(`${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=1`, {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          timeoutMs: 15000,
        });
        const kept = filterAdultResults(parseSearchList(JSON.parse(res.text), source), true);
        for (const k of kept) {
          const hit = hardHit(k.name);
          if (hit) leaked.push({ typeName: k.typeName ?? '-', name: k.name, from: `${source.name}(${hit})` });
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (leaked.length === 0) {
    console.log('  ✅ 无：标题含硬成人词的条目全部被 typeName 规则拦下');
  } else {
    console.log(`  ⚠️ ${leaked.length} 条漏网：`);
    for (const l of leaked.slice(0, 20)) console.log(`     [${l.typeName}] ${l.name}  <${l.from}>`);
  }

  console.log('\n\n=== D. 当前关键词表 ===');
  console.log(`  共 ${ADULT_KEYWORDS.length} 个：${ADULT_KEYWORDS.join(' / ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
