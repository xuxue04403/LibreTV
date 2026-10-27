/**
 * 候选点播源质量评估：搜索 / 详情 / 分集 / 分类 / 真实播放地址，逐项打分。
 * 目标是把「名字不同但后端相同」的重复源识别出来，只留下真正新增且有价值的。
 *
 * 用法：npx vite-node tools/audit/source-quality.ts
 */

import { cmsRequestHeaders, parseSearchList } from '../../packages/core/src/cms';
import { fetchDetail } from '../../packages/core/src/detail';
import { createFetchHttp } from '../../packages/core/src/http';
import { fetchSourceCategories } from '../../packages/core/src/categories';
import type { SourceConfig } from '../../packages/core/src/types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const http = createFetchHttp();

/** 现有内置源（作为基线对照） */
const BASELINE: SourceConfig[] = [
  { key: 'b1', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'b2', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'b3', name: '魔都资源', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: 'b4', name: '360资源', url: 'https://www.360zy.com/api.php/provide/vod' },
];

/** 从订阅扫描里筛出来的候选（去掉明显已有别名后） */
const CANDIDATES: SourceConfig[] = [
  { key: 'c1', name: '电影天堂', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod' },
  { key: 'c2', name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod' },
  { key: 'c3', name: '百度资源', url: 'https://api.apibdzy.com/api.php/provide/vod' },
  { key: 'c4', name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod' },
  { key: 'c5', name: '红牛资源', url: 'https://www.hongniuzy2.com/api.php/provide/vod' },
  { key: 'c6', name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod' },
  { key: 'c7', name: '建安资源', url: 'http://154.219.117.232:9981/jacloudapi.php/provide/vod' },
  { key: 'c8', name: '非凡(ffzy.tv)', url: 'http://ffzy.tv/api.php/provide/vod' },
  { key: 'c9', name: '非凡(ffzy5.tv)', url: 'http://ffzy5.tv/api.php/provide/vod' },
];

const KEYWORDS = ['沙丘', '庆余年', '流浪地球'];

interface Score {
  source: SourceConfig;
  searchOk: number;
  searchTotal: number;
  firstMs: number;
  detailOk: boolean;
  episodes: number;
  m3u8: number;
  categories: number;
  sampleTitle: string;
  sampleEpisode: string;
  err?: string;
  /** 用于识别重复后端：首条搜索结果的 vod_id 集合 */
  vodIds: string[];
  /** 详情页里出现的媒体域名，同源别名会一模一样 */
  mediaHosts: string[];
}

async function evaluate(source: SourceConfig): Promise<Score> {
  const score: Score = {
    source,
    searchOk: 0,
    searchTotal: KEYWORDS.length,
    firstMs: 0,
    detailOk: false,
    episodes: 0,
    m3u8: 0,
    categories: 0,
    sampleTitle: '',
    sampleEpisode: '',
    vodIds: [],
    mediaHosts: [],
  };

  let firstItem: ReturnType<typeof parseSearchList>[number] | undefined;
  for (const [i, wd] of KEYWORDS.entries()) {
    const started = Date.now();
    try {
      const res = await http.request(`${source.url}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=1`, {
        timeoutMs: 15_000,
        headers: cmsRequestHeaders(),
      });
      if (!res.text.trim().startsWith('{')) {
        score.err = `非 JSON：${res.text.slice(0, 20)}`;
        continue;
      }
      const items = parseSearchList(JSON.parse(res.text), source);
      if (items.length > 0) {
        score.searchOk += 1;
        if (i === 0) score.firstMs = Date.now() - started;
        for (const it of items.slice(0, 5)) score.vodIds.push(it.vodId);
        firstItem ??= items.find((it) => /沙丘|庆余年|流浪地球/.test(it.name)) ?? items[0];
      }
    } catch (err) {
      score.err = err instanceof Error ? err.message : String(err);
    }
  }

  try {
    const cats = await fetchSourceCategories(source, http, { timeoutMs: 15_000 });
    score.categories = cats.length;
  } catch {
    score.categories = 0;
  }

  if (firstItem) {
    score.sampleTitle = firstItem.name;
    try {
      const detail = await fetchDetail(source, firstItem.vodId, http, { timeoutMs: 15_000 });
      score.detailOk = detail.episodes.length > 0;
      score.episodes = detail.episodes.length;
      score.m3u8 = detail.episodes.filter((u) => /\.m3u8/i.test(u)).length;
      score.sampleEpisode = detail.episodes[0] ?? '';
      for (const ep of detail.episodes.slice(0, 5)) {
        try {
          score.mediaHosts.push(new URL(ep).host);
        } catch {
          /* 忽略非法地址 */
        }
      }
    } catch (err) {
      score.err = `详情：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return score;
}

async function main() {
  const all = [...BASELINE, ...CANDIDATES];
  const results: Score[] = [];
  for (const source of all) {
    const score = await evaluate(source);
    results.push(score);
    console.log(
      `\n${source.name.padEnd(14)} 搜索 ${score.searchOk}/${score.searchTotal}  首响 ${score.firstMs}ms  分类 ${score.categories}  分集 ${score.episodes}（m3u8 ${score.m3u8}）${score.err ? `  错误：${score.err}` : ''}`
    );
    if (score.sampleTitle) console.log(`  样例「${score.sampleTitle}」 ${score.sampleEpisode.slice(0, 90)}`);
    if (score.mediaHosts.length) console.log(`  媒体域名：${[...new Set(score.mediaHosts)].join(', ')}`);
    if (score.vodIds.length) console.log(`  vod_ids：${score.vodIds.slice(0, 6).join(',')}`);
  }

  console.log('\n=========== 重复后端判定（vod_id 有交集即视为同一后端）===========');
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const a = new Set(results[i].vodIds);
      const dup = results[j].vodIds.filter((id) => a.has(id));
      if (dup.length >= 3) {
        console.log(`  ${results[i].source.name}  ≈  ${results[j].source.name}   共同 vod_id ${dup.length} 个`);
      }
    }
  }
  console.log('\n（同后端但 vod_id 不同 → 看媒体域名是否相同）');
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      const ha = new Set(results[i].mediaHosts);
      const dup = results[j].mediaHosts.filter((h) => ha.has(h));
      if (dup.length >= 2) {
        console.log(`  ${results[i].source.name}  ≡  ${results[j].source.name}   共同媒体域名 ${[...new Set(dup)].join(',')}`);
      }
    }
  }
}

void main();
