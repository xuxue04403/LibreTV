import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  groupSearchResults,
  searchSources,
  type AggregatedGroup,
  type SourceSearchOutcome,
} from '@libretv/core';
import { http } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { DetailPanel } from '../components/DetailPanel';
import { Icon } from '../components/Icons';
import { Poster } from '../components/Poster';
import { useToast } from '../components/Toast';
import type { WatchTarget } from './Watch';

interface SearchState {
  outcomes: SourceSearchOutcome[];
  groups: AggregatedGroup[];
}

export function SearchPage({
  keyword,
  onPlay,
  onOpenSettings,
}: {
  keyword: string;
  onPlay: (target: WatchTarget) => void;
  onOpenSettings: () => void;
}) {
  // 注意：不要在 selector 里返回新数组（zustand v5 会判定快照持续变化而死循环），
  // 这里选原始数组后用 useMemo 派生。
  const allSources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const sources = useMemo(
    () => allSources.filter((s) => selectedKeys.includes(s.key)),
    [allSources, selectedKeys]
  );
  const settings = useAppStore((s) => s.settings);
  const recentSearches = useAppStore((s) => s.recentSearches);
  const addRecentSearch = useAppStore((s) => s.addRecentSearch);
  const toast = useToast();

  const [state, setState] = useState<SearchState>({ outcomes: [], groups: [] });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<AggregatedGroup | null>(null);
  const outcomesRef = useRef<SourceSearchOutcome[]>([]);
  const runId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (kw: string) => {
      const word = kw.trim();
      if (!word) return;
      if (sources.length === 0) {
        toast.err('还没有启用任何点播源，请先在设置中添加');
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const myRun = ++runId.current;

      outcomesRef.current = [];
      setState({ outcomes: [], groups: [] });
      setLoading(true);
      addRecentSearch(word);

      const commit = (outcome: SourceSearchOutcome) => {
        if (myRun !== runId.current) return;
        const merged = [...outcomesRef.current.filter((o) => o.sourceKey !== outcome.sourceKey), outcome];
        outcomesRef.current = merged;
        const items = merged.flatMap((o) => (o.ok ? o.list : []));
        setState({ outcomes: merged, groups: groupSearchResults(items) });
      };

      try {
        const result = await searchSources({
          wd: word,
          sources,
          http,
          filterAdult: settings.adultFilter,
          maxPages: 3,
          timeoutMs: 10_000,
          signal: controller.signal,
          onSource: commit,
        });
        if (myRun !== runId.current) return;
        if (result.list.length === 0 && result.failures.length > 0) {
          toast.err('所有源都没有返回结果，请检查网络或源可用性');
        } else if (result.list.length === 0) {
          toast.push(`没有找到「${word}」的相关内容`);
        }
      } catch (err) {
        if (myRun === runId.current) {
          toast.err(err instanceof Error ? err.message : '搜索失败');
        }
      } finally {
        if (myRun === runId.current) setLoading(false);
      }
    },
    [addRecentSearch, settings.adultFilter, sources, toast]
  );

  useEffect(() => {
    if (keyword.trim()) void run(keyword);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const okCount = state.outcomes.filter((o) => o.ok).length;
  const failCount = state.outcomes.filter((o) => !o.ok).length;

  return (
    <>
      {sources.length === 0 ? (
        <div className="empty">
          <Icon name="film" size={30} />
          <h3>还没有点播源</h3>
          <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            LibreTV 桌面端不内置任何片源。请在设置中添加 Apple CMS 采集站地址，
            <br />
            或导入一份 LibreTV-SourceList / TVBOX 订阅。
          </div>
          <button className="btn primary" style={{ marginTop: 14 }} onClick={onOpenSettings}>
            前往设置
          </button>
        </div>
      ) : (
        <>
          <div className="section-title">
            <span>
              搜索结果 {keyword ? <span style={{ color: '#8d97a8' }}>· {keyword}</span> : null}
            </span>
            <span className="hint">
              {loading ? `搜索中… 已完成 ${state.outcomes.length}/${sources.length} 个源` : `${state.groups.length} 部影片`}
            </span>
          </div>

          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {state.outcomes.map((o) => (
              <span key={o.sourceKey} className={`chip ${o.ok ? 'ok' : o.timedOut ? 'warn' : 'err'}`}>
                {o.ok
                  ? `${o.sourceName} · ${o.list.length} 条 · ${o.ms ?? 0}ms`
                  : `${o.sourceName} · ${o.timedOut ? '超时' : o.error ?? '失败'}`}
              </span>
            ))}
            {!loading && state.outcomes.length > 0 ? (
              <span className="chip">
                可用 {okCount} / 失败 {failCount}
              </span>
            ) : null}
          </div>

          {state.groups.length > 0 ? (
            <div className="grid">
              {state.groups.map((group) => {
                const first = group.items[0];
                const resume = useAppStore
                  .getState()
                  .history.find((h) => h.sourceKey === first.sourceKey && h.vodId === first.vodId);
                return (
                  <button key={group.key} className="card" onClick={() => setSelected(group)}>
                    <Poster src={first.pic} alt={group.name} />
                    {group.items.length > 1 ? <span className="badge right">{group.items.length} 个源</span> : null}
                    {resume ? <span className="badge">看到 {resume.episodeIndex + 1} 集</span> : null}
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
              <Icon name="search" size={26} />
              <h3>{keyword ? '没有找到相关内容' : '输入片名开始搜索'}</h3>
              <div style={{ fontSize: 12.5 }}>
                {keyword
                  ? '换个关键词，或检查源是否可用'
                  : recentSearches.length > 0
                    ? `最近搜索：${recentSearches.slice(0, 5).join('、')}`
                    : '搜索会并行查询所有已启用的点播源'}
              </div>
            </div>
          )}
        </>
      )}

      {selected ? (
        <DetailPanel group={selected} onClose={() => setSelected(null)} onPlay={onPlay} />
      ) : null}
    </>
  );
}
