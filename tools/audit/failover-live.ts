/**
 * 在真实采集站上验证「多源自动换源」链路。
 *
 * 场景：用户从某个源点开影片，而该源其实已经挂了（详情接口返回空 / 超时）。
 * 期望：自动切到同片的其它源，用户仍然能播，而不是看到「播放失败」。
 *
 * 用法：npx vite-node tools/audit/failover-live.ts [片名]
 */
import {
  buildPlaybackCandidates,
  candidateKey,
  candidateLabel,
  createFetchHttp,
  discoverCandidates,
  fetchDetail,
  firstPlayableCandidate,
  searchSources,
  type PlaybackCandidate,
  type SourceConfig,
} from '../../packages/core/src/index';

const sources: SourceConfig[] = [
  { key: 'ffzy', name: '非凡资源', url: 'https://api.ffzyapi.com/api.php/provide/vod' },
  { key: 'lziapi', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' },
  { key: 'moduapi', name: '魔都资源', url: 'https://caiji.moduapi.cc/api.php/provide/vod' },
  { key: '360zy', name: '360资源', url: 'https://www.360zy.com/api.php/provide/vod' },
];

const http = createFetchHttp();
const keyword = process.argv[2] ?? '沙丘';
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length));

console.log(`\n=== 1. 搜索「${keyword}」 ===`);
const t0 = Date.now();
const result = await searchSources({ wd: keyword, sources, http, maxPages: 1, timeoutMs: 12_000 });
const items = result.list;
console.log(`  聚合 ${items.length} 条，耗时 ${Date.now() - t0}ms`);
for (const o of result.outcomes) {
  console.log(`  ${pad(o.sourceName, 10)} ${o.ok ? `✅ ${o.list.length} 条` : `❌ ${o.error ?? '失败'}`} ${o.ms}ms`);
}
if (items.length === 0) {
  console.log('\n没有搜到结果，换一个片名再试。');
  process.exit(0);
}

console.log('\n=== 2. 构造候选链 ===');
const first = items[0];
const chain = buildPlaybackCandidates(items, sources, { active: { sourceKey: first.sourceKey, vodId: first.vodId } });
console.log(`  候选 ${chain.length} 个：${chain.map((c) => candidateLabel(c)).join(' → ')}`);

console.log('\n=== 3. 模拟首个源失效后自动换源 ===');
// 把首个候选的来源地址改成一个必定失败的域名，其余保持不变
const broken: PlaybackCandidate = {
  ...chain[0],
  source: { ...chain[0].source, url: 'https://failover-probe.invalid/api.php/provide/vod' },
};
const tried = new Set<string>([]);
const t1 = Date.now();
try {
  const best = await firstPlayableCandidate([broken, ...chain.slice(1)], http, {
    timeoutMs: 8_000,
    onSkip: (candidate, error) => {
      tried.add(candidate.key);
      console.log(`  跳过「${candidateLabel(candidate)}」：${error.message.slice(0, 60)}`);
    },
  });
  console.log(`\n  ✅ 换源成功：${candidateLabel(best.candidate)}，耗时 ${Date.now() - t1}ms`);
  console.log(`     集数 ${best.detail.episodes.length}，首集 ${best.detail.episodes[0]?.slice(0, 70)}`);
  console.log(`     原第 4 集在新源对齐为第 ${best.index + 1} 集`);
  console.log(`     线路类型 ${/\.m3u8/i.test(best.detail.episodes[best.index] ?? '') ? 'HLS' : '直链'}`);
} catch (err) {
  console.log(`\n  ❌ 全部候选失败：${err instanceof Error ? err.message : String(err)}`);
}

console.log('\n=== 4. 单源场景：按片名反查补充候选 ===');
// 用户从「观看记录」进入时只有一个源，这里模拟它彻底不可用
const title = first.name;
const t2 = Date.now();
const extra = await discoverCandidates(title, sources, http, {
  exclude: new Set(chain.map((c) => `${c.sourceKey}:${c.vodId}`)),
  timeoutMs: 10_000,
});
console.log(`  按「${title}」反查，新增 ${extra.length} 个候选，耗时 ${Date.now() - t2}ms`);
for (const c of extra.slice(0, 5)) console.log(`   + ${candidateLabel(c)}`);
if (extra.length === 0) {
  console.log('   （该片名已被现有候选全部覆盖，或其它源确实没有这部片）');
}

console.log('\n=== 5. 详情接口耗时（换源时的额外开销） ===');
const sample = chain[0];
const t3 = Date.now();
try {
  const detail = await fetchDetail(sample.source, sample.vodId, http);
  console.log(`  ${candidateLabel(sample)} 详情 ${Date.now() - t3}ms，${detail.episodes.length} 集`);
} catch (err) {
  console.log(`  ${candidateLabel(sample)} 详情失败 ${Date.now() - t3}ms：${(err as Error).message}`);
}
