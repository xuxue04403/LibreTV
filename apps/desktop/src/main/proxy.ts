/**
 * 桌面端回环媒体代理（仅监听 127.0.0.1，随机端口 + 随机 token）。
 *
 * 为什么需要它：Chromium 渲染层受 CORS 约束，hls.js 拉取跨域分片、
 * <video> 播放直链、<img> 加载豆瓣/采集站图床都会失败或缺少 Referer。
 * 上游用 Next.js 的 /api/proxy 解决；桌面端把同样的能力收敛为进程内的
 * 一个小型 HTTP 服务，不对外网暴露、不需要部署。
 *
 * 性能约束（v0.3 起）：
 * - 媒体分片必须**流式直通**：老实现把整个分片读进 Buffer 再回写，一个 6MB
 *   的分片要经历「上游→内存→本地 socket」两次全量拷贝，播放起播慢、seek 更慢；
 * - 只有播放列表（m3u8）需要读成文本做改写，且限制在很小的体积内；
 * - 分片允许浏览器缓存（内容按 URL 不变），seek 回来不必重新下。
 *
 * 安全边界：
 * - 只监听回环地址，URL 必须带随机 token（网页无法猜出）；
 * - 拒绝内网/回环/链路本地目标（避免被页面当作内网探测跳板）；
 * - 仅放行 http(s)。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { stripAdGroups } from '@libretv/core';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 需要整体读入内存的响应体上限（播放列表/图片，通常几十 KB） */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** 流式直通的总量上限：只防失控，正常分片远小于这个值 */
const MAX_STREAM_BYTES = 1024 * 1024 * 1024;
/** 重定向跟随上限：每跳都要重新校验，避免无限套娃 */
const MAX_REDIRECTS = 3;
/** 媒体代理只应服务这几类内容，其余一律按二进制处理且不发可执行 MIME */
const SAFE_IMAGE_TYPES = /^image\//i;
/** 分片这类不可变内容，允许浏览器缓存，seek 回来直接命中 */
const CACHE_SEGMENT = 'public, max-age=3600, immutable';

export interface MediaProxy {
  base: string;
  token: string;
  close: () => Promise<void>;
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // IPv4-mapped IPv6
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return false;
}

/** 目标地址校验：协议白名单 + 内网地址拒绝（DNS 解析后校验，防域名绕过） */
export async function assertAllowedTarget(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('无效地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http(s) 地址');
  if (allowPrivate) return url;
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('拒绝访问本机地址');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('拒绝访问内网地址');
    return url;
  }
  const records = await dns.lookup(host, { all: true }).catch(() => []);
  if (records.length === 0) throw new Error('域名解析失败');
  if (records.some((r) => isPrivateAddress(r.address))) throw new Error('拒绝访问内网地址');
  return url;
}

/**
 * 带逐跳校验的 fetch。
 *
 * 为什么不能用 `redirect: 'follow'`：校验只发生在入口，一旦上游 302 到内网地址，
 * 后续请求完全脱离控制（实测可借代理读回 127.0.0.1 上的内容）。
 * 这里改为手动跟随，每一跳都重新跑一遍校验。
 *
 * @param validate 每一跳都要通过的地址校验，默认用 assertAllowedTarget
 */
export async function fetchChecked(
  target: URL,
  init: RequestInit & { duplex?: string },
  allowPrivate: boolean,
  validate: (raw: string, allowPrivate: boolean) => Promise<URL> = assertAllowedTarget
): Promise<Response> {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.href, { ...init, redirect: 'manual', method: init.method });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      // 释放这一跳的连接，避免 keep-alive 池堆积
      await res.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('重定向地址无效');
      }
      current = await validate(next.href, allowPrivate);
      continue;
    }
    return res;
  }
  throw new Error('重定向次数过多');
}

