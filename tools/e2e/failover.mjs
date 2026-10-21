/**
 * 端到端验证「多源自动换源」。
 *
 * 真机流程：搜索 → 打开详情 → 起播 → 手动换源 → 屏蔽当前 CDN 触发自动换源。
 * 之所以要跑真机而不是只跑单测：候选链、详情接口、播放器错误回调这三段
 * 分散在 core / 渲染层，单测只能覆盖其中一段。
 *
 * HLS 播放时 video.src 是 blob:，真实地址只能从网络请求里看，
 * 所以这里监听 Network.requestWillBeSent，从代理 URL 的 `u=` 参数还原上游地址。
 *
 * 前置：桌面端以 `--remote-debugging-port=9333` 启动。
 * 用法：node tools/e2e/failover.mjs [片名]
 */
import { connect, evaluate, shot } from './cdp.mjs';

const KEYWORD = process.argv[2] ?? '沙丘';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(...args);

/** 记录最近访问过的媒体地址（含代理还原后的上游地址） */
const requests = [];

/**
 * 代理把真实地址放在 `url=` 参数里（见 apps/desktop/src/main/proxy.ts）。
 * 判断播放的是哪个 CDN 必须还原上游，否则看到的永远是 127.0.0.1 本机代理，
 * 连屏蔽都会连自己一起屏蔽。
 */
