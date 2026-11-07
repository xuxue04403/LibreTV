/**
 * 音量增强：Web Audio 直通 + 增益 + 限幅。
 *
 * 移植自上游 LibreTV 的 volume-boost（AGPL-3.0）。这里刻意保持三条铁律：
 * 1. 每个 `<video>` 只能 `createMediaElementSource` 一次，重复调用会抛错；
 * 2. 关闭增强时用「单位增益」直通，绝不 `disconnect`——一旦断开，元素音频
 *    会永久静音，且无法再重新接回同一个 source；
 * 3. AudioContext 被浏览器挂起时不能提前改道，必须等用户手势 resume，
 *    否则表现为「一开增强就整段无声」。
 */

const VOLUME_BOOST_GAIN = 1.8;

interface BoostChain {
  gain: GainNode;
  context: AudioContext;
  /** 用户期望的状态；context 恢复后按它落增益 */
  wanted: boolean;
}

const chains = new WeakMap<HTMLVideoElement, BoostChain>();
const sources = new WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>();

let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
  } catch {
    sharedContext = null;
  }
  return sharedContext;
}

/**
 * Web Audio 接管外部媒体的安全条件。
 *
 * 非同源资源如果没带 CORS，`createMediaElementSource` 会直接抛 SecurityError；
 * 代理资源都带 `Access-Control-Allow-Origin: *`，所以 `<video crossOrigin="anonymous">`
 * 之后即使 URL 是跨源的也能安全接管。
 */
export function isWebAudioSafeForVideo(video: HTMLVideoElement): boolean {
  const src = video.currentSrc || video.src;
  if (!src) return false;
  if (src.startsWith('blob:') || src.startsWith('data:')) return true;
  try {
    const url = new URL(src);
    if (url.origin === window.location.origin) return true;
  } catch {
    return false;
  }
  return video.crossOrigin === 'anonymous' || video.crossOrigin === 'use-credentials';
}

export interface VolumeBoostHandle {
  setBoost(enabled: boolean): void;
  dispose(): void;
}

function applyGain(chain: BoostChain, enabled: boolean): void {
  chain.gain.gain.value = enabled ? VOLUME_BOOST_GAIN : 1;
}

function resumeContext(chain: BoostChain): void {
  if (chain.context.state !== 'suspended') {
    applyGain(chain, chain.wanted);
    return;
  }
  const tryResume = () => {
    void chain.context.resume().then(
      () => applyGain(chain, chain.wanted),
      () => undefined,
    );
  };
  tryResume();
  // 自动播放策略下，effect 里的 resume() 可能不在用户手势里而被拒绝；
  // 等下一次点击/按键再试一次，期间保持单位增益，绝不出现「开了增强反而没声」。
  if (chain.context.state === 'suspended') {
    const once = () => {
      window.removeEventListener('pointerdown', once);
      window.removeEventListener('keydown', once);
      tryResume();
    };
    window.addEventListener('pointerdown', once, { once: true });
    window.addEventListener('keydown', once, { once: true });
  }
}

/**
 * 给一个 video 元素挂上增强链路；同一个元素重复调用返回同一个 handle。
 * 不安全的来源（无 CORS 的跨源直链）返回 null，调用方应保持原生音频。
 */
export function attachVolumeBoost(video: HTMLVideoElement): VolumeBoostHandle | null {
  const existing = chains.get(video);
  if (existing) {
    return {
      setBoost: (enabled) => {
        existing.wanted = enabled;
        if (enabled && existing.context.state === 'suspended') resumeContext(existing);
        else applyGain(existing, enabled);
      },
      dispose: () => {
        existing.wanted = false;
        applyGain(existing, false);
      },
    };
  }

  if (!isWebAudioSafeForVideo(video)) return null;
  const context = getAudioContext();
  if (!context) return null;

  let source = sources.get(video);
  if (!source) {
    try {
      source = context.createMediaElementSource(video);
    } catch {
      return null;
    }
    sources.set(video, source);
  }

  const gain = context.createGain();
  gain.gain.value = 1;
  const compressor = context.createDynamicsCompressor();
  // 峰值兜底：1.8× 后仍避免削波破音
  compressor.threshold.value = 0;
  compressor.knee.value = 0;
  compressor.ratio.value = 20;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  source.connect(gain);
  gain.connect(compressor);
  compressor.connect(context.destination);

  const chain: BoostChain = { gain, context, wanted: false };
  chains.set(video, chain);

  return {
    setBoost: (enabled) => {
      chain.wanted = enabled;
      if (enabled && context.state === 'suspended') resumeContext(chain);
      else applyGain(chain, enabled);
    },
    dispose: () => {
      chain.wanted = false;
      applyGain(chain, false);
    },
  };
}
