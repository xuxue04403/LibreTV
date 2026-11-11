// 验证重启后「分类目录」「检索结果」是否直接命中已持久化的缓存。
// 前提：先跑过一次正常加载（缓存已落盘）。
// 用法：node tools/e2e/catalog-cache-warm.mjs
import { connect, evaluate, shot } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(session, expr, timeoutMs = 30_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(session, expr);
    if (last && last.done) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function main() {
  const session = await connect();
  try {
    await run(session);
  } finally {
    session.ws.close();
  }
}

async function run(session) {
  const before = await evaluate(
    session,
    `const raw = localStorage.getItem('librextv-catalog-v1');
     const cat = raw ? JSON.parse(raw) : null;
     return cat ? Object.keys(cat.entries ?? {}) : [];`
  );
  console.log('重启前的缓存分类：', JSON.stringify(before));
  if (before.length === 0) {
    console.log('没有缓存，先跑 catalog-cache.mjs');
    return;
  }

  // 进分类页并计时：内容应当「同步」出现，因为读的是 localStorage
  await evaluate(
    session,
    `const b = [...document.querySelectorAll('.rail-btn')].find((x) => (x.getAttribute('title') || '').includes('首页'));
     if (b) b.click();
     return !!b;`
  );
  await sleep(300);

  const started = Date.now();
  const clicked = await evaluate(
    session,
    `const btns = [...document.querySelectorAll('.category-btn')];
     const target = btns.find((b) => b.textContent.includes('电影'));
     if (!target) return { ok: false, seen: btns.map((b) => b.textContent) };
     target.click();
     return { ok: true };`
  );
  if (!clicked.ok) {
    console.log('分类按钮还没出现：', JSON.stringify(clicked.seen));
    return;
  }

  // 只要「真实卡片」（骨架卡带 inline style）
  const fresh = await waitFor(
    session,
    `const title = document.querySelector('.section-title span')?.textContent ?? '';
     const cards = [...document.querySelectorAll('.grid .card')].filter((c) => !c.getAttribute('style')).length;
     return { done: cards > 0, cards, title };`,
    30_000,
    20
  );
  const elapsed = Date.now() - started;
  console.log(`进电影分类：${elapsed}ms`, JSON.stringify(fresh), elapsed < 800 ? '✅ 缓存命中' : '⚠️ 偏慢');
  await shot(session, '.tmp/cat-cache-warm.png');

  // 检索也计时
  const searchStarted = Date.now();
  await evaluate(
    session,
    `const i = document.querySelector('.search-box input');
     const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     set.call(i, '沙丘');
     i.dispatchEvent(new Event('input', { bubbles: true }));
     document.querySelector('.search-box').requestSubmit();
     return 'ok';`
  );
  const search = await waitFor(
    session,
    `const hint = document.querySelector('.section-title .hint')?.textContent ?? '';
     const cards = document.querySelectorAll('.grid .card').length;
     return { done: cards > 0, cards, hint };`,
    30_000,
    20
  );
  console.log(`检索「沙丘」：${Date.now() - searchStarted}ms`, JSON.stringify(search));
  await shot(session, '.tmp/search-cache-warm.png');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
