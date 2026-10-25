import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  browseCategory,
  groupSearchResults,
  HOME_CATEGORIES,
  probeCategories,
  type AggregatedGroup,
  type CategoryKey,
  type CategorySourceOutcome,
} from '@libretv/core';
import { http } from '../lib/bridge';
import { cachedItems, rememberItems } from '../lib/catalog-cache';
import { useAppStore } from '../lib/store';
import { DetailPanel } from '../components/DetailPanel';
import { Icon } from '../components/Icons';
import { Poster } from '../components/Poster';
import { useToast } from '../components/Toast';
import type { WatchTarget } from './Watch';

/** 分类浏览：进入时按当前分类拉取各源内容，可继续滚动加载更多页 */
export function CategoryPage({
  category,
  onCategoryChange,
  onPlay,
  onOpenSettings,
}: {
  category: CategoryKey;
  onCategoryChange: (next: CategoryKey) => void;
  onPlay: (target: WatchTarget) => void;
  onOpenSettings: () => void;
}) {
  const allSources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const adultFilter = useAppStore((s) => s.settings.adultFilter);
  const sources = useMemo(
    () => allSources.filter((s) => selectedKeys.includes(s.key)),
    [allSources, selectedKeys]
  );
  const toast = useToast();

  const [groups, setGroups] = useState<AggregatedGroup[]>([]);
  const [outcomes, setOutcomes] = useState<CategorySourceOutcome[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [selected, setSelected] = useState<AggregatedGroup | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runId = useRef(0);
  // `load` 是 useCallback 且依赖里没有 groups（那会让每次列表变化都重建回调），
  // 但收尾判断「界面还留着内容吗」需要读到最新的值，所以额外存一份 ref。
  const groupsRef = useRef<AggregatedGroup[]>([]);
  groupsRef.current = groups;

  const label = HOME_CATEGORIES.find((c) => c.key === category)?.label ?? '分类';

  // 切换条只列出有内容的分类，与首页一致
  const availableCategories = useAvailableCategories();
  const switchable = useMemo(() => {
    if (!availableCategories) return HOME_CATEGORIES;
    return HOME_CATEGORIES.filter(
      (bucket) => availableCategories.includes(bucket.key) || bucket.key === category
    );
  }, [availableCategories, category]);

  const load = useCallback(
    async (targetPage: number, append: boolean) => {
      if (sources.length === 0) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRun = ++runId.current;

      // 第一页先读本地缓存：切换分类不应该再等各源响应一遍。
      // 缓存只是「先给你内容」，请求照样发，回来后覆盖。
      if (targetPage === 1 && !append) {
        const cached = cachedItems(sources, adultFilter, category);
        if (cached && cached.length > 0) {
          setGroups(groupSearchResults(cached));
          setOutcomes([]);
          setPage(1);
          setHasMore(false);
          setFromCache(true);
        } else {
          setGroups([]);
          setOutcomes([]);
          setPage(1);
          setFromCache(false);
        }
      } else if (!append) {
        setGroups([]);
        setOutcomes([]);
        setPage(1);
      }

      setLoading(true);

      try {
        const result = await browseCategory({
          sources,
          key: category,
          http,
          // 追加模式只抓这一页：以前传 pages=targetPage 会让第 N 页把 1..N 全重下一遍
          pages: 1,
          startPage: targetPage,
          filterAdult: adultFilter,
          timeoutMs: 12_000,
          signal: controller.signal,
          // 边收边渲染：4 个源各回一次，首个源通常 1~3 秒就有内容，
          // 等全部回来才渲染会让用户盯着骨架屏 5 秒以上。
          // 回调给的是「目前为止的全部条目」，直接整体替换，不用自己做增量合并。
          onPartial: (partialItems) => {
            if (myRun !== runId.current || append || partialItems.length === 0) return;
            setGroups(groupSearchResults(partialItems));
            setFromCache(false);
            setLoading(false);
          },
        });
        if (myRun !== runId.current) return;

        // 追加模式：只保留本次新增页的结果，与已有结果合并去重
        const incoming = groupSearchResults(result.items);
        setGroups((prev) => {
          if (append) {
            const map = new Map(prev.map((g) => [g.key, g]));
            for (const group of incoming) {
              const existing = map.get(group.key);
              if (!existing) {
                map.set(group.key, group);
                continue;
              }
              const seen = new Set(existing.items.map((i) => `${i.sourceKey}:${i.vodId}`));
              const merged = [...existing.items];
              for (const item of group.items) {
                if (!seen.has(`${item.sourceKey}:${item.vodId}`)) merged.push(item);
              }
              map.set(group.key, { ...existing, items: merged });
            }
            return [...map.values()];
          }
          // 空结果不清屏：磁盘缓存里还有内容，界面上却把 240 条换成空白，
          // 用户再点一次刷新内容又回来，表现成「分类忽有忽无」。
          // 真正该保留的是「上一轮已经显示的东西」，哪怕是缓存。
          return incoming.length === 0 ? prev : incoming;
        });
        setOutcomes(result.outcomes);
        setPage(targetPage);
        // 内容为空时界面留住的是缓存内容，就别再说「已是最新」：
        // 标题继续标「本地缓存」，用户才知道看到的是上次抓到的结果。
        if (result.items.length > 0) setFromCache(false);
        // 任一源还有下一页就允许继续加载
        setHasMore(result.outcomes.some((o) => o.supported && o.count > 0) && targetPage < 8);
        // 第一页拿到就落盘：下次切回这个分类是 0 延迟
        if (targetPage === 1 && result.items.length > 0) {
          rememberItems(sources, adultFilter, category, result.items);
        }
        if (result.items.length === 0 && !append) {
          // 界面上还留着上一轮（通常是磁盘缓存）的内容：说「没有内容」会自相矛盾
          const kept = groupsRef.current.length > 0;
          toast.push(
            kept
              ? `「${label}」这次没抓到新内容，先显示上次缓存`
              : `当前源没有返回「${label}」内容`
          );
        }
      } catch (err) {
        if (myRun === runId.current && !(err instanceof DOMException && err.name === 'AbortError')) {
          toast.err(err instanceof Error ? err.message : '加载失败');
        }
      } finally {
        if (myRun === runId.current) setLoading(false);
      }
    },
    [adultFilter, category, label, sources, toast]
  );

  useEffect(() => {
    if (sources.length === 0) return;
    void load(1, false);
    return () => abortRef.current?.abort();
    // 成人过滤开关必须在这里：它是 load 的入参之一，改了却重载旧结果，
    // 用户会看到「关了过滤但列表里还是那些」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, adultFilter, sources.map((s) => s.key).join(',')]);

  const supported = outcomes.filter((o) => o.supported).length;
  const failed = outcomes.filter((o) => !o.ok);
  // 失败原因必须写出来：只显示「N 个源失败」，用户没法判断是网络、限流还是源站改了地址
  const failureDetail = useMemo(() => {
    const tally = new Map<string, number>();
    for (const outcome of failed) {
      const reason = (outcome.error ?? '失败').replace(/^HTTP\s*/i, 'HTTP ');
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([reason, count]) => (count > 1 ? `${reason}×${count}` : reason))
      .join('、');
  }, [failed]);

  return (
    <>
      <div className="section-title" style={{ marginTop: 4 }}>
        <span>
          {label}
          <span style={{ color: '#8d97a8', fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
            {loading && groups.length === 0
              ? '加载中…'
              : fromCache
                ? `${groups.length} 部（本地缓存，正在刷新）`
                : `${groups.length} 部`}
          </span>
        </span>
        <span className="hint" title={failed.map((o) => `${o.sourceName}：${o.error ?? '失败'}`).join('\n')}>
          {outcomes.length > 0
            ? `${supported} 个源有此分类${failed.length > 0 ? ` · ${failed.length} 个源失败（${failureDetail}）` : ''}`
            : ''}
        </span>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {/* 只列出有内容的分类：与首页保持一致，避免把用户带到空分类页 */}
        {switchable.map((bucket) => (
          <button
            key={bucket.key}
            className={`chip${bucket.key === category ? ' on' : ''}`}
            style={{ cursor: 'pointer', padding: '6px 14px', fontSize: 12.5 }}
            onClick={() => onCategoryChange(bucket.key)}
          >
            {bucket.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="btn ghost" onClick={() => void load(1, false)} disabled={loading}>
          <Icon name="refresh" size={15} />
          刷新
        </button>
      </div>

      {sources.length === 0 ? (
        <div className="empty">
          <Icon name="film" size={28} />
          <h3>还没有点播源</h3>
          <div style={{ fontSize: 12.5 }}>添加采集站后即可按分类浏览</div>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={onOpenSettings}>
            前往设置
          </button>
        </div>
      ) : groups.length > 0 ? (
        <>
          <div className="grid">
            {groups.map((group) => {
              const first = group.items[0];
              return (
                <button key={group.key} className="card" onClick={() => setSelected(group)}>
                  <Poster src={first.pic} alt={group.name} />
                  {group.items.length > 1 ? <span className="badge right">{group.items.length} 个源</span> : null}
                  <div className="card-body">
                    <div className="card-title" title={group.name}>
                      {group.name}
                    </div>
                    <div className="card-meta">
                      {first.typeName ? <span>{first.typeName}</span> : null}
                      {first.year ? <span>· {first.year}</span> : null}
                      {first.remarks ? <span>· {first.remarks}</span> : null}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {hasMore ? (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 22 }}>
              <button className="btn" onClick={() => void load(page + 1, true)} disabled={loading}>
                {loading ? '加载中…' : '加载更多'}
              </button>
            </div>
          ) : null}
        </>
      ) : loading ? (
        <div className="grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="card" style={{ opacity: 0.35 }}>
              <div className="poster-fallback" />
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">
          <Icon name="film" size={26} />
          <h3>{failed.length === outcomes.length && outcomes.length > 0 ? '所有源都没能返回内容' : '这个分类暂时没有内容'}</h3>
          <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            {failed.length === outcomes.length && outcomes.length > 0 ? (
              <>
                请求全部失败（{failureDetail}），通常是网络不通或采集站限流。
                <br />
                稍后点「刷新」重试。
              </>
            ) : (
              <>
                各源对分类的命名与编排不同，部分源可能没有「{label}」分类；
                <br />
                也可以直接搜索片名。
              </>
            )}
          </div>
        </div>
      )}

      {selected ? <DetailPanel group={selected} onClose={() => setSelected(null)} onPlay={onPlay} /> : null}
    </>
  );
}

export { HOME_CATEGORIES };
export type { CategoryKey };
export type { AggregatedGroup };

/**
 * 分类可用性探测（首页与分类页共用）。
 *
 * 探测要打 8 个分类 × 每个源，首次约 8 秒。为了不让首页按钮先全显示再少一个，
 * 结果按「源签名」落到 localStorage：下次启动直接按上次结论渲染，后台再刷新。
 */
const AVAILABILITY_KEY = 'libretv-category-availability-v1';

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
    // 24 小时内的结论直接用；更久的只当占位，等本轮探测覆盖
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

export function useAvailableCategories(): CategoryKey[] | undefined {
  const allSources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const adultFilter = useAppStore((s) => s.settings.adultFilter);
  const sources = useMemo(
    () => allSources.filter((s) => selectedKeys.includes(s.key)),
    [allSources, selectedKeys]
  );
  const sourceSignature = `${sources
    .map((s) => s.key)
    .sort()
    .join(',')}|${adultFilter ? 1 : 0}`;

  // 存的是「属于哪个签名」的结果：签名一变就自然失效，不用手动清空
  const [probed, setProbed] = useState<{ signature: string; keys: CategoryKey[] } | undefined>(undefined);

  useEffect(() => {
    if (sources.length === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    void probeCategories({
      sources,
      http,
      filterAdult: adultFilter,
      timeoutMs: 12_000,
      signal: controller.signal,
    })
      .then((results) => {
        if (cancelled) return;
        const keys = results.filter((r) => r.available).map((r) => r.key);
        setProbed({ signature: sourceSignature, keys });
        writeCachedAvailability(sourceSignature, keys);
      })
      .catch(() => {
        if (cancelled) return;
        // 探测失败就退回显示全部，不要把入口全藏起来
        setProbed({ signature: sourceSignature, keys: HOME_CATEGORIES.map((c) => c.key) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSignature]);

  if (sources.length === 0) return [];
  // 本轮结果 > 上次落盘的结论 > undefined（探测中，UI 先按全量渲染）
  if (probed?.signature === sourceSignature) return probed.keys;
  return readCachedAvailability(sourceSignature);
}

/** 供首页复用的分类按钮行：只显示真的抓得到内容的分类 */
export function CategoryButtons({ onSelect }: { onSelect: (key: CategoryKey) => void }) {
  const allSources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const available = useAvailableCategories();

  if (allSources.length === 0) {
    // 「一个源都没有」和「源没有这个分类」是两件事：前者要去设置里加源，
    // 说成「暂未返回任何分类内容」会把用户引到错误的方向
    return (
      <div className="category-bar">
        <span className="hint">还没有点播源，先在「设置 → 点播源」里添加一个采集站</span>
      </div>
    );
  }

  if (allSources.every((s) => !selectedKeys.includes(s.key))) {
    // 同上：源都在，但全被停用了。这也不是「源没有内容」
    return (
      <div className="category-bar">
        <span className="hint">所有点播源都已停用，在「设置 → 点播源」里打开开关即可</span>
      </div>
    );
  }

  if (available === undefined) {
    // 探测中先摆全部（避免布局跳动），完成后收敛到有内容的那些
    return (
      <div className="category-bar">
        {HOME_CATEGORIES.map((bucket) => (
          <button key={bucket.key} className="category-btn" onClick={() => onSelect(bucket.key)}>
            <span className="category-dot" />
            {bucket.label}
          </button>
        ))}
      </div>
    );
  }

  const shown = HOME_CATEGORIES.filter((b) => available.includes(b.key));
  if (shown.length === 0) {
    return (
      <div className="category-bar">
        <span className="hint">所选源暂未返回任何分类内容，可直接搜索片名</span>
      </div>
    );
  }

  return (
    <div className="category-bar">
      {shown.map((bucket) => (
        <button key={bucket.key} className="category-btn" onClick={() => onSelect(bucket.key)}>
          <span className="category-dot" />
          {bucket.label}
        </button>
      ))}
    </div>
  );
}
