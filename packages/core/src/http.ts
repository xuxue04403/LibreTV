/**
 * 可注入的 HTTP 客户端。
 *
 * 上游把抓取放在 Next.js 服务端（/api/*），因此不存在跨域问题；
 * 客户端直连采集站时浏览器有 CORS 限制、桌面端有 Electron 主进程代理、
 * Android 端有 OkHttp。这里只定义最小接口，由各宿主注入实现。
 */

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  /** 最终地址（跟随重定向后） */
  url: string;
  headers: Record<string, string>;
  /** 原始字节（gzip/二进制内容需要） */
  bytes: Uint8Array;
  /** UTF-8 解码后的文本 */
  text: string;
}

export interface HttpClient {
  request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 合并外部 signal 与超时 signal（AbortSignal.any 不可用时退化为先到先中断） */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const timeout = timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (!timeout) return signal;
  if (!signal) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([signal, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

/** 基于全局 fetch 的实现（Electron 渲染层 / 浏览器 / Node 18+ 可用） */
export function createFetchHttp(fetchImpl?: typeof fetch): HttpClient {
  const doFetch = fetchImpl ?? globalThis.fetch;
  return {
    async request(url, options = {}) {
      if (typeof doFetch !== 'function') throw new HttpError('当前环境没有 fetch 实现', 0);
      const { method = 'GET', headers = {}, body, timeoutMs, signal } = options;
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers,
          body,
          redirect: 'follow',
          signal: withTimeout(signal, timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          throw new HttpError('请求超时', 408);
        }
        throw new HttpError(err instanceof Error ? err.message : '网络请求失败', 0);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const headerMap: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headerMap[k.toLowerCase()] = v;
      });
      return {
        ok: res.ok,
        status: res.status,
        url: res.url || url,
        headers: headerMap,
        bytes: buf,
        text: new TextDecoder('utf-8').decode(buf),
      };
    },
  };
}

/** 字节流是否为 gzip（1f 8b 魔数） */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** 解 gzip：优先 DecompressionStream（浏览器 / Node 18+）；不可用时原样返回 */
export async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) return bytes;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return bytes;
  }
}

/** 便捷方法：请求并解析 JSON，失败时抛出带上下文的错误 */
export async function fetchJson<T>(http: HttpClient, url: string, options?: HttpRequestOptions): Promise<T> {
  const res = await http.request(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options?.headers ?? {}) },
  });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new HttpError('返回内容不是合法 JSON', res.status);
  }
}
