// 验证「切分类读缓存」与「检索读缓存」：
//   1. 清空 localStorage 里的目录/检索缓存
//   2. 进分类页，记录首次加载耗时
//   3. 切到别的分类再切回来，记录第二次耗时（应显著更快）
//   4. 搜索一个词两次，记录两次耗时
// 用法：node tools/e2e/catalog-cache.mjs
import { connect, evaluate, shot } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 predicate 为真或超时 */
async function waitFor(s, expr, timeoutMs = 30_000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(s, expr);
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
    // 不关 WebSocket 进程不会退出（Node 会等句柄），CLI 会看起来「卡住」
    session.ws.close();
  }
}

async function run(session) {
  // 清掉缓存，保证第一次是冷的
  await evaluate(
    session,
    `localStorage.removeItem('libretv-catalog-v1');
     localStorage.removeItem('libretv-search-cache-v1');
     return 'cleared';`
  );

  // 先回首页：上一轮 e2e 可能把界面留在搜索页/播放页
  await evaluate(
    session,
    `const b = [...document.querySelectorAll('.rail-btn')].find((x) => (x.getAttribute('title') || '').includes('首页'));
     if (b) b.click();
     return !!b;`
  );

  // 首页分类按钮要等探测（约 8 秒）跑完才出现
  const buttons = await waitFor(
    session,
    `const btns = [...document.querySelectorAll('.category-btn')];
     return { done: btns.length > 0, seen: btns.map((b) => b.textContent) };`,
    40_000,
    200
  );

  if (!buttons.done) {
    console.log('首页还没出现分类按钮，当前：', JSON.stringify(buttons.seen));
    return;
  }
  console.log('首页分类按钮：', JSON.stringify(buttons.seen));

  await evaluate(
    session,
    `const btns = [...document.querySelectorAll('.category-btn')];
     const target = btns.find((b) => b.textContent.includes('电影'));
     target.click();
     return 'ok';`
  );

  const first = await waitFor(
    session,
    `const title = document.querySelector('.section-title span')?.textContent ?? '';
     const hint = document.querySelector('.section-title .hint')?.textContent ?? '';
     // 加载中会先渲染 12 个骨架占位卡（带 inline opacity），不能拿卡片数当完成信号
     const cards = [...document.querySelectorAll('.grid .card')].filter((c) => !c.getAttribute('style')).length;
     return { done: cards > 0 && !title.includes('加载中'), cards, title, hint };`,
    60_000
  );
  console.log('首次进分类：', JSON.stringify(first));

  // 切到电视剧
  await evaluate(
    session,
    `const b = [...document.querySelectorAll('.chip')].find((x) => x.textContent.trim() === '电视剧');
     if (b) b.click();
     return !!b;`
  );
  const tv = await waitFor(
    session,
    `const title = document.querySelector('.section-title span')?.textContent ?? '';
     const cards = [...document.querySelectorAll('.grid .card')].filter((c) => !c.getAttribute('style')).length;
     return { done: cards > 0 && title.includes('电视剧') && !title.includes('加载中'), cards, title };`,
    60_000
  );
  console.log('切到电视剧：', JSON.stringify(tv));

  // 切回电影：应当秒出（缓存）
  const t0 = Date.now();
  await evaluate(
    session,
    `const b = [...document.querySelectorAll('.chip')].find((x) => x.textContent.trim() === '电影');
     if (b) b.click();
     return !!b;`
  );
  const back = await waitFor(
    session,
    `const title = document.querySelector('.section-title span')?.textContent ?? '';
     const cards = [...document.querySelectorAll('.grid .card')].filter((c) => !c.getAttribute('style')).length;
     return { done: cards > 0 && title.includes('电影'), cards, title };`,
    30_000,
    25
  );
  console.log(`切回电影：${Date.now() - t0}ms`, JSON.stringify(back));
  await shot(session, '.tmp/cat-cache-back.png');

  // 检索两次
  const search = async (label) => {
    const started = Date.now();
    await evaluate(
      session,
      `const i = document.querySelector('.search-box input');
       const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       set.call(i, '沙丘');
       i.dispatchEvent(new Event('input', { bubbles: true }));
       document.querySelector('.search-box').requestSubmit();
       return 'ok';`
    );
    const got = await waitFor(
      session,
      `const hint = document.querySelector('.section-title .hint')?.textContent ?? '';
       const cards = document.querySelectorAll('.grid .card').length;
       return { done: cards > 0 && !hint.includes('搜索中'), cards, hint };`,
      40_000,
      40
    );
    console.log(`${label}：${Date.now() - started}ms`, JSON.stringify(got));
    return got;
  };

  await search('首次搜索');
  // 换个词再搜回来，确保不是「同一个 useEffect 没重跑」
  await evaluate(
    session,
    `const i = document.querySelector('.search-box input');
     const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     set.call(i, '沙丘2');
     i.dispatchEvent(new Event('input', { bubbles: true }));
     document.querySelector('.search-box').requestSubmit();
     return 'ok';`
  );
  await sleep(6000);
  await search('二次搜索（缓存）');
  await shot(session, '.tmp/cat-cache-search.png');

  const store = await evaluate(
    session,
    `const raw = localStorage.getItem('libretv-catalog-v1');
     const sraw = localStorage.getItem('libretv-search-cache-v1');
     const cat = raw ? JSON.parse(raw) : null;
     const sea = sraw ? JSON.parse(sraw) : null;
     return {
       catalogKeys: cat ? Object.keys(cat.entries ?? {}) : [],
       catalogCounts: cat ? Object.fromEntries(Object.entries(cat.entries ?? {}).map(([k, v]) => [k, v.items.length])) : {},
       catalogBytes: raw ? raw.length : 0,
       searchKeys: sea ? Object.keys(sea.entries ?? {}) : [],
       searchBytes: sraw ? sraw.length : 0,
     };`
  );
  console.log('落盘状态：', JSON.stringify(store));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
