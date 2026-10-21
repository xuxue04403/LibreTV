import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { episodeLabel, formatTime, historyId, type SourceConfig } from '@libretv/core';
import { proxify } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import { CastDialog } from '../components/CastDialog';
import { Icon } from '../components/Icons';

export interface WatchTarget {
  source: SourceConfig;
  vodId: string;
  title: string;
  cover?: string;
  episodes: string[];
  startIndex: number;
}

const SKIP_SECONDS = 10;

export function WatchPage({ target, onClose }: { target: WatchTarget; onClose: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const recordHistory = useAppStore((s) => s.recordHistory);
  const toast = useToast();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRef = useRef(0);

  const [index, setIndex] = useState(Math.max(0, Math.min(target.startIndex, target.episodes.length - 1)));
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [castOpen, setCastOpen] = useState(false);

  const episodeUrl = target.episodes[index];

  /** 保存进度（同一影片去重置顶） */
  const persistProgress = useCallback(
    (position: number, epIndex: number, total: number) => {
      if (!settings.resumePlayback) return;
      if (!Number.isFinite(position) || position <= 0) return;
      recordHistory({
        id: historyId(target.source.key, target.vodId),
        sourceKey: target.source.key,
        vodId: target.vodId,
        title: target.title,
        cover: target.cover,
        sourceName: target.source.name,
        episodeIndex: epIndex,
        episodeCount: target.episodes.length,
        episodeUrl: target.episodes[epIndex],
        position,
        duration: Number.isFinite(total) ? total : 0,
      });
      savedRef.current = position;
    },
    [recordHistory, settings.resumePlayback, target]
  );

  // —— 初始化/切换集数 ——
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !episodeUrl) return;
    setError(null);
    setLoading(true);
    setCurrent(0);
    setDuration(0);

    const isHls = /\.m3u8(\?|$)/i.test(episodeUrl);
    const src = proxify(episodeUrl, { ad: settings.adFilter });
    let hls: Hls | null = null;

    if (isHls) {
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, maxBufferLength: 30, backBufferLength: 60 });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setError('网络错误：分片加载失败，正在尝试恢复');
            hls?.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            setError('解码错误：正在尝试恢复');
            hls?.recoverMediaError();
          } else {
            setError('播放失败：该片源可能已失效，请返回换源');
            setLoading(false);
          }
        });
        hlsRef.current = hls;
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
      } else {
        setError('当前环境不支持 HLS 播放');
        setLoading(false);
      }
    } else {
      video.src = src;
    }

    const resume = settings.resumePlayback
      ? useAppStore
          .getState()
          .history.find((h) => h.id === historyId(target.source.key, target.vodId))
      : undefined;
    const onLoaded = () => {
      setLoading(false);
      setDuration(video.duration || 0);
      if (resume && resume.episodeIndex === index && resume.position > 15 && resume.position < video.duration - 15) {
        video.currentTime = resume.position;
        toast.push(`已从 ${formatTime(resume.position)} 继续播放`);
      }
      void video.play().catch(() => {
        /* 自动播放被拦截时保留暂停态，用户点击即可 */
      });
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });

    return () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      hls?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeUrl, index, settings.adFilter]);

  // —— 视频事件 ——
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => {
      setCurrent(video.currentTime);
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));
      if (Math.abs(video.currentTime - savedRef.current) >= 5) persistProgress(video.currentTime, index, video.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      persistProgress(video.currentTime, index, video.duration);
    };
    const onDuration = () => setDuration(video.duration || 0);
    const onEnded = () => {
      setPlaying(false);
      persistProgress(0, index, video.duration);
      if (settings.autoplayNext && index + 1 < target.episodes.length) {
        setIndex((i) => i + 1);
      }
    };
    const onWaiting = () => setLoading(true);
    const onPlaying = () => setLoading(false);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('ended', onEnded);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
    };
  }, [index, persistProgress, settings.autoplayNext, target.episodes.length]);

  // —— 退出时保存进度 ——
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video && video.currentTime > 0) persistProgress(video.currentTime, index, video.duration);
    };
  }, [index, persistProgress]);

  // —— 控制条自动隐藏 ——
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setControlsVisible(false);
    }, 3200);
  }, []);

  useEffect(() => {
    revealControls();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [revealControls]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
    revealControls();
  }, [revealControls]);

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, Math.min(video.currentTime + delta, video.duration || 0));
      revealControls();
    },
    [revealControls]
  );

  const changeEpisode = useCallback(
    (next: number) => {
      if (next < 0 || next >= target.episodes.length) return;
      persistProgress(videoRef.current?.currentTime ?? 0, index, videoRef.current?.duration ?? 0);
      setIndex(next);
      setDrawerOpen(false);
    },
    [index, persistProgress, target.episodes.length]
  );

  const toggleFullscreen = useCallback(async () => {
    if (window.libretv) {
      const on = await window.libretv.toggleFullscreen();
      setFullscreen(on);
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
      setFullscreen(false);
    } else {
      await document.documentElement.requestFullscreen();
      setFullscreen(true);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const changeRate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const next = rate >= 2 ? 1 : rate + 0.25;
    video.playbackRate = next;
    setRate(next);
  }, [rate]);

  // —— 键盘快捷键 ——
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          seekBy(-SKIP_SECONDS);
          break;
        case 'ArrowRight':
          seekBy(SKIP_SECONDS);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (videoRef.current) {
            videoRef.current.volume = Math.min(1, videoRef.current.volume + 0.1);
            setVolume(videoRef.current.volume);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (videoRef.current) {
            videoRef.current.volume = Math.max(0, videoRef.current.volume - 0.1);
            setVolume(videoRef.current.volume);
          }
          break;
        case 'f':
        case 'F':
          void toggleFullscreen();
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 'Escape':
          if (document.fullscreenElement) void document.exitFullscreen();
          else onClose();
          break;
        case 'n':
        case 'N':
          changeEpisode(index + 1);
          break;
        default:
          break;
      }
      revealControls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changeEpisode, index, onClose, revealControls, seekBy, toggleFullscreen, toggleMute, togglePlay]);

  const playedPercent = duration > 0 ? (current / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  const seekToRatio = (ratio: number) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    video.currentTime = Math.max(0, Math.min(video.duration, video.duration * ratio));
  };

  return (
    <div
      className="player-page"
      onMouseMove={revealControls}
      onDoubleClick={() => void toggleFullscreen()}
    >
      <div className="player-stage">
        <video
          ref={videoRef}
          playsInline
          onClick={togglePlay}
          onVolumeChange={(e) => {
            const v = e.currentTarget;
            setVolume(v.volume);
            setMuted(v.muted);
          }}
        />

        {loading && !error && (
          <div className="player-loading">
            <div className="spinner" />
            <div>正在加载 {episodeLabel(episodeUrl, index)}…</div>
          </div>
        )}
        {error && (
          <div className="player-loading">
            <div style={{ maxWidth: 460, textAlign: 'center', lineHeight: 1.7 }}>
              <div style={{ fontSize: 15, marginBottom: 6 }}>{error}</div>
              <div style={{ color: '#8d97a8', fontSize: 12 }}>
                可切换集数或返回列表换一个片源（Esc 返回）
              </div>
            </div>
          </div>
        )}

        <div className="player-top" style={{ opacity: controlsVisible ? 1 : 0 }}>
          <button className="ctrl" onClick={onClose} title="返回（Esc）">
            <Icon name="left" size={20} />
          </button>
          <div>
            <div className="player-title">{target.title}</div>
            <div className="player-sub">
              {target.source.name} · {episodeLabel(episodeUrl, index)} · 共 {target.episodes.length} 集
            </div>
          </div>
          <div className="spacer" />
          <button className="ctrl" onClick={() => setCastOpen(true)} title="投屏到电视（DLNA）">
            <Icon name="tv" size={20} />
          </button>
          <button className="ctrl" onClick={() => setDrawerOpen(true)} title="选集（N 下一集）">
            <Icon name="list" size={20} />
          </button>
        </div>

        <div className="player-controls" style={{ opacity: controlsVisible ? 1 : 0 }}>
          <div
            className="progress"
            onMouseDown={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              seekToRatio((e.clientX - rect.left) / rect.width);
              const onMove = (ev: MouseEvent) => seekToRatio((ev.clientX - rect.left) / rect.width);
              const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
          >
            <div className="buffered" style={{ width: `${bufferedPercent}%` }} />
            <div className="played" style={{ width: `${playedPercent}%` }} />
            <div className="knob" style={{ left: `${playedPercent}%` }} />
          </div>
          <div className="controls-row">
            <button className="ctrl" onClick={togglePlay} title="播放/暂停（空格）">
              <Icon name={playing ? 'pause' : 'play'} size={20} filled={!playing} />
            </button>
            <button className="ctrl" onClick={() => changeEpisode(index - 1)} disabled={index === 0} title="上一集">
              <Icon name="left" size={18} />
            </button>
            <button
              className="ctrl"
              onClick={() => changeEpisode(index + 1)}
              disabled={index + 1 >= target.episodes.length}
              title="下一集（N）"
            >
              <Icon name="right" size={18} />
            </button>
            <span className="time">
              {formatTime(current)} / {formatTime(duration)}
            </span>
            <div className="spacer" />
            <button className="ctrl" onClick={toggleMute} title="静音（M）">
              <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={18} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const video = videoRef.current;
                if (!video) return;
                video.volume = Number(e.target.value);
                video.muted = Number(e.target.value) === 0;
              }}
              style={{ width: 92, accentColor: '#ff6b3d' }}
              aria-label="音量"
            />
            <button className="btn ghost" onClick={changeRate} title="倍速">
              {rate.toFixed(2).replace(/0$/, '')}x
            </button>
            <button className="ctrl" onClick={() => void toggleFullscreen()} title="全屏（F）">
              <Icon name={fullscreen ? 'minimize' : 'maximize'} size={18} />
            </button>
          </div>
        </div>
      </div>

      {castOpen && episodeUrl ? (
        <CastDialog
          url={episodeUrl}
          title={`${target.title} · ${episodeLabel(episodeUrl, index)}`}
          onClose={() => setCastOpen(false)}
          onCast={(deviceName) => toast.ok(`已投屏到「${deviceName}」`)}
        />
      ) : null}

      {drawerOpen && (
        <>
          <div className="drawer-mask" onClick={() => setDrawerOpen(false)} />
          <div className="drawer">
            <div className="drawer-head">
              <div>
                <div style={{ fontWeight: 600 }}>选集</div>
                <div style={{ color: '#8d97a8', fontSize: 12 }}>
                  {target.source.name} · 共 {target.episodes.length} 集
                </div>
              </div>
              <button className="ctrl" onClick={() => setDrawerOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="drawer-body">
              <div className="episodes" style={{ maxHeight: 'none' }}>
                {target.episodes.map((url, i) => (
                  <button
                    key={`${url}-${i}`}
                    className={`ep${i === index ? ' active' : ''}`}
                    onClick={() => changeEpisode(i)}
                  >
                    {episodeLabel(url, i)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
