/**
 * 桌面端回环媒体代理（仅监听 127.0.0.1，随机端口 + 随机 token）。
 *
 * 为什么需要它：Chromium 渲染层受 CORS 约束，hls.js 拉取跨域分片、
 * <video> 播放直链、<img> 加载豆瓣/采集站图床都会失败或缺少 Referer。
 * 上游用 Next.js 的 /api/proxy 解决；桌面端把同样的能力收敛为进程内的
 * 一个小型 HTTP 服务，不对外网暴露、不需要部署。
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

/** 单个响应体上限（分片通常几 MB，留足余量避免内存被拖爆） */
const MAX_BODY_BYTES = 96 * 1024 * 1024;

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
async function assertAllowedTarget(raw: string, allowPrivate: boolean): Promise<URL> {
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
      // 属性里带 URI 的标签：密钥 / 初始化段 / 备用媒体 / 低延迟分片
      return trimmed.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${proxify(uri)}"`);
    })
    .join('\n');
}

function isPlaylist(res: Response, body: string): boolean {
  const type = res.headers.get('content-type') || '';
  if (/mpegurl/i.test(type)) return true;
  return body.trimStart().startsWith('#EXTM3U');
}

async function readLimited(res: Response): Promise<Buffer> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) throw new Error('响应体过大');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) throw new Error('响应体过大');
  return buf;
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

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

    const init: RequestInit & { duplex?: string } = { method: 'GET', headers, redirect: 'follow' };
    const upstream = await fetch(targetUrl.href, init);

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    if (route === '/i') {
      const buf = await readLimited(upstream);
      res.writeHead(upstream.status, {
        'Content-Type': contentType,
        'Content-Length': String(buf.byteLength),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(buf);
      return;
    }

    const buf = await readLimited(upstream);
    const text = buf.toString('utf8');

    if (upstream.ok && isPlaylist(upstream, text)) {
      const rewritten = rewritePlaylist(text, targetUrl.href, `${base}${prefix}`, adFilter);
      const out = Buffer.from(rewritten, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': String(out.byteLength),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(out);
      return;
    }

    const passthrough: Record<string, string | number> = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) passthrough['Content-Range'] = contentRange;
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) passthrough['Accept-Ranges'] = acceptRanges;
    passthrough['Content-Length'] = String(buf.byteLength);
    res.writeHead(upstream.status, passthrough);
    res.end(buf);
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
        server.close(() => resolve());
      }),
  };
}
