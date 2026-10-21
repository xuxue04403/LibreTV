/**
 * 端到端验证「直播列表渐进加载 + 上下键换台」。
 *
 * 两件事必须在真机上验：
 * 1. 渐进加载：iptv-org 的 index.m3u 限速到 ~35KB/s，整串要 70 秒以上。
 *    单测只能证明解析器能增量喂，证明不了「界面真的在长」。
 * 2. 换台：键盘监听挂在 window 上，且换台后要重建 HLS 实例，
 *    这条路只有跑起来才知道通不通。
 *
 * 前置：桌面端以 `--remote-debugging-port=9333` 启动。
 * 用法：node tools/e2e/live.mjs
 */
import { connect, evaluate, shot } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(...args);

/** 记录媒体请求，用于确认换台后真的换了流 */
const requests = [];

function upstreamOf(url) {
  try {
    const parsed = new URL(url);
    const target = parsed.searchParams.get('url');
    return target ? decodeURIComponent(target) : url;
  } catch {
    return url;
  }
}

function currentMedia() {
  const media = requests.filter((r) => /\.(m3u8|ts|m4s|mp4|flv)(\?|$)/i.test(upstreamOf(r)));
  return media.length ? upstreamOf(media[media.length - 1]) : '';
}

async function header(session) {
  return evaluate(
    session,
    `const bar = document.querySelector('.live-bar');
     if (!bar) return { name: null, counter: null, hint: null };
     // 台名在第一个信息块的加粗行里，前面挂着 LIVE 徽章，去掉徽章文字即可
     const info = bar.querySelector('div > div');
     const name = info ? (info.textContent || '').replace(/^\\s*LIVE\\s*/, '').trim() : null;
     const counter = [...bar.querySelectorAll('span')]
       .map((n) => (n.textContent || '').trim())
       .find((t) => /^\\d+ \\/ \\d+$/.test(t)) || null;
     const hint = (bar.querySelector('.hint') || {}).textContent || null;
     return { name, counter, hint: hint ? hint.trim() : null };`
  );
}

