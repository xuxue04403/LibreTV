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
/**
 * 预取缓存上限。
 *
 * 起播时的瓶颈是「等第一个分片从上游下来」。点击播放的同时后台按顺序抓
 * 前若干分片放进这张表，播放器再来要同一个分片时直接从内存回，省掉整个 RTT。
 * 64MB 约合 1~2 分钟的 1080p 内容，足够盖住起播与首次 seek。
 */
const PREFETCH_MAX_BYTES = 64 * 1024 * 1024;
/** 单个分片参与预取的上限：太大的分片占用配额不值得 */
const PREFETCH_MAX_SEGMENT = 8 * 1024 * 1024;
/** 默认预取的分片数：够覆盖起播缓冲（hls.js 默认 30 秒）即可，多了纯浪费带宽 */
const PREFETCH_DEFAULT_COUNT = 8;
/** 预取并发：和播放抢带宽，别开太大 */
const PREFETCH_CONCURRENCY = 3;

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

/**
 * 预取分片的内存缓存。
 *
 * 键是**原始上游地址**（不含代理 token），这样换 token/换端口都不影响命中。
 * LRU：播放器真去要某个分片时把它挪到队尾，淘汰从队首开始。
 */
interface PrefetchEntry {
  body: Buffer;
  contentType: string;
  status: number;
  headers: Record<string, string>;
}

class SegmentCache {
  private readonly map = new Map<string, PrefetchEntry>();
  private bytes = 0;

