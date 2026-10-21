import { useCallback, useState } from 'react';
import { fetchDetail, formatRelativeTime, type HistoryEntry } from '@libretv/core';
import { http } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { Icon } from '../components/Icons';
import { Poster } from '../components/Poster';
import { useToast } from '../components/Toast';
import { CategoryButtons, type CategoryKey } from './Category';
import type { WatchTarget } from './Watch';

export function HomePage({
  onPlay,
  onOpenSettings,
  onSearch,
  onCategory,
}: {
  onPlay: (target: WatchTarget) => void;
  onOpenSettings: () => void;
  onSearch: (keyword: string) => void;
  onCategory: (key: CategoryKey) => void;
}) {
  const sources = useAppStore((s) => s.sources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const history = useAppStore((s) => s.history);
  const favorites = useAppStore((s) => s.favorites);
  const liveSources = useAppStore((s) => s.liveSources);
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
          cover: detail.videoInfo.cover ?? entry.cover,
          episodes: detail.episodes,
          startIndex: Math.min(entry.episodeIndex, detail.episodes.length - 1),
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
    async (fav: { sourceKey: string; vodId: string; title: string; cover?: string; id: string }) => {
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
          cover: detail.videoInfo.cover ?? fav.cover,
          episodes: detail.episodes,
          startIndex: saved ? Math.min(saved.episodeIndex, detail.episodes.length - 1) : 0,
        });
      } catch (err) {
        toast.err(err instanceof Error ? err.message : '打开失败');
      } finally {
        setOpening(null);
      }
    },
    [onPlay, sources, toast]
  );

  const activeCount = sources.filter((s) => selectedKeys.includes(s.key)).length;

  return (
    <>
      <div className="hero">
        <h1>把影院留在桌面</h1>
        <p>
          LibreTV 桌面端把采集聚合、解析与广告过滤全部放在本机运行：无需服务器、无需密码，
          搜索直接并行查询你添加的采集站，播放走本地代理以绕开跨域与防盗链。
        </p>
        <div className="row">
          <button className="btn primary" onClick={() => onSearch(recentSearches[0] ?? '')}>
            <Icon name="search" size={16} />
            开始搜索
          </button>
          <button className="btn" onClick={onOpenSettings}>
            <Icon name="sliders" size={16} />
            管理数据源
          </button>
          <div className="hero-stats">
            <div className="stat">
              <div className="n">{activeCount}</div>
              <div className="l">启用点播源</div>
            </div>
            <div className="stat">
              <div className="n">{liveSources.length}</div>
              <div className="l">直播源</div>
            </div>
            <div className="stat">
              <div className="n">{history.length}</div>
              <div className="l">观看记录</div>
            </div>
          </div>
        </div>
      </div>

      {recentSearches.length > 0 ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
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