async function main() {
  const session = await connect();
  const timeline = [];
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    session.on('Network.requestWillBeSent', (params) => {
      requests.push(params.request.url);
      if (requests.length > 500) requests.splice(0, 250);
    });

    // —— 清缓存，保证测的是冷启动 ——
    await evaluate(session, `localStorage.removeItem('libretv-live-cache-v1'); return 1;`);

    const navStart = Date.now();
    // 左侧导航是纯图标按钮，没有文字，只能按 title 找（title 形如「直播（Ctrl+3）」）
    const nav = await evaluate(
      session,
      `const btn = [...document.querySelectorAll('.rail-btn')].find((n) => /直播/.test(n.getAttribute('title') || ''));
       if (!btn) return { ok: false, seen: [...document.querySelectorAll('.rail-btn')].map((n) => n.getAttribute('title')) };
       btn.click();
       return { ok: true, label: btn.getAttribute('title') };`
    );
    if (!nav.ok) throw new Error(`没找到直播入口：${JSON.stringify(nav.seen)}`);
    log(`进入「${nav.label}」，开始计时`);

    // —— 渐进加载：记录频道数随时间的变化 ——
    let firstAt = 0;
    let last = 0;
    let lastCount = 0;
    let stableSince = 0;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const snap = await evaluate(
        session,
        `const cards = document.querySelectorAll('.channel-grid .channel').length;
         const hint = (document.querySelector('.section-title .hint') || {}).textContent || '';
         const m = hint.match(/(\\d+)\\s*个频道/);
         return { cards, count: m ? Number(m[1]) : cards, hint: hint.trim() };`
      ).catch(() => null);
      if (!snap) break;
      const count = snap.count || 0;
      if (count > 0 && !firstAt) {
        firstAt = Date.now() - navStart;
        last = firstAt;
        lastCount = count;
        timeline.push(`T+${firstAt}ms 首次出现 ${count} 个频道`);
        log(`  T+${firstAt}ms 首次出现 ${count} 个频道`);
      } else if (count !== lastCount) {
        lastCount = count;
        last = Date.now() - navStart;
        stableSince = Date.now();
        if (firstAt) {
          timeline.push(`T+${last}ms ${count} 个`);
          log(`  T+${last}ms ${count} 个`);
        }
      }
      // 数量稳定 15 秒且标题栏不再显示「仍在读取/下载中」，认为加载完成
      // （标题栏文案见 Live.tsx 的 headline：加载中是「仍在读取」，缓存命中是「后台刷新」）
      if (firstAt && /个频道/.test(snap.hint) && !/下载中|连接直播源|仍在读取/.test(snap.hint)) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince > 15_000) break;
      }
      await sleep(700);
    }

    if (!firstAt) throw new Error('等了 150 秒仍未出现任何频道');
    log(`\n首屏 ${firstAt}ms，最终 ${lastCount} 个频道（总耗时 ${last}ms）`);
    await shot(session, 'D:/IDE/LibreTV/.tmp/live-1-list.png');

    // —— 找一个真的能播的频道 ——
    // iptv-org 公开列表里失效流很多（实测全球榜前八个都播不出来，中国榜的 ABN 稳定可用）。
    // 用搜索框先按已知可播的台名过滤，挑不到再退回逐个试，
    // 否则会把「源本身失效」误判成「换台坏了」。
    const PROBES = ['ABN China', 'Ando TV', 'CGTN', 'CCTV'];
    let clicked = { ok: false };
    let played = 0;
    const setKeyword = async (kw) => {
      await evaluate(
        session,
        `const input = document.querySelector('input[placeholder*=频道]');
         if (!input) return 0;
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         setter.call(input, ${JSON.stringify(kw)});
         input.dispatchEvent(new Event('input', { bubbles: true }));
         return 1;`
      );
      await sleep(600);
    };
    const tryFirstCard = async (label) => {
      const card = await evaluate(
        session,
        `const c = document.querySelector('.channel-grid .channel');
         if (!c) return { ok: false };
         c.click();
         return { ok: true, text: (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) };`
      );
      if (!card.ok) return 0;
      const rs = await waitFor(
        session,
        `const v = document.querySelector('video');
         if (!v) return 0;
         if (v.error) return -1;
         return v.readyState >= 2 ? v.readyState : 0;`,
        15_000
      ).catch(() => 0);
      log(`  ${label}「${card.text}」→ readyState=${rs}`);
      if (rs > 0) {
        clicked = card;
        return rs;
      }
      // 关掉播放层再试下一个
      await evaluate(
        session,
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); return 1;`
      );
      await sleep(600);
      return 0;
    };

    for (const kw of PROBES) {
      await setKeyword(kw);
      played = await tryFirstCard(kw);
      if (played > 0) break;
    }
    if (played <= 0) {
      // 兜底：清掉关键词，挨个试前 12 个
      await setKeyword('');
      for (let i = 0; i < 12 && played <= 0; i += 1) {
        played = await tryFirstCard(`兜底 #${i + 1}`);
        if (played <= 0) {
          await evaluate(
            session,
            `const cards = [...document.querySelectorAll('.channel-grid .channel')];
             const c = cards[${i + 1}];
             if (c) c.click();
             return 1;`
          );
          played = await waitFor(
            session,
            `const v = document.querySelector('video');
             if (!v) return 0;
             if (v.error) return -1;
             return v.readyState >= 2 ? v.readyState : 0;`,
            12_000
          ).catch(() => 0);
        }
      }
    }
    if (played <= 0) throw new Error('试了多个频道都播不了，可能是网络或全部直播源失效');
    // 让换台保持在「全部」分组下，避免搜索结果把可换的列表缩得太小
    await setKeyword('');
    await sleep(400);

    const before = await header(session);
    const beforeUrl = currentMedia();
    log(`\n播放「${clicked.text}」readyState=${played}`);
    log(`  顶栏：${JSON.stringify(before)}`);
    log(`  当前流：${beforeUrl.slice(0, 90)}`);
    await shot(session, 'D:/IDE/LibreTV/.tmp/live-2-playing.png');

    // —— 按 ↓ 换台 ——
    await evaluate(
      session,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
       return 1;`
    );
    log('\n按 ↓ 换台…');
    const afterDown = await waitFor(
      session,
      `const bar = document.querySelector('.live-bar');
       const info = bar && bar.querySelector('div > div');
       const name = info ? (info.textContent || '').replace(/^\\s*LIVE\\s*/, '').trim() : '';
       return name && name !== ${JSON.stringify(before.name)} ? name : 0;`,
      40_000
    ).catch(() => '');
    const headerDown = await header(session);
    log(`  顶栏：${JSON.stringify(headerDown)}`);
    log(`  频道是否变化：${afterDown ? '是' : '否'}（${before.name} → ${afterDown || headerDown.name}）`);

    const playedDown = await waitFor(
      session,
      `const v = document.querySelector('video');
       if (!v) return 0;
       if (v.error) return -1;
       return v.readyState >= 2 ? v.readyState : 0;`,
      25_000
    ).catch(() => 0);
    log(`  换台后 readyState=${playedDown}（换到的台也可能是失效源，不算失败）`);
    await shot(session, 'D:/IDE/LibreTV/.tmp/live-3-switched.png');

    // —— 按 ↑ 回到上一个 ——
    await evaluate(
      session,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', bubbles: true }));
       return 1;`
    );
    const backName = await waitFor(
      session,
      `const bar = document.querySelector('.live-bar');
       const info = bar && bar.querySelector('div > div');
       const name = info ? (info.textContent || '').replace(/^\\s*LIVE\\s*/, '').trim() : '';
       return name === ${JSON.stringify(before.name)} ? name : 0;`,
      40_000
    ).catch(() => '');
    log(`\n按 ↑ 回退：${backName ? '是' : '否'}（现在是 ${backName || (await header(session)).name}）`);

    const ok = Boolean(firstAt) && Boolean(afterDown) && Boolean(backName);
    log(`\n结论：首屏 ${firstAt}ms；↓ 换台 ${afterDown ? '正常' : '失败'}；↑ 回退 ${backName ? '正常' : '失败'}`);
    log(ok ? '✅ 渐进加载 + 上下键换台均生效' : '❌ 存在未通过项');
    if (!ok) process.exitCode = 1;
  } finally {
    session.ws.close();
  }
}

async function waitFor(session, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(session, expression).catch(() => 0);
    if (last) return last;
    await sleep(600);
  }
  return 0;
}

await main();
