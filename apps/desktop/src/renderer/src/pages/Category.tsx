import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  browseCategory,
  groupSearchResults,
  HOME_CATEGORIES,
  type AggregatedGroup,
  type CategoryKey,
  type CategorySourceOutcome,
} from '@libretv/core';
import { http } from '../lib/bridge';
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
  const [selected, setSelected] = useState<AggregatedGroup | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runId = useRef(0);

  const label = HOME_CATEGORIES.find((c) => c.key === category)?.label ?? '分类';

  const load = useCallback(
    async (targetPage: number, append: boolean) => {
      if (sources.length === 0) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRun = ++runId.current;

      setLoading(true);
      if (!append) {
        setGroups([]);
        setOutcomes([]);
        setPage(1);
      }

      try {
        const result = await browseCategory({
          sources,
          key: category,
          http,
          pages: targetPage,
          timeoutMs: 12_000,
          signal: controller.signal,
        });
        if (myRun !== runId.current) return;

        // 追加模式：只保留本次新增页的结果，与已有结果合并去重
        const incoming = groupSearchResults(result.items);
        setGroups((prev) => {
          if (!append) return incoming;
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
        });
        setOutcomes(result.outcomes);
        setPage(targetPage);
        // 任一源还有下一页就允许继续加载
        setHasMore(result.outcomes.some((o) => o.supported && o.count > 0) && targetPage < 8);
        if (result.items.length === 0) {
          toast.push(`当前源没有返回「${label}」内容`);
        }
      } catch (err) {
        if (myRun === runId.current && !(err instanceof DOMException && err.name === 'AbortError')) {
          toast.err(err instanceof Error ? err.message : '加载失败');
        }
      } finally {
        if (myRun === runId.current) setLoading(false);
      }
    },
    [category, label, sources, toast]
  );

  useEffect(() => {
    if (sources.length === 0) return;
    void load(1, false);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, sources.map((s) => s.key).join(',')]);

  const supported = outcomes.filter((o) => o.supported).length;
  const failed = outcomes.filter((o) => !o.ok).length;

  return (
    <>
      <div className="section-title" style={{ marginTop: 4 }}>
        <span>
          {label}
          <span style={{ color: '#8d97a8', fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
            {loading && page === 1 ? '加载中…' : `${groups.length} 部`}
          </span>
        </span>
        <span className="hint">
          {outcomes.length > 0
            ? `${supported} 个源有此分类${failed > 0 ? ` · ${failed} 个源失败` : ''}`
            : ''}
        </span>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {HOME_CATEGORIES.map((bucket) => (
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
          <h3>这个分类暂时没有内容</h3>
          <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            各源对分类的命名与编排不同，部分源可能没有「{label}」分类；
            <br />
            也可以直接搜索片名。
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

/** 供首页复用的分类按钮行 */
export function CategoryButtons({ onSelect }: { onSelect: (key: CategoryKey) => void }) {
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
