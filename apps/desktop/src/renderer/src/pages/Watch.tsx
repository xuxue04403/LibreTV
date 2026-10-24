import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  candidateLabel,
  candidateKey,
  discoverCandidates,
  episodeLabel,
  fetchDetail,
  formatTime,
  historyId,
  pickEpisodeIndex,
  type PlaybackCandidate,
} from '@libretv/core';
import { http, proxify } from '../lib/bridge';
import { useAppStore } from '../lib/store';
import { useToast } from '../components/Toast';
import { CastDialog } from '../components/CastDialog';
import { Icon } from '../components/Icons';

/** 正在播放的源；autoFailover 时播放失败会自动切到 candidates 里的下一个 */
export interface WatchTarget {
  source: { key: string; name: string; url: string; detail?: string; isAdult?: boolean };
  vodId: string;
  title: string;
  /** 年份：同名不同年的翻拍片靠它区分观看记录 */
  year?: string;
  cover?: string;
  episodes: string[];
  startIndex: number;
  /** 同片源候选链（含当前源，当前源排第一）；缺省时退化为「不自动换源」 */
  candidates?: PlaybackCandidate[];
}

const SKIP_SECONDS = 10;
/** 同一集内允许的自动重试次数（分片抖动通常一次就好，再失败就换源） */
const MAX_RECOVERIES = 2;
/** 连续缓冲多久判定为「卡死」，触发换源（毫秒） */
const STALL_MS = 12_000;

