/**
 * 强化后规则的回归验证：真实数据上跑一遍，看漏网是否消失、误伤是否出现。
 *
 * 用法：npx vite-node tools/audit/adult-filter-verify.ts
 */
import {
  createFetchHttp,
  filterAdultResults,
  isAdultContent,
  parseSearchList,
  filterAdultChannels,
  ADULT_KEYWORDS,
  ADULT_TITLE_KEYWORDS,
} from '../../packages/core/src/index';
import type { SourceConfig, LiveChannel } from '../../packages/core/src/types';

const SOURCES: SourceConfig[] = [
  { key: 'ffzy', name: '非凡', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lz', name: '量子', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'modu', name: '魔都', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360', name: '360', url: 'https://www.360zy.com/api.php/provide/vod' },
];

const http = createFetchHttp();

/** 真成人样本（必须被拦） */
const MUST_BLOCK: Array<[string, string]> = [
  ['爱情片', '我的23岁之无码青春'],
  ['台湾剧', '麻豆小镇'],
  ['短剧', '黑料局中局'],
  ['电影解说', '情色片编年史[电影解说]'],
  ['伦理片', '任何伦理片'],
  ['剧情片', '三级片之王'],
];

/** 必须放行的正经内容（不能被误伤） */
const MUST_PASS: Array<[string, string]> = [
  ['剧情片', '福利院的阳光'],
  ['大陆综艺', '披荆斩棘2026'],
  ['爱情片', '星空'],
  ['国产动漫', '吞噬星空'],
  ['日韩动漫', '果冻三剑客'],
  ['电影解说', '天降美食[电影解说]'],
  ['剧情片', '911事件'],
  ['日韩动漫', '91天'],
  ['剧情片', '愤怒的伦理学'],
  ['台湾剧', '麻豆小镇'], // 注：这个是标题里带「麻豆」，靠标题表不拦（已刻意排除该词）
];

async function main() {
  console.log('=== 1. 规则自检：必须拦的样本 ===');
  let blockFail = 0;
  for (const [type, name] of MUST_BLOCK) {
    const hit = isAdultContent(type, name);
    if (!hit) {
      blockFail++;
      console.log(`  ❌ 未拦住  [${type}] ${name}`);
    } else {
      console.log(`  ✅ 拦住    [${type}] ${name}`);
    }
  }

  console.log('\n=== 2. 规则自检：必须放行的样本（误伤检查） ===');
  let passFail = 0;
  for (const [type, name] of MUST_PASS) {
    const hit = isAdultContent(type, name);
    if (hit) {
      passFail++;
      console.log(`  ❌ 误伤    [${type}] ${name}`);
    } else {
      console.log(`  ✅ 放行    [${type}] ${name}`);
    }
  }

  console.log('\n=== 3. 真实源：分类「伦理片」是否仍被全部拦下 ===');
  for (const source of SOURCES) {
    try {
      const base = source.url.replace(/\/+$/, '');
      const res = await http.request(`${base}?ac=videolist&t=34&pg=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        timeoutMs: 20000,
      });
      const items = parseSearchList(JSON.parse(res.text), source);
      if (items.length === 0) continue;
      const kept = filterAdultResults(items, true);
      const types = [...new Set(items.map((i) => i.typeName))].join('/');
      console.log(`  [${source.name}] ${items.length} 条 (分类名 ${types}) → 保留 ${kept.length}`);
    } catch {
      /* 单源失败忽略 */
    }
  }

  console.log('\n=== 4. 真实源：敏感词搜索的屏蔽效果 ===');
  for (const wd of ['无码', '麻豆', '黑料', '情色', '三级', '伦理']) {
    let raw = 0;
    let blocked = 0;
    for (const source of SOURCES) {
      try {
        const base = source.url.replace(/\/+$/, '');
        const res = await http.request(`${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=1`, {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          timeoutMs: 15000,
        });
        const items = parseSearchList(JSON.parse(res.text), source);
        raw += items.length;
        blocked += items.length - filterAdultResults(items, true).length;
      } catch {
        /* ignore */
      }
    }
    console.log(`  "${wd}": 共 ${raw} 条，屏蔽 ${blocked} 条`);
  }

  console.log('\n=== 5. 直播频道过滤自检 ===');
  const demo: Array<Pick<LiveChannel, 'name' | 'group' | 'tvgId'>> = [
    { name: 'CCTV-1', group: '央视', tvgId: 'cctv1' },
    { name: '湖南卫视', group: '卫视', tvgId: 'hunan' },
    { name: 'Hot Adult 18+', group: '成人', tvgId: 'adult1' },
    { name: '午夜剧场', group: '未分组', tvgId: 'x' },
    { name: 'Playboy TV', group: '未分组', tvgId: 'pb' },
    { name: 'Discovery', group: '纪录片', tvgId: 'disc' },
  ];
  const keptChannels = filterAdultChannels(demo as LiveChannel[], true);
  console.log(`  输入 ${demo.length} 个频道 → 保留 ${keptChannels.length}：${keptChannels.map((c) => c.name).join(' / ')}`);

  console.log('\n=== 6. 结论 ===');
  console.log(`  成人分类词 ${ADULT_KEYWORDS.length} 个，标题词 ${ADULT_TITLE_KEYWORDS.length} 个`);
  console.log(`  必拦样本失败 ${blockFail} 个，误伤 ${passFail} 个`);
  if (blockFail === 0 && passFail === 0) console.log('  ✅ 规则自检全部通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
