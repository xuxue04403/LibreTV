import { createFetchHttp, type HttpClient, type HttpResponse } from '@libretv/core';

export interface AppInfo {
  version: string;
  platform: string;
  /** 回环媒体代理解析出来的前缀（含 token），浏览器预览时为空 */
  proxyBase: string;
  isDev: boolean;
}

const FALLBACK_INFO: AppInfo = { version: 'dev', platform: 'web', proxyBase: '', isDev: true };

let info: AppInfo = FALLBACK_INFO;
let ready: Promise<AppInfo> | null = null;

/** 读取主进程信息（窗口启动时调用一次） */
export function initBridge(): Promise<AppInfo> {
  if (ready) return ready;
  ready = (async () => {
    if (window.libretv) {
      try {
        info = await window.libretv.info();
      } catch {
        info = FALLBACK_INFO;
      }
    }
    return info;
  })();
  return ready;
}

export function appInfo(): AppInfo {
  return info;
}

const fetchHttp = createFetchHttp();

let streamSeq = 0;

/**
 * 渲染层 HTTP 适配器：
 * 桌面端走主进程（无 CORS、可注入 UA），浏览器预览回退到 fetch。
 */
export const http: HttpClient = {
  async request(url, options = {}): Promise<HttpResponse> {
    if (!window.libretv) return fetchHttp.request(url, options);
    if (options.signal?.aborted) throw new Error('请求已取消');
    const pending = window.libretv.http(url, {
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      method: options.method,
      body: options.body,
    });
    // 主进程的 http:fetch 没有取消通道，但渲染层不该陪着等：
    // 搜索/分类切走之后旧请求要立刻放掉，否则「点了就走」的体验会被一条慢源拖住。
    const res = options.signal
      ? await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('请求已取消')), { once: true });
          }),
        ])
      : await pending;
    if (res.status === 0) throw new Error(res.error || '网络请求失败');
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      headers: res.headers,
      bytes: res.bytes,
      text: res.text,
    };
  },

  /**
   * 流式抓取：直播源（2.5MB / 近万频道）整串下载要一分钟以上，
   * 这里让分块边到边解析，第一批频道几百毫秒就能显示。
   * 没有主进程（浏览器预览）时退回 fetch 的流式实现。
   */
  async stream(url, options): Promise<HttpResponse> {
    if (!window.libretv) {
      if (!fetchHttp.stream) return fetchHttp.request(url, options);
      return fetchHttp.stream(url, options);
    }
    const streamId = ++streamSeq;
    const parts: Uint8Array[] = [];
    let total = 0;
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      void window.libretv?.streamCancel(streamId);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await window.libretv.stream(
        url,
        { headers: options.headers, idleTimeoutMs: options.idleTimeoutMs, streamId },
        (chunk) => {
          if (cancelled) return;
          total += chunk.byteLength;
          parts.push(chunk);
          options.onChunk(chunk);
        }
      );
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        bytes.set(p, offset);
        offset += p.byteLength;
      }
      if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
      return {
        ok: res.ok,
        status: res.status,
        url: res.url,
        headers: res.headers ?? {},
        bytes,
        text: new TextDecoder('utf-8').decode(bytes),
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  },
};

/** 视频流/分片地址改写成回环代理地址（自动补 UA/Referer、绕 CORS、可选广告过滤） */
export function proxify(url: string, opts: { ad?: boolean; image?: boolean } = {}): string {
  if (!info.proxyBase) return url;
  const route = opts.image ? 'i' : 'p';
  const ad = opts.ad ? '&ad=1' : '';
  return `${info.proxyBase}/${route}?url=${encodeURIComponent(url)}${ad}`;
}

/** 封面图地址：优先本地代理（防采集站/豆瓣防盗链），无代理时直连 */
export function posterUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!/^https?:\/\//i.test(url)) return undefined;
  return proxify(url, { image: true });
}

/**
 * 让主进程在后台预取接下来几个分片。
 *
 * 点击播放的那一刻就把前 8 个分片抓进代理进程的内存缓存，
 * 播放器真正开始拉流时这些分片已经是本地内存命中——这是「点开就播」的关键。
 * 故意不 await：预取是锦上添花，失败了播放也照常进行。
 */
export function prefetchSegments(url: string, opts: { ad?: boolean; count?: number } = {}): void {
  if (!info.proxyBase || !/^https?:\/\//i.test(url)) return;
  const count = opts.count ?? 8;
  const ad = opts.ad ? '&ad=1' : '';
  const target = `${info.proxyBase}/prefetch?url=${encodeURIComponent(url)}&count=${count}${ad}`;
  // 用 setTimeout 让出一帧：调用点在播放按钮里，别让网络动作压在点击处理上
  setTimeout(() => {
    void fetch(target).catch(() => {
      /* 预取失败不影响播放 */
    });
  }, 0);
}

// —— 投屏（DLNA 发送端） ——

export interface DlnaDeviceInfo {
  name: string;
  location: string;
  controlUrl: string;
}

/** 搜索局域网内可投屏设备（SSDP），约 2 秒 */
export async function discoverDlnaDevices(): Promise<{ devices: DlnaDeviceInfo[]; error?: string }> {
  if (!window.libretv) return { devices: [], error: '投屏仅在桌面端可用' };
  const result = await window.libretv.dlnaDiscover();
  return { devices: result.devices ?? [], error: result.ok ? undefined : result.error };
}

/** 把影片地址推送到指定设备并开始播放 */
export async function castToDlna(
  device: DlnaDeviceInfo,
  url: string,
  title: string
): Promise<{ ok: boolean; error?: string }> {
  if (!window.libretv) return { ok: false, error: '投屏仅在桌面端可用' };
  return window.libretv.dlnaCast(device, url, title);
}
