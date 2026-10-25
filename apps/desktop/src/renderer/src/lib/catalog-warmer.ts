import { browseCategory, CATALOG_REFRESH_MS, HOME_CATEGORIES, type CategoryKey } from '@libretv/core';
import { http } from './bridge';
import { cachedItems, missingCategories, rememberItems } from './catalog-cache';
import { useAppStore } from './store';
/**
 * 分类目录预热与后台刷新。
 *
 * 用户要求：「程序启动时自动拉取刷新播放源数据，后台每小时自动拉取一次并更新缓存，
 * 分类切换和检索时都是优先读取缓存」。
 *
 * 这里只负责「把内容抓进缓存」：读缓存的逻辑在 `catalog-cache.ts`，页面直接命中即可。
 * 抓取刻意压到两路并发：启动时的首屏请求不该和用户主动点击抢带宽，
 * 但完全串行会让 8 个分类的首次预热拖到一分钟以上。
 */

const CONCURRENCY = 2;

interface WarmState {
  timer: number | null;
  boot: number | null;
  running: boolean;
}

const state: WarmState = { timer: null, boot: null, running: false };

/**
 * 预热哪些分类。
 *
 * 不再用「哪些分类已经有缓存」反推：那会自锁——首启只写 movie/tv，之后
 * available 恒为这两个，剩下 6 个分类永远轮不到预热。改成直接遍历首页全部分类，
 * 由 `staleCategories` 决定这次真正要抓哪些（每小时的刷新本来就该覆盖全部）。
 */
function targetCategories(): CategoryKey[] {
  const store = useAppStore.getState();
  const available = HOME_CATEGORIES.map((bucket) => bucket.key);
  // 完全没有任何缓存时（首次启动）先抓电影和电视剧两个最常看的分支，
  // 而不是一次把 8 个分类全抓完——那会让首屏多等好几秒。
  const seeded = available.some(
    (key) => (cachedItems(store.sources, store.settings.adultFilter, key)?.length ?? 0) > 0
  );
  return seeded ? available : ['movie', 'tv'];
}

async function warmOnce(): Promise<void> {
  if (state.running) return;
  const store = useAppStore.getState();
  const sources = store.sources.filter((s) => store.selectedKeys.includes(s.key));
  if (sources.length === 0) return;

  const adultFilter = store.settings.adultFilter;
  const keys = targetCategories();
  // 只抓「没缓存过或已过期」的分类，命中缓存的不再重复请求
  const stale = missingCategories(sources, adultFilter, keys);
  if (stale.length === 0) return;

  state.running = true;
  try {
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        if (index >= stale.length) return;
        const key = stale[index];
        try {
          const result = await browseCategory({
            sources,
            key,
            http,
            pages: 1,
            filterAdult: adultFilter,
            timeoutMs: 15_000,
          });
          if (result.items.length > 0) rememberItems(sources, adultFilter, key, result.items);
        } catch {
          /* 预热失败无所谓：用户点进分类时页面自己还会再拉一次 */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stale.length) }, worker));
  } finally {
    // 这是模块级互斥锁，在 await 之后释放正是意图所在；
    // 并发靠入口的 `if (state.running) return` 早退保证，不存在原子性问题。
    // eslint-disable-next-line require-atomic-updates
    state.running = false;
  }
}

/**
 * 启动预热 + 每小时刷新。
 *
 * 幂等：React 严格模式下 effect 会跑两遍，这里只认第一次。
 */
export function startCatalogWarmup(): void {
  if (state.timer !== null) return;
  // 首屏先让内容渲染完，再悄悄抓分类内容
  state.boot = window.setTimeout(() => {
    state.boot = null;
    void warmOnce();
  }, 1_500);
  state.timer = window.setInterval(() => void warmOnce(), CATALOG_REFRESH_MS);
}

export function stopCatalogWarmup(): void {
  // 启动定时器也要清：只清 interval 的话，卸载后那个 1.5 秒的回调仍会发出整批请求
  if (state.boot !== null) {
    window.clearTimeout(state.boot);
    state.boot = null;
  }
  if (state.timer !== null) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
}

/** 手动触发一次（设置页「立即刷新缓存」用） */
export function refreshCatalogNow(): Promise<void> {
  return warmOnce();
}
