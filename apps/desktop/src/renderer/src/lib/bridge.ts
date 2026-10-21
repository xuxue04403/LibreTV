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

/**
 * 渲染层 HTTP 适配器：
 * 桌面端走主进程（无 CORS、可注入 UA），浏览器预览回退到 fetch。
 */
export const http: HttpClient = {
  async request(url, options = {}): Promise<HttpResponse> {
    if (!window.libretv) return fetchHttp.request(url, options);
    const res = await window.libretv.http(url, {
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      method: options.method,
      body: options.body,
    });
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
