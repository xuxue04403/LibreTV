import { useCallback, useState } from 'react';
import { buildPlaybackCandidates, fetchDetail, formatRelativeTime, type HistoryEntry } from '@libretv/core';
import { http } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { Poster } from '../components/Poster';
import { useToast } from '../components/Toast';
import { CategoryButtons, type CategoryKey } from './Category';
import type { WatchTarget } from './Watch';

/**
 * 历史/收藏里只存了单个源，没有聚合结果可用。
 * 这里先给出「只有当前源」的候选链，播放页会按片名在后台补齐其它源。
 */
function soloCandidate(source: { key: string; name: string; url: string; isAdult?: boolean }, vodId: string) {
  return buildPlaybackCandidates(
    [{ sourceKey: source.key, sourceName: source.name, vodId, name: '', sourceUrl: source.url }],
    [source]
  );
}

export function HomePage({
  onPlay,
  onSearch,
  onCategory,
}: {
  onPlay: (target: WatchTarget) => void;
  onSearch: (keyword: string) => void;
  onCategory: (key: CategoryKey) => void;
}) {
  const sources = useAppStore((s) => s.sources);
  const history = useAppStore((s) => s.history);
  const favorites = useAppStore((s) => s.favorites);
  const recentSearches = useAppStore((s) => s.recentSearches);
  const toast = useToast();
  const [opening, setOpening] = useState<string | null>(null);

  const resume = useCallback(
    async (entry: HistoryEntry) => {
      const source = sources.find((s) => s.key === entry.sourceKey);
      if (!source) {
        toast.err('该片源已被删除');
        return;
      }
      setOpening(entry.id);
      try {
        const detail = await fetchDetail(source, entry.vodId, http);
        if (detail.episodes.length === 0) {
          toast.err('该片源暂无可用播放地址');
          return;
        }
        onPlay({
          source,
          vodId: entry.vodId,
          title: detail.videoInfo.title ?? entry.title,
          year: entry.year,
          cover: detail.videoInfo.cover ?? entry.cover,
          episodes: detail.episodes,
          startIndex: Math.min(entry.episodeIndex, detail.episodes.length - 1),
          candidates: soloCandidate(source, entry.vodId),
        });
      } catch (err) {
        toast.err(err instanceof Error ? err.message : '打开失败');
      } finally {
        setOpening(null);
      }
    },
    [onPlay, sources, toast]
  );

  const playFavorite = useCallback(
    async (fav: { sourceKey: string; vodId: string; title: string; year?: string; cover?: string; id: string }) => {
      const source = sources.find((s) => s.key === fav.sourceKey);
      if (!source) {
        toast.err('该片源已被删除');
        return;
      }
      setOpening(fav.id);
      try {
        const detail = await fetchDetail(source, fav.vodId, http);
        if (detail.episodes.length === 0) {
          toast.err('该片源暂无可用播放地址');
          return;
        }
        const saved = useAppStore.getState().history.find((h) => h.id === fav.id);
        onPlay({
          source,
          vodId: fav.vodId,
          title: detail.videoInfo.title ?? fav.title,
          year: fav.year,
          cover: detail.videoInfo.cover ?? fav.cover,
          episodes: detail.episodes,
          startIndex: saved ? Math.min(saved.episodeIndex, detail.episodes.length - 1) : 0,
          candidates: soloCandidate(source, fav.vodId),
        });
      } catch (err) {
        toast.err(err instanceof Error ? err.message : '打开失败');
      } finally {
        setOpening(null);
      }
    },
    [onPlay, sources, toast]
  );


  return (
    <>
      {recentSearches.length > 0 ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <span style={{ color: '#8d97a8', fontSize: 12 }}>最近搜索</span>
          {recentSearches.slice(0, 8).map((kw) => (
            <button key={kw} className="chip" style={{ cursor: 'pointer' }} onClick={() => onSearch(kw)}>
              {kw}
            </button>
          ))}
        </div>
      ) : null}

      <div className="section-title">
        <span>按分类浏览</span>
        <span className="hint">只显示所选源有内容的分类</span>
      </div>
      <CategoryButtons onSelect={onCategory} />

      <div className="section-title">
        <span>继续观看</span>
        <span className="hint">{history.length > 0 ? `最近 ${Math.min(history.length, 12)} 条` : ''}</span>
      </div>

      {history.length === 0 ? (
        <div className="empty" style={{ padding: 34 }}>
          <div style={{ fontSize: 12.5 }}>还没有观看记录。搜索影片并播放后，这里会出现续播入口。</div>
        </div>
      ) : (
        <div className="grid">
          {history.slice(0, 12).map((h) => {
            const progress = h.duration > 0 ? Math.min(100, (h.position / h.duration) * 100) : 0;
            return (
              <button key={h.id} className="card" onClick={() => void resume(h)} disabled={opening === h.id}>
                <Poster src={h.cover} alt={h.title} />
                <span className="badge">第 {h.episodeIndex + 1} / {h.episodeCount} 集</span>
                <div className="card-body">
                  <div className="card-title" title={h.title}>
                    {h.title}
                  </div>
                  <div className="card-meta">
                    <span>{h.sourceName}</span>
                    <span>· {formatRelativeTime(h.updatedAt)}</span>
                  </div>
                  <div className="progress" style={{ height: 4, marginTop: 8, marginBottom: 0, cursor: 'default' }}>
                    <div className="played" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="section-title">
        <span>我的收藏</span>
        <span className="hint">{favorites.length} 部</span>
      </div>

      {favorites.length === 0 ? (
        <div className="empty" style={{ padding: 34 }}>
          <div style={{ fontSize: 12.5 }}>在影片详情里点击「收藏」，方便下次直接打开。</div>
        </div>
      ) : (
        <div className="grid">
          {favorites.slice(0, 18).map((f) => (
            <button key={f.id} className="card" onClick={() => void playFavorite(f)} disabled={opening === f.id}>
              <Poster src={f.cover} alt={f.title} />
              <div className="card-body">
                <div className="card-title" title={f.title}>
                  {f.title}
                </div>
                <div className="card-meta">收藏于 {formatRelativeTime(f.createdAt)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