  get(key: string): PrefetchEntry | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    // 命中即刷新 LRU 位置
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  put(key: string, entry: PrefetchEntry): void {
    if (entry.body.byteLength > PREFETCH_MAX_SEGMENT) return;
    const existing = this.map.get(key);
    if (existing) {
      this.bytes -= existing.body.byteLength;
      this.map.delete(key);
    }
    this.map.set(key, entry);
    this.bytes += entry.body.byteLength;
    // 超配额就从最旧的开始丢，直到回到配额内
    for (const [oldKey, oldValue] of this.map) {
      if (this.bytes <= PREFETCH_MAX_BYTES) break;
      if (oldKey === key) break;
      this.bytes -= oldValue.body.byteLength;
      this.map.delete(oldKey);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get bytesCached(): number {
    return this.bytes;
  }
}

export interface PrefetchRequest {
  /** 播放列表地址或单个媒体地址 */
  url: string;
  /** 预取几个分片，默认 8 */
  count?: number;
  /** 是否按记录切广告段（与播放一致） */
  ad?: boolean;
}

export interface PrefetchResult {
  ok: boolean;
  /** 已缓存的分片数 */
  cached: number;
  /** 缓存后的总字节数 */
  bytes: number;
  /** 播放列表是否成功解析 */
  playlist: boolean;
  error?: string;
}

/** 从 m3u8 文本里按顺序取出分片绝对地址（跳过广告与加密 key） */
function segmentUrls(playlistText: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const rawLine of playlistText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    try {
      out.push(new URL(line, baseUrl).href);
    } catch {
      /* 非法行直接忽略 */
    }
  }
  return out;
}

export async function startMediaProxy(): Promise<MediaProxy> {
  const token = crypto.randomBytes(16).toString('hex');
  let base = '';
  const cache = new SegmentCache();

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
    if (route !== '/p' && route !== '/i' && route !== '/prefetch' && route !== '/stats') {
      sendText(res, 404, '未知路由');
      return;
    }

    // 缓存状态：给 e2e 与排查用（不含任何上游内容，只报计数）
    if (route === '/stats') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ segments: cache.size, bytes: cache.bytesCached }));
      return;
    }

    const target = url.searchParams.get('url') || '';
    const adFilter = url.searchParams.get('ad') === '1';
    // 自建/联调场景：允许访问内网媒体源（默认关闭，保持 SSRF 边界）
    const allowPrivate = process.env.LTV_ALLOW_PRIVATE_MEDIA === '1';

    if (route === '/prefetch') {
      // 点击播放的同时后台预热：解析播放列表 → 顺序抓前 N 个分片进内存缓存。
      // 播放器随后真正请求这些分片时直接命中，省掉每个分片一个 RTT。
      const count = Number(url.searchParams.get('count') || PREFETCH_DEFAULT_COUNT);
      try {
        const result = await prefetch(target, count, adFilter, allowPrivate);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            ok: false,
            cached: 0,
            bytes: cache.bytesCached,
            playlist: false,
            error: err instanceof Error ? err.message : '预取失败',
          } satisfies PrefetchResult)
        );
      }
      return;
    }

    let targetUrl: URL;
    try {
      targetUrl = await assertAllowedTarget(target, allowPrivate);
    } catch (err) {
      sendText(res, 400, err instanceof Error ? err.message : '地址不可用');
      return;
    }

    // —— /p 预取命中（必须在回源之前查，否则等于没省）——
    // 点击播放时后台已经把前几个分片抓进内存，播放器来要时直接给，省掉整个上游 RTT。
    if (route === '/p') {
      const cached = cache.get(targetUrl.href);
      if (cached) {
        // 缓存里也可能是播放列表，但它带 token、必须每次重写，不能按 hour 缓存
        const cachedPlaylist = looksLikePlaylistHead(cached.body);
        res.writeHead(cached.status, {
          'Content-Type': cached.contentType,
          'Content-Length': String(cached.body.byteLength),
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': cachedPlaylist ? 'no-store' : CACHE_SEGMENT,
        });
        res.end(cached.body);
        return;
      }
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
        // 失败的响应不能按「一小时不变」缓存：否则一张 404 的封面会整整一小时都刷不出来
        'Cache-Control': upstream.ok ? CACHE_SEGMENT : 'no-store',
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
      // 播放列表是小文本：整体读入 → 改写成代理地址。
      // 相对路径必须按**最终地址**解析：CDN 常常 302 到另一个目录，
      // 用入口 URL 当基准会把分片拼到错的路径上（表现为起播黑屏 / 404）。
      const buf = await readRest(reader, first);
      const text = buf.toString('utf8');
      const playlistBase = upstream.url || targetUrl.href;
      const rewritten = upstream.ok ? rewritePlaylist(text, playlistBase, `${base}${prefix}`, adFilter) : text;
      const out = Buffer.from(rewritten, 'utf8');
      res.writeHead(upstream.ok ? 200 : upstream.status, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': String(out.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(out);

      // 把分片地址顺手预热：播放器拿到这份 m3u8 才会去要分片，
      // 此刻开始抓，等它真的来要时前几片大概率已经在内存里。
      // 注意用**改写前**的文本：改写后全是本机代理地址，拿去预热等于自己请求自己。
      // 故意不 await：响应已经发出去了，预热是纯后台动作，失败也不影响播放。
      if (upstream.ok) {
        const warmList = segmentUrls(text, playlistBase).slice(0, PREFETCH_DEFAULT_COUNT);
        if (warmList.length > 0) {
          void warmSegments(
            warmList,
            { headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' }, redirect: 'manual' },
            allowPrivate
          ).catch(() => undefined);
        }
      }
      return;
    }

    // 真正的媒体分片：流式直通，边下边发，不在内存里攒完整块
    // 顺带把副本写进预取缓存（`cacheable`）：播放器重播/回看同一分片时不必回源
    await pipeStream(
      upstream,
      reader,
      first,
      res,
      contentType,
      req,
      req.method !== 'HEAD' && upstream.status === 200,
      targetUrl.href
    );
  }

  /**
   * 把上游响应体流式转发给渲染层。
   *
   * 关键点：
   * - 不缓冲整个分片，首字节到达就往下游写（起播快、seek 快）；
   * - 尊重下游背压（`res.write` 返回 false 时等 drain），否则大分片会堆在内存；
   * - 下游提前断开时取消上游读取，避免继续下载已无人消费的数据。
   */
  /**
   * 后台预取：解析播放列表，按顺序抓前 `count` 个分片进内存缓存。
   *
   * 只在客户端点击播放时调一次。失败的单个分片不算失败——CDN 偶尔抽风，
   * 能缓存几个算几个，播放器真去要没缓存到的分片时照样走正常流式路径。
   */
  async function prefetch(
    target: string,
    count: number,
    adFilter: boolean,
    allowPrivate: boolean
  ): Promise<PrefetchResult> {
    const wanted = Math.max(1, Math.min(32, Number.isFinite(count) ? count : PREFETCH_DEFAULT_COUNT));
    const init: RequestInit = {
      headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*' },
      redirect: 'manual',
    };

    const first = await assertAllowedTarget(target, allowPrivate);
    const playlistRes = await fetchChecked(first, init, allowPrivate);
    if (!playlistRes.ok) {
      return { ok: false, cached: 0, bytes: cache.bytesCached, playlist: false, error: `HTTP ${playlistRes.status}` };
    }
    const text = (await readLimited(playlistRes)).toString('utf8');
    const playlistBase = playlistRes.url || first.href;
    const body = adFilter ? stripAdGroups(text) : text;
    const segments = segmentUrls(body, playlistBase).slice(0, wanted);
    if (segments.length === 0) {
      // 不是播放列表（直链 mp4 之类）：把这条直链本身读进缓存
      const single = await fetchChecked(first, init, allowPrivate);
      if (!single.ok) {
        return { ok: false, cached: 0, bytes: cache.bytesCached, playlist: false, error: `HTTP ${single.status}` };
      }
      const buf = await readLimited(single, PREFETCH_MAX_SEGMENT);
      cache.put(first.href, {
        body: buf,
        contentType: single.headers.get('content-type') || 'application/octet-stream',
        status: single.status,
        headers: {},
      });
      return { ok: true, cached: Math.min(1, segments.length), bytes: cache.bytesCached, playlist: false };
    }

    const cachedCount = await warmSegments(segments, init, allowPrivate);
    return { ok: true, cached: cachedCount, bytes: cache.bytesCached, playlist: true };
  }

  /**
   * 把一组分片抓进内存缓存，返回成功条数。
   *
   * 顺序 + 小并发：不要打乱顺序（播放器是按顺序取前几个），也不要全开抢带宽。
   */
  async function warmSegments(segments: string[], init: RequestInit, allowPrivate: boolean): Promise<number> {
    let cachedCount = 0;
    let index = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const current = index++;
        if (current >= segments.length) return;
        const segmentUrl = segments[current];
        try {
          const segmentTarget = await assertAllowedTarget(segmentUrl, allowPrivate);
          // 已经预热过就跳过：代理返回 m3u8 时会自动预热，客户端可能又显式请求一次
          if (cache.get(segmentTarget.href)) continue;
          const res = await fetchChecked(segmentTarget, init, allowPrivate);
          if (!res.ok) continue;
          const buf = await readLimited(res, PREFETCH_MAX_SEGMENT);
          cache.put(segmentTarget.href, {
            body: buf,
            contentType: res.headers.get('content-type') || 'video/mp2t',
            status: res.status,
            headers: {},
          });
          cachedCount += 1;
        } catch {
          /* 单个分片失败不影响其它分片 */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, segments.length) }, worker));

    return cachedCount;
  }

  async function pipeStream(
    upstream: Response,
    reader: ReadableStreamDefaultReader<Uint8Array> | null,
    first: Uint8Array | null,
    res: ServerResponse,
    contentType: string,
    req: IncomingMessage,
    cacheable = false,
    cacheKey = ''
  ): Promise<void> {
    const headers: Record<string, string | number> = {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      // 分片内容按 URL 恒定：允许缓存，seek/重播不用回源
      'Cache-Control': CACHE_SEGMENT,
    };
    // 上游带了 content-encoding 时，undici 已经把响应体解压好了，但**响应头原样保留**
    // （实测 gzip：头里仍是压缩后的 content-length=52，body 却是 540 字节明文）。
    // 这时如果照抄 content-length，浏览器只读前 52 字节就认定响应结束，剩下的丢掉，
    // 分片被截断 → 解码出花屏/噪点。所以只要上游声明过编码，就不要透传长度，改走 chunked。
    const upstreamEncoding = upstream.headers.get('content-encoding');
    const contentLength = upstreamEncoding ? null : upstream.headers.get('content-length');
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
    // 边发边攒一份副本进预取缓存：播放器回头 seek/重播同一个分片时直接命中内存。
    // 只在分片不大时攒，避免把大文件整份留在堆里。
    const mirrored: Buffer[] = [];
    let mirrorBytes = 0;
    const mirror = (chunk: Uint8Array): void => {
      if (!cacheable) return;
      mirrorBytes += chunk.byteLength;
      if (mirrorBytes > PREFETCH_MAX_SEGMENT) {
        cacheable = false;
        return;
      }
      mirrored.push(Buffer.from(chunk));
    };
    const write = async (chunk: Uint8Array): Promise<boolean> => {
      total += chunk.byteLength;
      if (total > MAX_STREAM_BYTES) return false;
      mirror(chunk);
      if (res.write(chunk)) return true;
      // 等背压解除，但连接被关掉时 drain 永远不会来：
      // 必须同时监听 close，否则每次拖进度条都会漏一个挂起的 Promise
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.once('drain', done);
        res.once('close', done);
      });
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
      // 完整收到才写缓存：中途断流的分片不完整，缓存住会让播放器拿到坏数据
      if (cacheable && !closed && mirrorBytes > 0) {
        cache.put(cacheKey, {
          body: Buffer.concat(mirrored),
          contentType,
          status: upstream.status,
          headers: {},
        });
      }
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