export function WatchPage({ target, onClose }: { target: WatchTarget; onClose: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const recordHistory = useAppStore((s) => s.recordHistory);
  const toast = useToast();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRef = useRef(0);
  const triedRef = useRef<Set<string>>(new Set());
  /** 本集已尝试恢复的次数（不进 state，避免每次报错都触发重渲染） */
  const recoverRef = useRef(0);
  /** 是否已经按片名反查过补充候选（只查一次） */
  const discoveredRef = useRef(false);
  /** 进行中的换源任务：同一时刻只跑一轮，避免并发换源互相覆盖状态 */
  const failoverRef = useRef<Promise<boolean> | null>(null);
  const sources = useAppStore((s) => s.sources);

  /** 当前播放的候选（换源后指向新源） */
  const [active, setActive] = useState<PlaybackCandidate | null>(null);
  const [episodes, setEpisodes] = useState(target.episodes);
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
  /** 全屏真实状态（ref 供事件回调与卸载清理读取，避免闭包拿到旧值） */
  const fullscreenRef = useRef(false);
  /** 进播放页时窗口是否已经全屏（决定退出时要不要还原） */
  const fullscreenBeforeRef = useRef(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [castOpen, setCastOpen] = useState(false);
  const [failoverNote, setFailoverNote] = useState<string | null>(null);
  // 递增即重载当前集：本集恢复失败后重来一次，而不是干等
  const [reloadToken, setReloadToken] = useState(0);

  /** 候选链：换源时可能按片名反查追加，所以放 state；ref 供回调读取最新值 */
  const [candidates, setCandidates] = useState<PlaybackCandidate[]>(target.candidates ?? []);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const currentSource = active?.source ?? target.source;
  const currentSourceName = active?.sourceName ?? target.source.name;
  const episodeUrl = episodes[index];

  // 首次进入时把当前源记为「已试过」，避免换源又切回刚失败的源
  useEffect(() => {
    triedRef.current.add(candidateKey({ sourceKey: target.source.key, vodId: target.vodId }));
  }, [target.source.key, target.vodId]);

  /**
   * 保存进度（同一影片去重置顶）。
   *
   * `finished = true` 表示这一集看完了：位置写 0、集数推到下一集，
   * 这样首页进度条归零、「继续观看」直接从下一集开始。
   * 不能靠传 0 位置来表达「看完」，那会被位置守卫当成无效写入丢掉。
   */
  const persistProgress = useCallback(
    (position: number, epIndex: number, total: number, finished = false) => {
      if (!settings.resumePlayback) return;
      if (!finished && (!Number.isFinite(position) || position <= 0)) return;
      const nextIndex = finished ? Math.min(epIndex + 1, episodes.length) : epIndex;
      recordHistory({
        id: historyId(currentSource.key, active?.vodId ?? target.vodId),
        sourceKey: currentSource.key,
        vodId: active?.vodId ?? target.vodId,
        title: target.title,
        year: target.year,
        cover: target.cover,
        sourceName: currentSourceName,
        episodeIndex: nextIndex,
        episodeCount: episodes.length,
        episodeUrl: episodes[nextIndex] ?? episodes[epIndex],
        position: finished ? 0 : position,
        duration: Number.isFinite(total) ? total : 0,
      });
      savedRef.current = finished ? 0 : position;
    },
    [active?.vodId, currentSource, currentSourceName, episodes, recordHistory, settings.resumePlayback, target.cover, target.title, target.vodId, target.year]
  );

  /**
   * 自动换源：把当前集数对齐到下一个候选源，重新加载。
   *
   * 候选链试完之后，只要还有其它源，就按片名反查一轮补充候选
   * （从历史/收藏进来的场景手里只有一个源，不补就无路可走）。
   * 补出来的候选也全部试完才认输，避免无限循环。
   */
  const failover = useCallback(
    (reason: string): Promise<boolean> => {
      // 同一时刻只允许一轮换源：看门狗、hls 致命错误、用户按 S 可能几乎同时触发，
      // 两轮并行会各挑一个候选、互相覆盖 active/episodes，还会同时建两个 Hls 实例。
      if (failoverRef.current) return failoverRef.current;
      const task = (async (): Promise<boolean> => {
      for (;;) {
        const untried = candidatesRef.current.filter((candidate) => !triedRef.current.has(candidateKey(candidate)));
        if (untried.length === 0) {
          if (discoveredRef.current) return false;
          discoveredRef.current = true;
          setFailoverNote(`${reason}，正在查找其它片源…`);
          const extra = await discoverCandidates(target.title, sources, http, {
            exclude: triedRef.current,
            timeoutMs: 8_000,
          }).catch(() => [] as PlaybackCandidate[]);
          if (extra.length === 0) {
            setFailoverNote(null);
            return false;
          }
          candidatesRef.current = [...candidatesRef.current, ...extra];
          setCandidates(candidatesRef.current);
          continue;
        }

        const next = untried[0];
        triedRef.current.add(candidateKey(next));
        setFailoverNote(`${reason}，正在切换到「${candidateLabel(next)}」…`);
        setError(null);
        setLoading(true);
        try {
          const parsed = await fetchDetail(next.source, next.vodId, http, { timeoutMs: 8_000 });
          if (parsed.episodes.length === 0) throw new Error('该源无可用地址');
          setActive(next);
          setEpisodes(parsed.episodes);
          setIndex(pickEpisodeIndex(index, parsed.episodes.length));
          setFailoverNote(`已切换到「${candidateLabel(next)}」`);
          setTimeout(() => setFailoverNote(null), 2600);
          return true;
        } catch {
          setLoading(false);
          // 这个源拿不到详情，继续试下一个
        }
      }
      })();
      failoverRef.current = task.finally(() => {
        failoverRef.current = null;
      });
      return failoverRef.current;
    },
    [index, sources, target.title]
  );

  // —— 初始化/切换集数 ——
  // 换集或换源时重置恢复计数；reloadToken 触发的重载不算新尝试
  useEffect(() => {
    recoverRef.current = 0;
  }, [episodeUrl, active]);

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
    let disposed = false;

    /**
     * 出错时先在本集上重载恢复，恢复不了再换源。
     *
     * 必须真的重新加载：hls.js 报出致命网络错误后自身已停止加载，
     * 光把计数加一、弹个提示，是等不到第二个错误事件的，界面会永久卡住。
     */
    const handleFatal = (message: string) => {
      if (disposed) return;
      if (recoverRef.current < MAX_RECOVERIES) {
        recoverRef.current += 1;
        setError(`${message}（第 ${recoverRef.current} 次尝试恢复）`);
        setLoading(true);
        setReloadToken((token) => token + 1);
        return;
      }
      setError(message);
      setLoading(false);
      void failover(message);
    };

    if (isHls) {
      if (Hls.isSupported()) {
        hls = new Hls({
          // 播放更顺的关键：起播只要 2 个分片，往前多看 30 秒
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 30,
          maxMaxBufferLength: 90,
          backBufferLength: 30,
          maxBufferSize: 60 * 1000 * 1000,
          // 分片失败快速失败并交给换源，而不是无限 startLoad 卡住
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 2,
          fragLoadingMaxRetry: 2,
          fragLoadingRetryDelay: 500,
          startLevel: -1,
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls?.recoverMediaError();
            handleFatal('解码错误');
            return;
          }
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            handleFatal('网络错误：分片加载失败');
            return;
          }
          handleFatal('播放失败：该片源可能已失效');
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

    // 直链没有 hls.js 的错误事件，靠 video 元素自己的 error 事件触发换源
    const onVideoError = () => {
      if (disposed) return;
      const code = video.error?.code;
      handleFatal(code === MediaError.MEDIA_ERR_DECODE ? '解码错误' : '网络错误：无法加载视频');
    };
    video.addEventListener('error', onVideoError);

    const resume = settings.resumePlayback
      ? useAppStore.getState().history.find((h) => h.id === historyId(currentSource.key, active?.vodId ?? target.vodId))
      : undefined;
    const onLoaded = () => {
      if (disposed) return;
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
      disposed = true;
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onVideoError);
      hls?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeUrl, index, settings.adFilter, active, reloadToken]);

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
    const clearStall = () => {
      if (stallTimer.current) {
        clearTimeout(stallTimer.current);
        stallTimer.current = null;
      }
    };
    const onPause = () => {
      setPlaying(false);
      // 暂停后不会再有 playing 事件，卡死定时器必须在这里清掉，
      // 否则「暂停中拖进度条」会被误判成加载超时并自动换源
      clearStall();
      setLoading(false);
      persistProgress(video.currentTime, index, video.duration);
    };
    const onDuration = () => setDuration(video.duration || 0);
    const onEnded = () => {
      setPlaying(false);
      clearStall();
      setLoading(false);
      persistProgress(video.currentTime, index, video.duration, true);
      if (settings.autoplayNext && index + 1 < episodes.length) {
        setIndex((i) => i + 1);
      }
    };
    // 一直卡在 buffering 超过 STALL_MS 也要换源，否则用户只能看到无限转圈
    const onWaiting = () => {
      // 暂停状态下的 seeking 也会派发 waiting，这种情况不该判成卡死
      if (video.paused) return;
      setLoading(true);
      clearStall();
      stallTimer.current = setTimeout(() => {
        setLoading(false);
        setError('加载超时');
        void failover('加载超时');
      }, STALL_MS);
    };
    const onPlaying = () => {
      setLoading(false);
      clearStall();
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('ended', onEnded);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    return () => {
      clearStall();
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
    };
  }, [episodes.length, failover, index, persistProgress, settings.autoplayNext]);

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
      if (next < 0 || next >= episodes.length) return;
      persistProgress(videoRef.current?.currentTime ?? 0, index, videoRef.current?.duration ?? 0);
      // 换集不算失败：重置已试过的源，让新一集仍可以从当前源开始
      triedRef.current.clear();
      triedRef.current.add(candidateKey({ sourceKey: currentSource.key, vodId: active?.vodId ?? target.vodId }));
      setError(null);
      setIndex(next);
      setDrawerOpen(false);
    },
    [active?.vodId, currentSource.key, episodes.length, index, persistProgress, target.vodId]
  );

  /** 手动换源（用户点错误面板上的按钮，或选集抽屉里的源徽章） */
  const manualSwitch = useCallback(async () => {
    const ok = await failover('手动切换');
    if (!ok) toast.err('已经没有其它可用片源了');
  }, [failover, toast]);

  /** 把窗口全屏切换到指定状态（同时更新 ref / state） */
  const applyFullscreen = useCallback(
    async (value: boolean): Promise<void> => {
      fullscreenRef.current = value;
      setFullscreen(value);
      if (window.libretv) {
        await window.libretv.setFullscreen(value);
        return;
      }
      // 浏览器里预览时的兜底：Electron 走窗口全屏，网页版只能走元素全屏
      try {
        if (value && !document.fullscreenElement) await document.documentElement.requestFullscreen();
        else if (!value && document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // 浏览器拒绝全屏（非用户手势等）时保持原状即可
      }
    },
    []
  );

  const toggleFullscreen = useCallback(async () => {
    await applyFullscreen(!fullscreenRef.current);
  }, [applyFullscreen]);

  // 进播放页先对齐一次真实状态，并订阅主进程回推（F11 / 菜单栏的全屏不经过这里的按钮）
  useEffect(() => {
    let alive = true;
    void window.libretv?.isFullscreen().then((on) => {
      if (!alive) return;
      // 进页面那一刻的状态就是「用户原本的状态」，退出时据此决定要不要还原
      fullscreenBeforeRef.current = on;
      fullscreenRef.current = on;
      setFullscreen(on);
    });
    const off = window.libretv?.onFullscreenChange((on) => {
      fullscreenRef.current = on;
      setFullscreen(on);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // 退出播放页时把窗口还原：全屏通常是在播放页里开的，退出播放还停在满屏
  // 会让人找不到窗口边框（也关不掉），只能在首页再按一次 F11。
  //
  // 但如果进播放页之前窗口就已经全屏（用户自己按 F11 或系统记忆的窗口状态），
  // 那就不是「播放页开的」，不能替他退出去。

  useEffect(
    () => () => {
      if (!fullscreenRef.current || fullscreenBeforeRef.current) return;
      fullscreenRef.current = false;
      if (window.libretv) void window.libretv.setFullscreen(false);
      else if (document.fullscreenElement) void document.exitFullscreen();
    },
    []
  );

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
      // 输入框/滑块里打字时不抢快捷键，但 Esc 要例外：
      // 拖完音量滑块焦点会留在 input 上，那时按 Esc 用户就是想退出播放。
      const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (inField && e.key !== 'Escape') return;
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
        case 's':
        case 'S':
          void manualSwitch();
          break;
        case 'Escape':
          // 先退全屏再退播放：全屏下按 Esc 的直觉是「退出全屏」，
          // 原来直接关播放页会把窗口留在全屏里。
          if (fullscreenRef.current || document.fullscreenElement) void applyFullscreen(false);
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
  }, [applyFullscreen, changeEpisode, index, manualSwitch, onClose, revealControls, seekBy, toggleFullscreen, toggleMute, togglePlay]);

  const playedPercent = duration > 0 ? (current / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  const seekToRatio = (ratio: number) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    video.currentTime = Math.max(0, Math.min(video.duration, video.duration * ratio));
  };

  const remainingCandidates = candidates.filter((candidate) => !triedRef.current.has(candidateKey(candidate))).length;

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
        {failoverNote && (
          <div className="player-loading" style={{ background: 'transparent', pointerEvents: 'none' }}>
            <div className="chip on" style={{ padding: '8px 14px', fontSize: 13 }}>
              {failoverNote}
            </div>
          </div>
        )}
        {error && (
          <div className="player-loading">
            <div style={{ maxWidth: 480, textAlign: 'center', lineHeight: 1.7 }}>
              <div style={{ fontSize: 15, marginBottom: 6 }}>{error}</div>
              <div style={{ color: '#8d97a8', fontSize: 12 }}>
                {remainingCandidates > 0
                  ? `还有 ${remainingCandidates} 个片源可尝试`
                  : '可用片源都试过了，可切换集数或返回列表'}
              </div>
              <div className="row" style={{ justifyContent: 'center', gap: 10, marginTop: 14 }}>
                <button className="btn primary" onClick={() => void manualSwitch()} disabled={remainingCandidates === 0}>
                  换一个片源（S）
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    // 重试等于从头再来：忘了试过哪些源，可重新走一遍候选链
                    triedRef.current.clear();
                    triedRef.current.add(candidateKey({ sourceKey: currentSource.key, vodId: target.vodId }));
                    discoveredRef.current = false;
                    recoverRef.current = 0;
                    setReloadToken((token) => token + 1);
                  }}
                >
                  重试
                </button>
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
              {currentSourceName} · {episodeLabel(episodeUrl, index)} · 共 {episodes.length} 集
              {candidates.length > 1 ? ` · ${candidates.length} 个片源` : ''}
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
              disabled={index + 1 >= episodes.length}
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
            <button
              className="ctrl"
              onClick={() => void toggleFullscreen()}
              title={fullscreen ? '退出全屏（F）' : '全屏（F）'}
            >
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
                  {currentSourceName} · 共 {episodes.length} 集
                </div>
              </div>
              <button className="ctrl" onClick={() => setDrawerOpen(false)}>
                <Icon name="x" size={18} />
              </button>
            </div>
            {candidates.length > 1 ? (
              <div className="row" style={{ flexWrap: 'wrap', gap: 8, padding: '0 18px 10px' }}>
                <span style={{ color: '#8d97a8', fontSize: 12 }}>片源</span>
                {candidates.map((candidate) => {
                  const isCurrent = candidateKey(
                    active ?? { sourceKey: target.source.key, vodId: target.vodId }
                  ) === candidateKey(candidate);
                  const tried = triedRef.current.has(candidateKey(candidate));
                  return (
                    <button
                      key={candidateKey(candidate)}
                      className={`chip${isCurrent ? ' on' : ''}`}
                      style={{ cursor: 'pointer', opacity: tried && !isCurrent ? 0.55 : 1 }}
                      title={tried && !isCurrent ? '这一集已经试过，失败了' : '切换到这个片源'}
                      onClick={async () => {
                        if (isCurrent) return;
                        const parsed = await fetchDetail(candidate.source, candidate.vodId, http, { timeoutMs: 8_000 });
                        if (parsed.episodes.length === 0) {
                          toast.err('该片源暂无可用地址');
                          return;
                        }
                        triedRef.current.delete(candidateKey(candidate));
                        setActive(candidate);
                        setEpisodes(parsed.episodes);
                        setIndex(Math.max(0, Math.min(index, parsed.episodes.length - 1)));
                        setError(null);
                        setDrawerOpen(false);
                      }}
                    >
                      {candidateLabel(candidate)}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="drawer-body">
              <div className="episodes" style={{ maxHeight: 'none' }}>
                {episodes.map((url, i) => (
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