function upstreamOf(url) {
  try {
    const parsed = new URL(url);
    const target = parsed.searchParams.get('url');
    return target ? decodeURIComponent(target) : url;
  } catch {
    return url;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** 当前正在播放的上游地址（取最近一次媒体请求） */
function currentUpstream() {
  const media = requests.filter((r) => /\.(m3u8|ts|m4s|mp4|flv|mpd)(\?|$)/i.test(upstreamOf(r)));
  return media.length ? upstreamOf(media[media.length - 1]) : '';
}

async function readPlayer(session) {
  return evaluate(
    session,
    `const v = document.querySelector('video');
     const err = document.querySelector('.player-loading div[style*="max-width"]');
     return {
       readyState: v ? v.readyState : null,
       paused: v ? v.paused : null,
       errorCode: v && v.error ? v.error.code : null,
       errorText: err ? err.textContent.trim().slice(0, 120) : null,
       sub: (document.querySelector('.player-sub') || {}).textContent || null,
     };`
  );
}

async function main() {
  const session = await connect();
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    session.on('Network.requestWillBeSent', (params) => {
      requests.push(params.request.url);
      if (requests.length > 400) requests.splice(0, 200);
    });

    // —— 搜索 ——
    await evaluate(
      session,
      `const input = document.querySelector('input[placeholder*=搜索]');
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(input, '');
       input.dispatchEvent(new Event('input', { bubbles: true }));
       input.focus();
       return 1;`
    );
    await sleep(200);
    await session.send('Input.insertText', { text: KEYWORD });
    await sleep(250);
    // 必须用 requestSubmit：直接 dispatchEvent('submit') 在 React 里不会走 onSubmit
    await evaluate(session, `document.querySelector('input[placeholder*=搜索]').closest('form').requestSubmit(); return 1;`);

    log(`搜索「${KEYWORD}」…`);
    const cards = await waitFor(
      session,
      `const ready = document.querySelectorAll('.card img').length; return ready >= 2 ? ready : 0;`,
      25_000
    );
    log(`  ${cards} 个结果`);

    const opened = await evaluate(
      session,
      `const card = [...document.querySelectorAll('.card')].find((c) => c.querySelector('img'));
       if (!card) return null;
       card.click();
       return (card.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50);`
    );
    log(`打开详情：${opened}`);
    await waitFor(session, `return document.querySelector('.detail') ? 1 : 0;`, 20_000).catch(() => 0);
    await sleep(3500);

    const badges = await evaluate(
      session,
      `const rows = [...document.querySelectorAll('.chip, .badge')].map((n) => n.textContent.trim()).filter(Boolean);
       return [...new Set(rows)].slice(0, 12);`
    );
    log(`  片源徽章：${badges.join(' / ') || '（无）'}`);

    // —— 起播 ——（文案随历史记录变化：「立即播放」/「继续播放 · 第 N 集」）
    const play = await evaluate(
      session,
      `const btn = [...document.querySelectorAll('.detail button')].find((b) => /播放/.test(b.textContent || ''));
       if (!btn) return { ok: false, labels: [...document.querySelectorAll('.detail button')].map((b) => b.textContent.trim()) };
       btn.click();
       return { ok: true, label: btn.textContent.trim() };`
    );
    if (!play.ok) throw new Error(`没找到播放按钮：${JSON.stringify(play.labels)}`);
    log(`  起播按钮：${play.label}`);

    const ready = await waitFor(
      session,
      `const v = document.querySelector('video');
       return v && v.readyState >= 3 && !v.paused ? v.readyState : 0;`,
      30_000
    );
    log(`起播成功，readyState=${ready}`);
    const before = currentUpstream();
    log(`  首个片源地址：${before.slice(0, 100)}`);
    log(`  ${JSON.stringify(await readPlayer(session))}`);
    await shot(session, 'D:/IDE/LibreTV/.tmp/e2e-1-playing.png');

    // —— 手动换源（S） ——
    // 用 DOM 派发而不是 CDP Input.dispatchKeyEvent：后台窗口收不到 CDP 的原始按键，
    // 而 window 上的 keydown 监听对派发事件同样生效。
    log('\n手动换源（按 S）…');
    const subBefore = (await readPlayer(session)).sub;
    await evaluate(
      session,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', bubbles: true }));
       return 1;`
    );
    // 换源要重新拉详情 + 解析，边等边看提示，别用固定 sleep 猜
    const switched = await waitFor(
      session,
      `const sub = (document.querySelector('.player-sub') || {}).textContent || '';
       return sub && sub !== ${JSON.stringify(subBefore)} ? sub : 0;`,
      30_000
    ).catch(() => '');
    log(`  片源行：${switched || '（未变化）'}`);

    const afterManual = await waitFor(
      session,
      `const v = document.querySelector('video');
       return v && v.readyState >= 3 && !v.paused ? v.readyState : 0;`,
      30_000
    ).catch(() => 0);
    const manualUrl = currentUpstream();
    log(`  换源后 readyState=${afterManual}`);
    log(`  新片源地址：${manualUrl.slice(0, 100)}`);
    log(`  ${JSON.stringify(await readPlayer(session))}`);
    log(`  片源是否变化：${manualUrl && manualUrl !== upstreamOf(before) ? '是' : '否'}`);
    await shot(session, 'D:/IDE/LibreTV/.tmp/e2e-2-manual.png');

    // —— 自动换源：屏蔽当前 CDN ——
    // 必须屏蔽上游 CDN 的域名。屏蔽 127.0.0.1 会把本机代理一起断掉，
    // 那样换到哪个源都播不了，验证结果会失真。
    const host = hostOf(manualUrl || upstreamOf(before));
    if (!host) throw new Error('拿不到上游地址，无法屏蔽');
    log(`\n自动换源：屏蔽 ${host} …`);
    await session.send('Network.setBlockedURLs', { urls: [`*${host}*`] });

    const self = await waitFor(
      session,
      `(() => {
         const v = document.querySelector('video');
         return v && v.readyState >= 3 && !v.paused ? 1 : 0;
       })()`,
      45_000
    ).catch(() => 0);

    const healedUrl = requests
      .map(upstreamOf)
      .filter((u) => /\.(m3u8|ts|m4s|mp4)(\?|$)/i.test(u) && !u.includes(host))
      .pop() ?? '';
    const healed = await readPlayer(session);
    log(`  换到的新 CDN：${healedUrl.slice(0, 100) || '（无）'}`);
    log(`  ${JSON.stringify(healed)}`);
    await shot(session, 'D:/IDE/LibreTV/.tmp/e2e-3-auto.png');

    await session.send('Network.setBlockedURLs', { urls: [] });

    // 判定要同时满足「换了片源」和「换完真的在播」：
    // 只看到新 CDN 的请求不代表播放成功，可能是又失败了一次
    const switchedAway = healedUrl && !healedUrl.includes(host);
    const playing = healed.readyState >= 3 && healed.paused === false && !healed.errorText;
    log(`\n片源已切换：${switchedAway ? '是' : '否'}；切换后正在播放：${playing ? '是' : '否'}`);
    const ok = switchedAway && playing;
    log(`结论：${ok ? '✅ 自动换源生效' : '❌ 未观察到自动换源'}`);
    if (!ok) process.exitCode = 1;
  } finally {
    session.ws.close();
  }
}

/** 反复求值直到返回真值 */
async function waitFor(session, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(session, expression);
    if (last) return last;
    await sleep(600);
  }
  throw new Error(`等待超时（${timeoutMs}ms），最后一次结果：${JSON.stringify(last)}`);
}

await main();
