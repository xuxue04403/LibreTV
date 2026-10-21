import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import {
  fetchEpg,
  fetchLivePlaylist,
  filterAdultChannels,
  filterChannels,
  type LiveChannel,
  type LivePlaylist,
} from '@libretv/core';
import { http, proxify } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { Icon } from '../components/Icons';
import { useToast } from '../components/Toast';

interface ChannelItem extends LiveChannel {
  sourceKey: string;
  sourceName: string;
  epg?: string;
}

interface PlaylistState {
  sourceKey: string;
  sourceName: string;
  ok: boolean;
  channels: number;
  error?: string;
}

export function LivePage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const allLiveSources = useAppStore((s) => s.liveSources);
  const liveSelectedKeys = useAppStore((s) => s.liveSelectedKeys);
  const liveSources = useMemo(
    () => allLiveSources.filter((s) => liveSelectedKeys.includes(s.key)),
    [allLiveSources, liveSelectedKeys]
  );
  const liveFavorites = useAppStore((s) => s.liveFavorites);
  const toggleLiveFavorite = useAppStore((s) => s.toggleLiveFavorite);
  const adultFilter = useAppStore((s) => s.settings.adultFilter);
  const toast = useToast();

  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [status, setStatus] = useState<PlaylistState[]>([]);
  const [loading, setLoading] = useState(false);
  const [group, setGroup] = useState('全部');
  const [keyword, setKeyword] = useState('');
  const [playing, setPlaying] = useState<ChannelItem | null>(null);
  const runId = useRef(0);

  const load = useCallback(async () => {
    if (liveSources.length === 0) return;
    const myRun = ++runId.current;
    setLoading(true);
    setChannels([]);
    setStatus([]);

    const results = await Promise.allSettled(
      liveSources.map(async (source) => {
        const playlist: LivePlaylist & { epgUrl?: string } = await fetchLivePlaylist(source.url, http);
        return { source, playlist };
      })
    );
    if (myRun !== runId.current) return;

    const all: ChannelItem[] = [];
    const states: PlaylistState[] = [];
    results.forEach((result, i) => {
      const source = liveSources[i];
      if (result.status === 'fulfilled') {
        const { playlist } = result.value;
        // 直播此前完全没有成人过滤：用户自加的 M3U 里成人类目会原样露出，
        // 与点播侧的开关语义不一致。这里复用同一个开关。
        const safeChannels = filterAdultChannels(playlist.channels, adultFilter);
        states.push({ sourceKey: source.key, sourceName: source.name, ok: true, channels: safeChannels.length });
        for (const ch of safeChannels) {
          all.push({
            ...ch,
            sourceKey: source.key,
            sourceName: source.name,
            epg: source.epg || playlist.epgUrl,
          });
        }
      } else {
        states.push({
          sourceKey: source.key,
          sourceName: source.name,
          ok: false,
          channels: 0,
          error: result.reason instanceof Error ? result.reason.message : '加载失败',
        });
      }
    });

    setChannels(all);
    setStatus(states);
    setLoading(false);
    if (all.length === 0) toast.err('所有直播源都没有解析到频道');
  }, [liveSources, toast, adultFilter]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSources.map((s) => s.key).join(','), adultFilter]);

  const groups = useMemo(() => {
    const seen = new Set<string>();
    const out = ['全部'];
    for (const ch of channels) {
      const g = ch.group || '未分组';
      if (!seen.has(g)) {
        seen.add(g);
        out.push(g);
      }
    }
    return out;
  }, [channels]);

  const visible = useMemo(
    () => filterChannels(channels, { group: group === '全部' ? undefined : group, keyword }),
    [channels, group, keyword]
  );

  if (liveSources.length === 0) {
    return (
      <div className="empty">
        <Icon name="radio" size={30} />
        <h3>还没有直播源</h3>
        <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
          在设置中添加 M3U / M3U8 直播订阅地址（可选填 XMLTV 节目单），
          <br />
          或通过数据源订阅一次导入点播源与直播源。
        </div>
        <button className="btn primary" style={{ marginTop: 14 }} onClick={onOpenSettings}>
          前往设置
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="section-title">
        <span>直播频道</span>
        <span className="hint">
          {loading ? '解析直播源中…' : `${channels.length} 个频道 · ${groups.length - 1} 个分组`}
        </span>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {status.map((s) => (
          <span key={s.sourceKey} className={`chip ${s.ok ? 'ok' : 'err'}`}>
            {s.ok ? `${s.sourceName} · ${s.channels} 频道` : `${s.sourceName} · ${s.error ?? '失败'}`}
          </span>
        ))}
        <button className="btn ghost" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" size={15} />
          重新加载
        </button>
        <input
          className="input"
          style={{ width: 220, marginLeft: 'auto' }}
          placeholder="搜索频道…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      <div className="live-layout">
        <div className="group-list">
          {groups.map((g) => {
            const count = g === '全部' ? channels.length : channels.filter((c) => (c.group || '未分组') === g).length;
            return (
              <button
                key={g}
                className={`group-item${group === g ? ' active' : ''}`}
                onClick={() => setGroup(g)}
              >
                <span>{g}</span>
                <span style={{ color: '#5f6a7c' }}>{count}</span>
              </button>
            );
          })}
        </div>

        <div>
          {visible.length === 0 && !loading ? (
            <div className="empty" style={{ padding: 32 }}>
              <div>这个分组下没有匹配的频道</div>
            </div>
          ) : (
            <div className="channel-grid">
              {visible.map((ch) => {
                const fav = liveFavorites.some((f) => f.url === ch.url);
                return (
                  <div key={`${ch.sourceKey}:${ch.url}`} className="channel" role="button" tabIndex={0} onClick={() => setPlaying(ch)}>
                    {ch.logo ? (
                      <img className="logo" src={proxify(ch.logo, { image: true })} alt="" loading="lazy" />
                    ) : (
                      <div className="logo" style={{ display: 'grid', placeItems: 'center', color: '#4a5464' }}>
                        <Icon name="tv" size={16} />
                      </div>
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="ch-name" title={ch.name}>
                        {ch.name}
                      </div>
                      <div className="ch-group">{ch.group || '未分组'}</div>
                    </div>
                    <button
                      className="ctrl"
                      style={{ width: 28, height: 28, color: fav ? '#ff6b3d' : '#5f6a7c' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleLiveFavorite({ url: ch.url, name: ch.name, logo: ch.logo, group: ch.group });
                      }}
                      title={fav ? '取消收藏' : '收藏频道'}
                    >
                      <Icon name="heart" size={14} filled={fav} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {playing ? <LivePlayer channel={playing} onClose={() => setPlaying(null)} /> : null}
    </>
  );
}

function LivePlayer({ channel, onClose }: { channel: ChannelItem; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [epgText, setEpgText] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!channel.epg || !channel.tvgId) return;
    let alive = true;
    fetchEpg(channel.epg, channel.tvgId, http)
      .then((epg) => {
        if (!alive) return;
        if (epg.current) {
          const end = new Date(epg.current.stop).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          setEpgText(`正在播出：${epg.current.title}（至 ${end}）`);
        }
      })
      .catch(() => {
        /* 节目单失败不影响播放 */
      });
    return () => {
      alive = false;
    };
  }, [channel.epg, channel.tvgId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const url = channel.url;
    const isHls = /\.m3u8(\?|$)/i.test(url);
    const isFlv = /\.flv(\?|$)/i.test(url);
    setLoading(true);
    setError(null);
    let hls: Hls | null = null;
    let flv: mpegts.Player | null = null;

    if (isFlv) {
      // FLV 是长连接，必须直连（回环代理会缓冲整个响应）
      if (mpegts.isSupported()) {
        flv = mpegts.createPlayer(
          { type: 'flv', url, isLive: true, cors: true },
          { enableStashBuffer: false, liveBufferLatencyChasing: true }
        );
        flv.attachMediaElement(video);
        flv.load();
        void Promise.resolve(flv.play()).catch(() => setError('自动播放被拦截，点击画面继续'));
        flv.on(mpegts.Events.ERROR, () => setError('直播流加载失败（可能不支持跨域）'));
      } else {
        setError('当前环境不支持 FLV 直播');
      }
    } else if (isHls) {
      const src = proxify(url);
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 20 });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setError('直播流加载失败，可能已下线');
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
      } else {
        setError('当前环境不支持 HLS 直播');
      }
    } else {
      video.src = proxify(url);
    }

    const onPlaying = () => setLoading(false);
    const onWaiting = () => setLoading(true);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    void video.play().catch(() => undefined);

    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      hls?.destroy();
      flv?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [channel.url]);

  return (
    <div className="live-player-wrap">
      <div className="live-bar">
        <button className="ctrl" onClick={onClose} title="返回">
          <Icon name="left" size={20} />
        </button>
        <div>
          <div style={{ fontWeight: 600 }}>
            <span className="chip on" style={{ marginRight: 8 }}>
              LIVE
            </span>
            {channel.name}
          </div>
          <div style={{ color: '#a9b3c3', fontSize: 12 }}>
            {epgText ?? `${channel.group || '未分组'} · ${channel.sourceName}`}
          </div>
        </div>
        <div className="spacer" />
        <button className="ctrl" onClick={() => void window.libretv?.toggleFullscreen()} title="全屏">
          <Icon name="maximize" size={18} />
        </button>
      </div>
      <div className="live-stage">
        <video
          ref={videoRef}
          playsInline
          controls={false}
          onClick={(e) => {
            const v = e.currentTarget;
            if (v.paused) void v.play();
            else v.pause();
          }}
        />
        {loading && !error ? (
          <div className="player-loading">
            <div className="spinner" />
            <div>正在连接直播流…</div>
          </div>
        ) : null}
        {error ? (
          <div className="player-loading">
            <div style={{ textAlign: 'center' }}>
              <div>{error}</div>
              <div style={{ color: '#8d97a8', fontSize: 12, marginTop: 6 }}>
                部分直播源限制 UA/Referer 或已失效，可换其他频道
              </div>
            </div>
          </div>
        ) : null}
        <div className="player-controls" style={{ opacity: 1, position: 'absolute' }}>
          <div className="controls-row">
            <button
              className="ctrl"
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                v.muted = !v.muted;
                setMuted(v.muted);
              }}
            >
              <Icon name={muted ? 'mute' : 'volume'} size={18} />
            </button>
            <span className="chip">直播</span>
            <div className="spacer" />
            <span style={{ color: '#8d97a8', fontSize: 11 }}>{channel.url.slice(0, 64)}…</span>
          </div>
        </div>
      </div>
    </div>
  );
}
