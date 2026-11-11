import { useEffect, useMemo, useState } from 'react';
import { HOME_CATEGORIES, probeCategories, type CategoryKey } from '@librextv/core';
import { http } from './bridge';
import { useAppStore } from './store';

/**
 * 分类可用性探测（首页与分类页共用）。
 *
 * 探测要打 8 个分类 × 每个源，首次约 8 秒。为了不让首页按钮先全显示再少一个，
 * 结果按「源签名」落到 localStorage：下次启动直接按上次结论渲染，后台再刷新。
 *
 * 这个文件只导出 hook 与类型（React Fast Refresh 要求组件文件里不放别的导出，
 * 否则改一次样式就要整文件重载，正在播放的视频会被打断）。
 */
const AVAILABILITY_KEY = 'librextv-category-availability-v1';
/** 探测结论的有效期：源站内容天天变，超过一天就该重新问一遍 */
const AVAILABILITY_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedAvailability {
  signature: string;
  keys: CategoryKey[];
  at: number;
}

function readCachedAvailability(signature: string): CategoryKey[] | undefined {
  try {
    const raw = localStorage.getItem(AVAILABILITY_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CachedAvailability;
    if (parsed.signature !== signature || !Array.isArray(parsed.keys)) return undefined;
    // 注释一直写着「24 小时内的结论直接用」，但代码从来没看过 at：
    // 结论会永久有效。导入一份新配置后（源地址全换、key 却还是 builtin_0..3），
    // 首页会按几个月前的探测结果把分类按钮藏起来，用户怎么看都少几个分类。
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > AVAILABILITY_TTL_MS) return undefined;
    return parsed.keys;
  } catch {
    return undefined;
  }
}

function writeCachedAvailability(signature: string, keys: CategoryKey[]): void {
  try {
    const payload: CachedAvailability = { signature, keys, at: Date.now() };
    localStorage.setItem(AVAILABILITY_KEY, JSON.stringify(payload));
  } catch {
    /* 配额满或被禁用时忽略，探测结果本身还会用 */
  }
}

/**
 * 分类探测的模块级单飞。
 *
 * 探测一轮要打 8 个分类 × N 个源，冷启动约 8 秒。旧实现在 effect 的 cleanup 里
 * `controller.abort()`：用户只要在 8 秒内切一次页（首页→搜索→首页很常见），
 * 这一轮就被打断、结果也没落盘，回来后从头再问一遍——反复切页时探测永远收敛不了，
 * 网络请求翻好几倍。
 *
 * 改成：探测结果与「进行中的那一轮」都挂在模块上，按签名复用；
 * 组件卸载只取消「把结果写回 state」，不再打断请求本身。
 */
let probeOnce: { signature: string; promise: Promise<CategoryKey[]> } | null = null;
let probedResult: { signature: string; keys: CategoryKey[] } | null = null;

function ensureProbe(
  signature: string,
  sources: ReturnType<typeof useAppStore.getState>['sources'],
  adultFilter: boolean
): Promise<CategoryKey[]> {
  if (probedResult?.signature === signature) return Promise.resolve(probedResult.keys);
  if (probeOnce?.signature === signature) return probeOnce.promise;
  const promise = probeCategories({ sources, http, filterAdult: adultFilter, timeoutMs: 12_000 })
    .then((results) => results.filter((r) => r.available).map((r) => r.key))
    .catch(() => HOME_CATEGORIES.map((c) => c.key))
    .then((keys) => {
      probedResult = { signature, keys };
      if (probeOnce?.signature === signature) probeOnce = null;
      writeCachedAvailability(signature, keys);
      return keys;
    });
  probeOnce = { signature, promise };
  return promise;
}

/** 当前源集合下「真的抓得到内容」的分类；`undefined` 表示还在探测 */
export function useAvailableCategories(): CategoryKey[] | undefined {
  const allSources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const adultFilter = useAppStore((s) => s.settings.adultFilter);
  const sources = useMemo(
    () => allSources.filter((s) => selectedKeys.includes(s.key)),
    [allSources, selectedKeys]
  );
  // 签名必须带 url：内置源的 key 是写死的 `builtin_0..3`，导入一份新配置后
  // key 完全不变而地址全换了，只用 key 做签名会命中上一份配置的探测结论。
  const sourceSignature = `${sources
    .map((s) => `${s.key}=${s.url}`)
    .sort()
    .join(',')}|${adultFilter ? 1 : 0}`;

  // 存的是「属于哪个签名」的结果：签名一变就自然失效，不用手动清空
  const [probed, setProbed] = useState<{ signature: string; keys: CategoryKey[] } | undefined>(undefined);

  useEffect(() => {
    if (sources.length === 0) return;
    let cancelled = false;
    void ensureProbe(sourceSignature, sources, adultFilter).then((keys) => {
      // 卸载了只是不再写回 state，请求本身照常跑完并落盘，下次进来直接命中
      if (cancelled) return;
      setProbed({ signature: sourceSignature, keys });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSignature]);

  if (sources.length === 0) return [];
  // 本轮结果 > 上次落盘的结论 > undefined（探测中，UI 先按全量渲染）
  if (probed?.signature === sourceSignature) return probed.keys;
  return readCachedAvailability(sourceSignature);
}
