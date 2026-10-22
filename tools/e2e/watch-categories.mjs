/**
 * 冷启动时高频轮询首页分类区，抓「短暂错误态」。
 *
 * 单测覆盖不到这类问题：它只在启动的头几百毫秒里出现，
 * 靠人眼看截图会漏掉。这里 reload 后每 25ms 取一次文字，把变化序列打出来。
 *
 * 用法：node tools/e2e/watch-categories.mjs [轮询毫秒数]
 */
import { connect, evaluate } from './cdp.mjs';

const totalMs = Number(process.argv[2] ?? 4000);
const session = await connect();
try {
  await session.send('Page.enable');
  await session.send('Page.reload', { ignoreCache: true });

  const started = Date.now();
  const seen = [];
  while (Date.now() - started < totalMs) {
    const state = await evaluate(
      session,
      `const bar = document.querySelector('.category-bar');
       if (!bar) return 'NOBAR';
       const btns = bar.querySelectorAll('.category-btn').length;
       const text = (bar.textContent || '').trim();
       return btns + '|' + text;`
    );
    const last = seen[seen.length - 1];
    if (!last || last.state !== state) {
      seen.push({ at: Date.now() - started, state });
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  for (const entry of seen) console.log(`${String(entry.at).padStart(5)}ms  ${entry.state}`);
} finally {
  session.ws.close();
}
