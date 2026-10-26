import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildPlaybackCandidates,
  clampEpisodeIndex,
  fetchDetail,
  findResumeByTitle,
  historyId,
  type AggregatedGroup,
  type SearchResultItem,
  type SourceConfig,
  type VideoDetail,
} from '@libretv/core';
import { http } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { useToast } from './Toast';
import { Icon } from './Icons';
import { Poster } from './Poster';
import type { WatchTarget } from '../pages/Watch';

export function DetailPanel({
  group,
  onClose,
  onPlay,
}: {
  group: AggregatedGroup;
  onClose: () => void;
  onPlay: (target: WatchTarget) => void;
}) {
  const sources = useAppStore((s) => s.sources);
  const history = useAppStore((s) => s.history);
  const favorites = useAppStore((s) => s.favorites);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const toast = useToast();

  const [selected, setSelected] = useState<SearchResultItem>(group.items[0]);
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [episodeIndex, setEpisodeIndex] = useState(0);

  const resolveSource = useCallback(
    (item: SearchResultItem): SourceConfig => {
      const found = sources.find((s) => s.key === item.sourceKey);
      if (found) return found;
      return {
        key: item.sourceKey,
        name: item.sourceName,
        url: item.sourceUrl ?? '',
        isAdult: item.isAdult,
      };
    },
    [sources]
  );

  /** 同片源候选链（用于播放失败时自动换源），当前选中的源排第一 */
  const candidates = useMemo(
    () =>
      buildPlaybackCandidates(group.items, sources, {
        active: { sourceKey: selected.sourceKey, vodId: selected.vodId },
      }),
    [group.items, sources, selected.sourceKey, selected.vodId]
  );

  useEffect(() => {
    let alive = true;
    // 观看记录每 5 秒就会被播放页写一次，放进依赖会导致详情被反复重拉、
    // 同时还把 detail 置空让选集闪一下——这里现取快照，依赖只留「选了哪个源」。
    const { history: historySnapshot } = useAppStore.getState();
    const source = resolveSource(selected);
    if (!source.url) {
      setError('该来源缺少接口地址，无法获取详情');
      return;
    }
    setLoading(true);
    setError(null);
    setDetail(null);
    fetchDetail(source, selected.vodId, http)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        const resume =
          historySnapshot.find((h) => h.id === historyId(source.key, selected.vodId)) ??
          findResumeByTitle(historySnapshot, selected.name, selected.year);
        setEpisodeIndex(resume ? clampEpisodeIndex(resume.episodeIndex, d.episodes.length) : 0);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : '获取详情失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [resolveSource, selected]);

  const favId = `${selected.sourceKey}:${selected.vodId}`;
  const isFav = favorites.some((f) => f.id === favId);
  const resume =
    history.find((h) => h.id === historyId(selected.sourceKey, selected.vodId)) ??
    findResumeByTitle(history, selected.name, selected.year);
  // 按钮文案必须跟着「实际要播的那一集」走。
  // 原来写的是 `resume.episodeIndex + 1`，而点击时播的是 `episodeIndex`（用户刚点的选集），
  // 于是出现「按钮写着继续第 15 集、点下去从第 2 集开始」这种自相矛盾的观感。
  const resumeLabel = resume ? `继续播放 · 第 ${episodeIndex + 1} 集` : '立即播放';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="detail" onClick={(e) => e.stopPropagation()}>
        <div className="detail-head">
          <Poster src={detail?.videoInfo.cover ?? selected.pic} alt={selected.name} className="detail-cover" />
          <div>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="chip on">{selected.sourceName}</span>
              {selected.typeName ? <span className="chip">{selected.typeName}</span> : null}
              {selected.year ? <span className="chip">{selected.year}</span> : null}
              {selected.area ? <span className="chip">{selected.area}</span> : null}
              <span className="spacer" />
              <button className="ctrl" onClick={onClose} title="关闭（Esc）">
                <Icon name="x" />
              </button>
            </div>
            <h2>{detail?.videoInfo.title ?? selected.name}</h2>
            {selected.remarks ? (
              <div style={{ color: '#ffb59c', fontSize: 12.5, marginBottom: 8 }}>{selected.remarks}</div>
            ) : null}
            <div className="row" style={{ marginBottom: 10 }}>
              <button
                className="btn primary"
                disabled={!detail || detail.episodes.length === 0}
                onClick={() => {
                  if (!detail) return;
                  onPlay({
                    source: resolveSource(selected),
                    vodId: selected.vodId,
                    title: detail.videoInfo.title ?? selected.name,
                    cover: detail.videoInfo.cover ?? selected.pic,
                    episodes: detail.episodes,
                    startIndex: episodeIndex,
                    candidates,
                  });
                }}
              >
                <Icon name="play" size={16} filled />
                {resumeLabel}
              </button>
              <button
                className="btn"
                onClick={() => {
                  toggleFavorite({
                    id: favId,
                    sourceKey: selected.sourceKey,
                    vodId: selected.vodId,
                    title: selected.name,
                    year: selected.year,
                    cover: selected.pic,
                  });
                  toast.push(isFav ? '已取消收藏' : '已加入收藏');
                }}
              >
                <Icon name="heart" size={16} filled={isFav} />
                {isFav ? '已收藏' : '收藏'}
              </button>
              {detail && detail.episodes.length > 1 ? (
                <span className="chip">共 {detail.episodes.length} 集</span>
              ) : null}
            </div>
            <div className="desc">
              {detail?.videoInfo.desc?.replace(/<[^>]+>/g, ' ').trim() || '暂无简介'}
            </div>
            {detail?.videoInfo.actor ? (
              <div style={{ color: '#8d97a8', fontSize: 12, marginTop: 8 }}>
                主演：{detail.videoInfo.actor}
              </div>
            ) : null}
          </div>
        </div>

        <div className="source-row">
          <span style={{ color: '#8d97a8', fontSize: 12, alignSelf: 'center' }}>
            同片源（{group.items.length}）：
          </span>
          {group.items.map((item) => (
            <button
              key={`${item.sourceKey}:${item.vodId}`}
              className={`chip${item.sourceKey === selected.sourceKey && item.vodId === selected.vodId ? ' on' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => setSelected(item)}
              title={item.sourceUrl}
            >
              {item.sourceName}
            </button>
          ))}
        </div>

        <div className="section-title" style={{ marginTop: 14 }}>
          <span>选集</span>
          <span className="hint">{loading ? '加载中…' : `${detail?.episodes.length ?? 0} 集`}</span>
        </div>

        {error ? (
          <div className="empty" style={{ padding: 24 }}>
            <div style={{ color: '#ffc9ca' }}>{error}</div>
            <div style={{ fontSize: 12, marginTop: 6 }}>换一个来源试试</div>
          </div>
        ) : (
          <div className="episodes">
            {(detail?.episodes ?? []).map((url, i) => (
              <button
                key={`${url}-${i}`}
                className={`ep${i === episodeIndex ? ' active' : ''}`}
                onClick={() => setEpisodeIndex(i)}
                onDoubleClick={() => {
                  if (!detail) return;
                  onPlay({
                    source: resolveSource(selected),
                    vodId: selected.vodId,
                    title: detail.videoInfo.title ?? selected.name,
                    cover: detail.videoInfo.cover ?? selected.pic,
                    episodes: detail.episodes,
                    startIndex: i,
                    candidates,
                  });
                }}
                title={url}
              >
                第 {i + 1} 集
              </button>
            ))}
            {!loading && (detail?.episodes.length ?? 0) === 0 ? (
              <span style={{ color: '#8d97a8', fontSize: 12 }}>该源没有解析到可播放地址</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
