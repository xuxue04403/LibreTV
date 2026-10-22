/**
 * 在多个窗口宽度下量测布局（只量数据，不截图）。
 *
 * PC 端最小窗口是 1024×640（`apps/desktop/src/main/index.ts` 的 minWidth/minHeight）。
 * 设置页表单是 flex-wrap 的，窄窗口下会不会把输入框挤成不可用只能实测——
 * 单测和类型检查都看不出来。用 CDP 的 Emulation 覆盖视口，不必真的拖窗口。
 *
 * 用法：node tools/e2e/resize.mjs <宽度,宽度,...>
 */
import { connect, evaluate } from './cdp.mjs';

const widths = (process.argv[2] ?? '1024,1200,1366').split(',').map(Number);

const session = await connect();
try {
  for (const width of widths) {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 350));
    const info = await evaluate(
      session,
      `const fields = [...document.querySelectorAll('.field')].map((f) => {
         const input = f.querySelector('input');
         const box = f.getBoundingClientRect();
         return {
           label: f.querySelector('label')?.textContent,
           w: Math.round(box.width),
           h: Math.round(box.height),
           // 输入框被压窄到放不下 placeholder 时会先出现横向滚动，再窄就变成竖排单字
           clipped: input ? input.scrollWidth > input.clientWidth + 1 : null,
         };
       });
       const hero = document.querySelector('.hero');
       const scroll = document.querySelector('.content');
       return JSON.stringify({
         win: innerWidth,
         heroH: hero ? Math.round(hero.getBoundingClientRect().height) : null,
         // 横向溢出会让整页出现左右滚动条，是挤压的另一种表现
         overflowX: scroll ? scroll.scrollWidth > scroll.clientWidth + 1 : null,
         fields,
       });`
    );
    console.log(width, info);
  }
} finally {
  await session.send('Emulation.clearDeviceMetricsOverride');
  session.ws.close();
}