/** 把远端播放列表里的相对/绝对地址全部改写成经过本代理的地址 */
function rewritePlaylist(body: string, baseUrl: string, proxyBase: string, adFilter: boolean): string {
  const proxify = (target: string): string => {
    try {
      const abs = new URL(target, baseUrl).href;
      return `${proxyBase}/p?ad=${adFilter ? 1 : 0}&url=${encodeURIComponent(abs)}`;
    } catch {
      return target;
    }
  };

  const text = adFilter ? stripAdGroups(body) : body;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (!trimmed.startsWith('#')) return proxify(trimmed);
      // 属性里带 URI 的标签：密钥 / 初始化段 / 备用媒体 / 低延迟分片。
      // 少数打包器写单引号，两种都要处理。
      return trimmed
        .replace(/URI="([^"]+)"/gi, (_m, uri: string) => `URI="${proxify(uri)}"`)
        .replace(/URI='([^']+)'/gi, (_m, uri: string) => `URI="${proxify(uri)}"`);
    })
    .join('\n');
}

function isPlaylist(res: Response, body: string): boolean {
  const type = res.headers.get('content-type') || '';
  if (/mpegurl/i.test(type)) return true;
  // 带 UTF-8 BOM 的 m3u8 也要认：否则会被当二进制透传，播放器直接黑屏
  return body.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

/** 从响应体开头判断是不是 m3u8（只看前 64 字节，避免为了判断而读满整个分片） */
function looksLikePlaylistHead(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  const text = Buffer.from(head.buffer, head.byteOffset, Math.min(head.length, 64)).toString('utf8');
  return text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
}

/**
 * 有上限地读取响应体（只用于播放列表与图片这类小对象）。
 *
 * 之前的实现在 `arrayBuffer()` 之后才判长度——那时数据已经全量进堆，
 * 判长只能挡「写完才发现超了」，挡不住 OOM。这里改为流式累加，超限立即取消。
 */
async function readLimited(res: Response, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('响应体过大');
  }
  if (!res.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) {
      await res.body.cancel().catch(() => undefined);
      throw new Error('响应体过大');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** 把已经读走的第一块拼回去，得到完整响应体 */
async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>, first: Uint8Array | null): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  if (first) {
    chunks.push(Buffer.from(first));
    total += first.byteLength;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('响应体过大');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** 供单测直接验证 m3u8 改写（生产路径只经 handle 调用） */
export const rewritePlaylistForTest = rewritePlaylist;
export const isPlaylistForTest = isPlaylist;

export async function startMediaProxy(): Promise<MediaProxy> {
  const token = crypto.randomBytes(16).toString('hex');
  let base = '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendText(res, 502, `代理失败：${err instanceof Error ? err.message : '未知错误'}`);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url) {
      sendText(res, 400, '缺少参数');
      return;
    }
    const url = new URL(req.url, base);
    const prefix = `/t/${token}`;
    if (!url.pathname.startsWith(prefix)) {
      sendText(res, 403, 'token 无效');
      return;
    }
    const route = url.pathname.slice(prefix.length);
    if (route !== '/p' && route !== '/i') {
      sendText(res, 404, '未知路由');
      return;
    }

    const target = url.searchParams.get('url') || '';
    const adFilter = url.searchParams.get('ad') === '1';
    // 自建/联调场景：允许访问内网媒体源（默认关闭，保持 SSRF 边界）
    const allowPrivate = process.env.LTV_ALLOW_PRIVATE_MEDIA === '1';
    let targetUrl: URL;
    try {
      targetUrl = await assertAllowedTarget(target, allowPrivate);
    } catch (err) {
      sendText(res, 400, err instanceof Error ? err.message : '地址不可用');
      return;
    }

    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      Accept: '*/*',
      // 采集站/图床常见防盗链要求
      Referer: `${targetUrl.origin}/`,
    };
    const range = req.headers.range;
    if (range) headers.Range = String(range);
    const encoding = req.headers['accept-encoding'];
    if (encoding) headers['Accept-Encoding'] = String(encoding);

    const init: RequestInit & { duplex?: string } = {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'manual',
    };
    // 逐跳校验重定向：上游 302 到 127.0.0.1 / 内网必须被拦下
    const upstream = await fetchChecked(targetUrl, init, allowPrivate);

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const bodyless = upstream.status === 204 || upstream.status === 304;

    if (route === '/i') {
      const buf = await readLimited(upstream, 8 * 1024 * 1024);
      // 只放行图片类型：避免把 text/html 以同源方式回给渲染层（等于给 XSS 开门）
      const safeType = SAFE_IMAGE_TYPES.test(contentType) ? contentType : 'application/octet-stream';
      res.writeHead(upstream.status, {
        'Content-Type': safeType,
        'Content-Length': String(buf.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': CACHE_SEGMENT,
      });
      res.end(buf);
      return;
    }

    // —— /p 媒体路由 ——
    // content-type 直接标明是播放列表时无需窥探；否则先读第一块判断
    const declaredPlaylist = /mpegurl/i.test(contentType);
    const reader = upstream.body && !bodyless ? upstream.body.getReader() : null;
    let first: Uint8Array | null = null;
    if (reader && !declaredPlaylist) {
      const read = await reader.read();
      if (!read.done) first = read.value;
    }

    const playlist = declaredPlaylist || (first ? looksLikePlaylistHead(first) : false);

    if (playlist) {
      if (!reader) {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': '0',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      // 播放列表是小文本：整体读入 → 改写成代理地址
      const buf = await readRest(reader, first);
      const text = buf.toString('utf8');
      const rewritten = upstream.ok ? rewritePlaylist(text, targetUrl.href, `${base}${prefix}`, adFilter) : text;
      const out = Buffer.from(rewritten, 'utf8');
      res.writeHead(upstream.ok ? 200 : upstream.status, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': String(out.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(out);
      return;
    }

    // 真正的媒体分片：流式直通，边下边发，不在内存里攒完整块
    await pipeStream(upstream, reader, first, res, contentType, req);
  }

  /**
   * 把上游响应体流式转发给渲染层。
   *
   * 关键点：
   * - 不缓冲整个分片，首字节到达就往下游写（起播快、seek 快）；
   * - 尊重下游背压（`res.write` 返回 false 时等 drain），否则大分片会堆在内存；
   * - 下游提前断开时取消上游读取，避免继续下载已无人消费的数据。
   */
  async function pipeStream(
    upstream: Response,
    reader: ReadableStreamDefaultReader<Uint8Array> | null,
    first: Uint8Array | null,
    res: ServerResponse,
    contentType: string,
    req: IncomingMessage
  ): Promise<void> {
    const headers: Record<string, string | number> = {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      // 分片内容按 URL 恒定：允许缓存，seek/重播不用回源
      'Cache-Control': CACHE_SEGMENT,
    };
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) headers['Content-Length'] = contentLength;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers['Content-Range'] = contentRange;
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;

    res.writeHead(upstream.status, headers);

    if (req.method === 'HEAD' || !reader) {
      res.end();
      return;
    }

    let closed = false;
    res.on('close', () => {
      closed = true;
      void reader.cancel().catch(() => undefined);
    });

    let total = 0;
    const write = async (chunk: Uint8Array): Promise<boolean> => {
      total += chunk.byteLength;
      if (total > MAX_STREAM_BYTES) return false;
      if (res.write(chunk)) return true;
      await new Promise<void>((resolve) => res.once('drain', resolve));
      return !closed;
    };

    try {
      if (first && first.byteLength > 0 && !(await write(first))) {
        res.end();
        return;
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(await write(value))) break;
      }
    } catch {
      /* 上游中途断流：已发出的部分保留，直接结束响应 */
    } finally {
      res.end();
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('媒体代理启动失败');
  base = `http://127.0.0.1:${address.port}`;

  return {
    base: `${base}/t/${token}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        // keep-alive 连接不会自己断，必须先强制关掉，否则 close 回调永远不来
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
