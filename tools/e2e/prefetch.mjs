/**
 * 端到端验证「点播即预取」。
 *
 * 要证明的是：真起播的路径上，代理真的先跑了 /prefetch，而且预取早于首个分片请求。
 * 单测只能证明代理接口本身可用，证明不了渲染层有没有真的去调它。
 *
 * 前置：mock CMS 跑在 8099（`node tools/mock-cms/server.mjs 8099`），
 *       桌面端以 `--remote-debugging-port=9333` + `LTV_ALLOW_PRIVATE_MEDIA=1` 启动。
 * 用法：node tools/e2e/prefetch.mjs   （关键字可用 PREFETCH_KEYWORD 覆盖）
 */
import { connect, evaluate, evaluateAsync } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => {
  console.log(...args);
};

const KEYWORD = process.env.PREFETCH_KEYWORD || '流浪地球';

const session = await connect();

/** 收集所有 /prefetch 与 /p 请求，按发生顺序排列 */
const calls = [];
session.on('Network.requestWillBeSent', (params) => {
  const url = params.request.url;
  if (url.includes('/prefetch?')) calls.push({ kind: 'prefetch', at: Date.now(), url });
  else if (url.includes('/p?')) calls.push({ kind: 'media', at: Date.now(), url });
});

await session.send('Network.enable');
await session.send('Page.enable');

// 1) 进搜索页（左侧导航按钮只有图标，只能按 title 匹配）
await evaluate(
  session,
  `const btn = [...document.querySelectorAll('.rail-btn')].find((b) => /搜索/.test(b.getAttribute('title') || ''));
   if (!btn) return false;
   btn.click();
   return true;`
);
await sleep(800);

// 2) 输入关键字并提交（直接改 value 不触发 React onChange，必须走原生 setter）
const started = Date.now();
await evaluate(
  session,
  `const input = document.querySelector('.search-box input');
   const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
   setter.call(input, ${JSON.stringify(KEYWORD)});
   input.dispatchEvent(new Event('input', { bubbles: true }));
   document.querySelector('.search-box').requestSubmit();
   return true;`
);

let cards = 0;
for (let i = 0; i < 40; i += 1) {
  cards = await evaluate(session, `return document.querySelectorAll('.grid .card').length;`);
  if (cards > 0) break;
  await sleep(500);
}
log(`搜索结果 ${cards} 条，耗时 ${Date.now() - started}ms`);
if (cards === 0) {
  log('❌ 没有搜索结果，后面的验证无意义');
  process.exit(1);
}

// 3) 打开第一张卡片的详情
// 搜索是边收边渲染的，列表可能在点击瞬间被替换掉，所以点不到就重试
let hasDetail = false;
for (let attempt = 0; attempt < 8 && !hasDetail; attempt += 1) {
  await evaluate(session, `const c = document.querySelector('.grid .card'); if (c) c.click(); return 1;`);
  for (let i = 0; i < 8; i += 1) {
    hasDetail = await evaluate(
      session,
      `return !!(document.querySelector('.detail') && document.querySelector('.detail .btn.primary'));`
    );
    if (hasDetail) break;
    await sleep(250);
  }
}
if (!hasDetail) {
  log('❌ 详情面板没有出现');
  process.exit(1);
}

// 4) 点「立即播放 / 继续播放」，从这里开始记录请求顺序
// 详情面板刚出现时按钮可能还是 disabled（详情还在拉），必须等到可点再点
const before = calls.length;
let playClicked = false;
for (let attempt = 0; attempt < 20 && !playClicked; attempt += 1) {
  playClicked = await evaluate(
    session,
    `const btn = document.querySelector('.detail .btn.primary');
     if (!btn || btn.disabled) return false;
     btn.click();
     return true;`
  );
  if (!playClicked) await sleep(300);
}
log(`点击播放：${playClicked}`);
if (!playClicked) process.exit(1);

// 5) 等起播
// 采集站返回的流首片常常要几秒才有响应，30 秒不够；给 90 秒。
let state = null;
for (let i = 0; i < 180; i += 1) {
  state = await evaluate(
    session,
    `const v = document.querySelector('video');
     return { readyState: v ? v.readyState : 0, paused: v ? v.paused : null, src: v ? v.currentSrc.slice(0, 8) : '' };`
  );
  if (state.readyState >= 2) break;
  await sleep(500);
}
log(`起播 ${JSON.stringify(state)}，总耗时 ${Date.now() - started}ms`);

// 6) 直接问代理：预取缓存里现在有多少分片
// 预热是代理在返回 m3u8 时自己触发的，所以「显式 /prefetch 先于媒体」不再是判据；
// 真正的判据是缓存里确实有东西，且起播发生在它之后。
await sleep(1500);
const stats = await evaluateAsync(
  session,
  `const info = await window.libretv.info();
   const base = info && info.proxyBase ? info.proxyBase : '';
   if (!base) return null;
   const res = await fetch(base + '/stats');
   return await res.json();`
);
log(`代理缓存：${JSON.stringify(stats)}`);

// 失败时把现场打出来：光看「起播 readyState=0」没法判断是播放页没开、
// 还是开了但一直卡在加载（两种情况修法完全不同）
if (!state || state.readyState < 2) {
  const diag = await evaluate(
    session,
    `const v = document.querySelector('video');
     return { player: !!document.querySelector('.player-page'),
              sub: (document.querySelector('.player-sub') || {}).textContent || '',
              overlay: (document.querySelector('.player-loading') || {}).textContent || '',
              view: (document.querySelector('.rail-btn.active') || {}).title || '' };`
  );
  log(`现场：${JSON.stringify(diag)}`);
}

const fresh = calls.slice(before);
const prefetchCalls = fresh.filter((c) => c.kind === 'prefetch');
const mediaCalls = fresh.filter((c) => c.kind === 'media');
log(`本轮请求：prefetch ${prefetchCalls.length} 个 / media ${mediaCalls.length} 个`);

const warmed = Boolean(stats && stats.segments > 0);
log(warmed ? `✅ 代理已预热 ${stats.segments} 个分片（${(stats.bytes / 1048576).toFixed(1)} MB）` : '❌ 代理缓存是空的，预热没生效');

const ok = state.readyState >= 2 && warmed;
log(ok ? '✅ 点播即预取链路成立' : '⚠️ 链路有缺口，见上面各项');
process.exit(ok ? 0 : 1);
