import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  describeDisabledRemaining,
  describeSourceDisable,
  groupSearchResults,
  isSourceDisabled,
  searchSources,
  type AggregatedGroup,
  type SourceSearchOutcome,
} from '@libretv/core';
import { http } from '../lib/bridge';
import { cachedSearch, rememberSearch } from '../lib/catalog-cache';
import { useAppStore } from '../lib/store';
import { DetailPanel } from '../components/DetailPanel';
import { Icon } from '../components/Icons';
import { Poster } from '../components/Poster';
import { useToast } from '../components/toast-context';
import type { WatchTarget } from './Watch';

interface SearchState {
  outcomes: SourceSearchOutcome[];
  groups: AggregatedGroup[];
}

export function SearchPage({
  keyword,
  nonce,
  onPlay,
  onOpenSettings,
}: {
  keyword: string;
  /** 每次提交搜索 +1：同一个词再搜一遍时 keyword 不变，只能靠它触发重新请求 */
  nonce: number;
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
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const recordSourceOutcome = useAppStore((s) => s.recordSourceOutcome);
  const restoreSourceHealth = useAppStore((s) => s.restoreSourceHealth);
  const settings = useAppStore((s) => s.settings);
  const recentSearches = useAppStore((s) => s.recentSearches);
  const addRecentSearch = useAppStore((s) => s.addRecentSearch);
  const toast = useToast();

  // 暂停只影响「这次搜索发不发请求」，不动用户勾选：恢复后不用再去设置里重新打勾
  const pausedSources = useMemo(() => {
    const at = Date.now();
    return sources.filter((s) => isSourceDisabled(sourceHealth[s.key], at));
  }, [sources, sourceHealth]);
  const searchableSources = useMemo(() => {
    const paused = new Set(pausedSources.map((s) => s.key));
    return sources.filter((s) => !paused.has(s.key));
  }, [sources, pausedSources]);

  const [state, setState] = useState<SearchState>({ outcomes: [], groups: [] });
  const [loading, setLoading] = useState(false);
  const [fromCache, setFromCache] = useState(false);
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
      if (searchableSources.length === 0) {
        toast.err('所有已启用的源都因连续失败暂停了，可点击上方的「恢复」重新启用');
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

      // 先出缓存结果，网络结果回来后覆盖：同一个片名搜第二遍不该再等十几秒
      const cached = cachedSearch(searchableSources, settings.adultFilter, word);
      if (cached && cached.length > 0) {
        setState({ outcomes: [], groups: groupSearchResults(cached) });
        setFromCache(true);
      }

      const commit = (outcome: SourceSearchOutcome) => {
        if (myRun !== runId.current) return;
        const merged = [...outcomesRef.current.filter((o) => o.sourceKey !== outcome.sourceKey), outcome];
        outcomesRef.current = merged;
        // 第一个源回来后就把缓存结果换掉：缓存里没有「哪些源有/没有」的信息，
        // 混着用会让用户以为某个源也返回了这些条目
        setFromCache(false);
        const items = merged.flatMap((o) => (o.ok ? o.list : []));
        setState({ outcomes: merged, groups: groupSearchResults(items) });
        // 连续失败累计到阈值会在这里返回事件：暂停后本次搜索不再请求它，
        // 下次搜索直接跳过——死源不该让每次搜索都先等满 10 秒超时。
        const event = recordSourceOutcome(outcome.sourceKey, outcome.ok);
        if (event) {
          const name = sources.find((s) => s.key === outcome.sourceKey)?.name ?? outcome.sourceName;
          toast.push(`${name} 连续失败，${describeSourceDisable(event.level)}`);
        }
      };

      try {
        const result = await searchSources({
          wd: word,
          sources: searchableSources,
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
        } else {
          // 有结果才落盘：把「确实没搜到」也缓存住，会让下次重试直接看到空页面
          rememberSearch(searchableSources, settings.adultFilter, word, result.list);
        }
      } catch (err) {
        // 取消不是失败：离开搜索页时 abort 会让 searchSources 抛错，
        // 旧写法只判 runId，于是切页时必弹一次红色「搜索失败」。
        if (!controller.signal.aborted && myRun === runId.current) {
          toast.err(err instanceof Error ? err.message : '搜索失败');
        }
      } finally {
        if (myRun === runId.current) setLoading(false);
      }
    },
    [addRecentSearch, recordSourceOutcome, searchableSources, settings.adultFilter, sources, toast]
  );

  useEffect(() => {
    if (keyword.trim()) void run(keyword);
    // nonce 变化说明用户又点了一次搜索，哪怕关键词没变也要重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, nonce]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      // 与分类页同理：abort 后 catch 里 runId 仍相等，得自增才能让这一轮彻底失效
      runId.current += 1;
    },
    []
  );

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
              {loading
                ? `搜索中… 已完成 ${state.outcomes.length}/${searchableSources.length} 个源`
                : fromCache
                  ? `${state.groups.length} 部影片（本地缓存）`
                  : `${state.groups.length} 部影片`}
            </span>
          </div>

          {pausedSources.length > 0 ? (
            <div style={{ marginBottom: 14 }}>
              <div className="hint">
                已暂停 {pausedSources.length} 个源（连续失败 2 次自动暂停；暂停只影响搜索，不影响勾选）。
                恢复后从第 1 次失败重新累计：
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {pausedSources.map((source) => (
                  <button
                    key={source.key}
                    className="chip warn"
                    title="点击恢复此源"
                    onClick={() => restoreSourceHealth(source.key)}
                  >
                    {source.name} · {describeDisabledRemaining(sourceHealth[source.key], Date.now())} · 恢复
                  </button>
                ))}
              </div>
            </div>
          ) : null}

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
          ) : searchableSources.length === 0 ? (
            <div className="empty">
              <Icon name="search" size={26} />
              <h3>所有源都暂停了</h3>
              <div style={{ fontSize: 12.5 }}>
                连续失败的源会被自动暂停，避免每次搜索都先等一轮超时。
                <br />
                点击上方任一源的「恢复」即可重新参与搜索。
              </div>
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
