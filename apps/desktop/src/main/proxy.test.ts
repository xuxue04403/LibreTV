import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import {
  assertAllowedTarget,
  fetchChecked,
  rewritePlaylistForTest,
  isPlaylistForTest,
  startMediaProxy,
} from './proxy';

describe('assertAllowedTarget：SSRF 边界', () => {
  it('放行普通公网 http(s) 地址', async () => {
    await expect(assertAllowedTarget('https://example.com/a.m3u8')).resolves.toBeInstanceOf(URL);
    await expect(assertAllowedTarget('http://example.com')).resolves.toBeInstanceOf(URL);
  });

  it('拒绝非 http(s) 协议', async () => {
    await expect(assertAllowedTarget('file:///etc/passwd')).rejects.toThrow('仅支持 http(s) 地址');
    await expect(assertAllowedTarget('ftp://example.com')).rejects.toThrow('仅支持 http(s) 地址');
    await expect(assertAllowedTarget('javascript:alert(1)')).rejects.toThrow();
  });

  it('拒绝 localhost 与 .localhost 后缀', async () => {
    await expect(assertAllowedTarget('http://localhost:8080/')).rejects.toThrow('拒绝访问本机地址');
    await expect(assertAllowedTarget('http://app.localhost/')).rejects.toThrow('拒绝访问本机地址');
  });

  it('拒绝各种写法的内网 IP', async () => {
    const cases = [
      'http://127.0.0.1/',
      'http://127.1/', // WHATWG URL 归一化为 127.0.0.1
      'http://2130706433/', // 十进制
      'http://0x7f000001/', // 十六进制
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/', // 云元数据
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
    ];
    for (const url of cases) {
      await expect(assertAllowedTarget(url), url).rejects.toThrow(/拒绝访问内网地址|拒绝访问本机地址/);
    }
  });

  it('允许私网访问时放行（联调开关）', async () => {
    await expect(assertAllowedTarget('http://127.0.0.1:9/x', true)).resolves.toBeInstanceOf(URL);
  });
});

describe('rewritePlaylist：m3u8 改写', () => {
  const base = 'https://cdn.example.com/hls/index.m3u8';
  const proxy = 'http://127.0.0.1:1234/t/tok';

  it('把分片行改写为代理地址', () => {
    const out = rewritePlaylistForTest('#EXTM3U\n#EXTINF:6,\nseg1.ts\n', base, proxy, false);
    expect(out).toContain(`${proxy}/p?ad=0&url=${encodeURIComponent('https://cdn.example.com/hls/seg1.ts')}`);
  });

  it('相对路径按 baseUrl 解析', () => {
    const out = rewritePlaylistForTest('#EXTM3U\nsub/seg.ts\n', base, proxy, false);
    expect(out).toContain(encodeURIComponent('https://cdn.example.com/hls/sub/seg.ts'));
  });

  it('改写 URI="..." 与单引号写法', () => {
    const out = rewritePlaylistForTest(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI=\'init.mp4\'\n',
      base,
      proxy,
      false
    );
    expect(out).toContain(`URI="${proxy}/p?ad=0&url=${encodeURIComponent('https://cdn.example.com/hls/key.bin')}"`);
    expect(out).toContain(`URI="${proxy}/p?ad=0&url=${encodeURIComponent('https://cdn.example.com/hls/init.mp4')}"`);
  });

  it('注释行原样保留', () => {
    const out = rewritePlaylistForTest('#EXTM3U\n#EXT-X-VERSION:3\n', base, proxy, false);
    expect(out).toContain('#EXT-X-VERSION:3');
  });
});

describe('isPlaylist：识别播放列表', () => {
  const fake = (type: string) => new Response('', { headers: { 'content-type': type } });

  it('按 content-type 识别', () => {
    expect(isPlaylistForTest(fake('application/vnd.apple.mpegurl'), '')).toBe(true);
    expect(isPlaylistForTest(fake('application/x-mpegURL'), '')).toBe(true);
  });

  it('按 #EXTM3U 识别，并容忍 UTF-8 BOM', () => {
    expect(isPlaylistForTest(fake('text/plain'), '#EXTM3U\n')).toBe(true);
    expect(isPlaylistForTest(fake('text/plain'), '\uFEFF#EXTM3U\n')).toBe(true);
    expect(isPlaylistForTest(fake('text/plain'), '#EXT-X-STREAM-INF')).toBe(false);
  });
});

describe('媒体代理：重定向不得绕过 SSRF 校验', () => {
  let evil: Server;
  let internal: Server;
  let internalHits = 0;
  let evilUrl = '';
  let internalUrl = '';

  beforeAll(async () => {
    internal = createServer((_req, res) => {
      internalHits += 1;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('SECRET-INTERNAL');
    });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()));
    internalUrl = `http://127.0.0.1:${(internal.address() as { port: number }).port}/admin`;

    evil = createServer((_req, res) => {
      res.writeHead(302, { Location: internalUrl });
      res.end();
    });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', () => r()));
    evilUrl = `http://127.0.0.1:${(evil.address() as { port: number }).port}/start.m3u8`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => evil.close(() => r()));
    await new Promise<void>((r) => internal.close(() => r()));
  });

  beforeEach(() => {
    internalHits = 0;
  });

  /**
   * 核心回归：入口被放行（模拟合法域名解析到这台主机），但 302 指向另一台内网主机时
   * 必须被逐跳校验拦下。修复前（redirect: 'follow'）这里会拿到 SECRET-INTERNAL。
   */
  it('跳转到内网地址会被拦下，且内网服务未被访问', async () => {
    const evilPort = new URL(evilUrl).port;
    // 只放行入口那一台，其余一律拒绝 —— 等价于线上「入口公网、跳转目标内网」
    const validate = async (raw: string) => {
      const url = new URL(raw);
      if (url.port === evilPort) return url;
      throw new Error('拒绝访问内网地址');
    };
    await expect(fetchChecked(new URL(evilUrl), { method: 'GET' }, false, validate)).rejects.toThrow(
      '拒绝访问内网地址'
    );
    expect(internalHits).toBe(0);
  });

  it('正常 302 到公网地址仍可跟随', async () => {
    // 校验器全部放行，确认手动跟随没把正常跳转弄坏
    const res = await fetchChecked(new URL(evilUrl), { method: 'GET' }, false, async (raw) => new URL(raw));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SECRET-INTERNAL');
    expect(internalHits).toBe(1);
  });

  it('超过最大跳转次数会报错', async () => {
    // 指向自身形成循环
    let loopPort = 0;
    const loop = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${loopPort}/again` });
      res.end();
    });
    await new Promise<void>((r) => loop.listen(0, '127.0.0.1', () => r()));
    loopPort = (loop.address() as { port: number }).port;
    try {
      await expect(
        fetchChecked(new URL(`http://127.0.0.1:${loopPort}/`), { method: 'GET' }, false, async (raw) => new URL(raw))
      ).rejects.toThrow('重定向次数过多');
    } finally {
      await new Promise<void>((r) => loop.close(() => r()));
    }
  });
});

describe('媒体代理 HTTP 行为', () => {
  let upstream: Server;
  let upstreamUrl = '';
  let proxyBase = '';
  let closeProxy: (() => Promise<void>) | null = null;
  /** 分片命中计数：证明预取之后播放器再要同一分片没有回源 */
  const segmentHits = new Map<string, number>();

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      if (req.url === '/playlist.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\r\n#EXTINF:6,\r\nseg1.ts\r\n');
        return;
      }
      if (req.url === '/gzip.ts') {
        // 上游对分片做了 gzip：undici 会把 body 解压好，但**保留压缩时的 content-length**。
        // 代理如果照抄这个长度，浏览器只读前几十字节就认为响应结束 → 分片截断 → 花屏/噪点。
        const gz = gzipSync(Buffer.alloc(64 * 1024, 7));
        res.writeHead(200, {
          'Content-Type': 'video/mp2t',
          'Content-Encoding': 'gzip',
          'Content-Length': String(gz.length),
        });
        res.end(gz);
        return;
      }
      if (req.url === '/no-length.ts') {
        // 无 Content-Length：走 chunked，验证流式限长分支
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.write(Buffer.alloc(1024, 1));
        res.end();
        return;
      }
      if (req.url === '/html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<script>alert(1)</script>');
        return;
      }
      if (req.url === '/slow.ts') {
        // 分两段回，中间停顿：用来验证代理是「边收边发」而不是攒完再发
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.write(Buffer.alloc(64 * 1024, 3));
        setTimeout(() => res.end(Buffer.alloc(64 * 1024, 4)), 400);
        return;
      }
      if (req.url === '/playlist-no-type.m3u8') {
        // 不给 mpegurl content-type，靠 body 前缀识别
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('#EXTM3U\n#EXTINF:6,\nseg1.ts\n');
        return;
      }
      if (req.url === '/notfound') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('nope');
        return;
      }
      // —— 预取相关的上游路由 ——
      // 记一笔命中次数，用来证明「预取之后再取同一分片不再回源」
      if (req.url && /^\/pf\d\.ts$/.test(req.url)) {
        segmentHits.set(req.url, (segmentHits.get(req.url) ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end(Buffer.alloc(4096, 9));
        return;
      }
      if (req.url === '/prefetch.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(
          '#EXTM3U\n#EXT-X-TARGETDURATION:6\n' +
            '#EXTINF:6,\npf1.ts\n#EXTINF:6,\npf2.ts\n#EXTINF:6,\npf3.ts\n#EXT-X-ENDLIST\n'
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(Buffer.alloc(16, 2));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    process.env.LTV_ALLOW_PRIVATE_MEDIA = '1';
    const p = await startMediaProxy();
    closeProxy = p.close;
    proxyBase = p.base;
  });

  afterAll(async () => {
    delete process.env.LTV_ALLOW_PRIVATE_MEDIA;
    await closeProxy?.();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const proxyGet = (path: string) =>
    fetch(`${proxyBase}/p?url=${encodeURIComponent(`${upstreamUrl}${path}`)}`);

  it('无 token 直接 403', async () => {
    const res = await fetch(`http://127.0.0.1:${new URL(proxyBase).port}/p?url=x`);
    expect(res.status).toBe(403);
  });

  it('m3u8 被改写成分片也走代理', async () => {
    const res = await proxyGet('/playlist.m3u8');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/p?ad=0&url=');
    expect(body).toContain(encodeURIComponent(`${upstreamUrl}/seg1.ts`));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('无 Content-Length 的分片也能正常透传', async () => {
    const res = await proxyGet('/no-length.ts');
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
  });

  /**
   * 花屏回归：上游 gzip 过的分片不能按压缩时的长度截断。
   * undici 解压后响应头里仍留着压缩前的 content-length，代理若照抄，
   * 浏览器只会读前几十字节，解码出来就是噪点/花屏。
   */
  it('上游 gzip 的分片不会被截断（不透传压缩时的 Content-Length）', async () => {
    const res = await proxyGet('/gzip.ts');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBeNull();
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(64 * 1024);
    expect(new Uint8Array(body).every((v) => v === 7)).toBe(true);
  });

  it('图片路由拒绝把 text/html 当图片回给渲染层', async () => {
    // /p 透传原始类型；/i 只认 image/*
    const res = await fetch(`${proxyBase}/i?url=${encodeURIComponent(`${upstreamUrl}/html`)}`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('上游 404 状态原样透传', async () => {
    const res = await proxyGet('/notfound');
    expect(res.status).toBe(404);
  });

  /**
   * 核心性能回归：分片必须流式转发。
   * 老实现把整个响应体读进 Buffer 再回写，首字节要等上游写完才发得出去；
   * 这里上游故意在中间停顿 400ms，流式实现应该在停顿前就把第一段发出来。
   */
  it('分片边收边发（首字节早于上游写完）', async () => {
    const started = Date.now();
    const res = await proxyGet('/slow.ts');
    const reader = res.body!.getReader();
    const firstChunk = await reader.read();
    const firstByteAt = Date.now() - started;
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value!.byteLength).toBeGreaterThan(0);
    // 上游 400ms 后才补第二段，流式实现此时已经拿到首块
    expect(firstByteAt).toBeLessThan(350);

    let total = firstChunk.value!.byteLength;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    expect(total).toBe(128 * 1024);
  });

  it('分片响应带可缓存头（seek 回头能命中）', async () => {
    const res = await proxyGet('/no-length.ts');
    expect(res.headers.get('cache-control')).toContain('max-age');
    // 播放列表必须不缓存：里面是带 token 的临时地址，缓存住会让换源失效
    const playlist = await proxyGet('/playlist.m3u8');
    expect(playlist.headers.get('cache-control')).toBe('no-store');
  });

  it('content-type 不是 mpegurl 时靠 body 前缀识别播放列表', async () => {
    const res = await proxyGet('/playlist-no-type.m3u8');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(await res.text()).toContain('/p?ad=0&url=');
  });

  /**
   * 预取：点击播放时后台先把前几个分片抓进内存，播放器再来要时零 RTT。
   *
   * 这里用「上游计数」证明真的省了请求：预取之后再取同一个分片，
   * 上游的命中次数不应增加。
   */
  it('预取后同一分片不再回源', async () => {
    segmentHits.clear();
    const listUrl = `${upstreamUrl}/prefetch.m3u8`;
    const started = Date.now();
    const result = (await (
      await fetch(`${proxyBase}/prefetch?url=${encodeURIComponent(listUrl)}&count=3`)
    ).json()) as { ok: boolean; cached: number; playlist: boolean };
    const prefetchMs = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(result.playlist).toBe(true);
    expect(result.cached).toBe(3);
    // 三个分片各抓一次
    expect(segmentHits.get('/pf1.ts')).toBe(1);
    expect(segmentHits.get('/pf2.ts')).toBe(1);
    expect(segmentHits.get('/pf3.ts')).toBe(1);

    // 播放器随后请求第一个分片：命中缓存，上游计数不变
    const res = await proxyGet('/pf1.ts');
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(4096);
    expect(new Uint8Array(body).every((v) => v === 9)).toBe(true);
    expect(segmentHits.get('/pf1.ts')).toBe(1);
    expect(prefetchMs).toBeLessThan(5_000);
  });

  it('预取失败不抛错，返回 ok=false 让调用方忽略', async () => {
    const res = await fetch(`${proxyBase}/prefetch?url=${encodeURIComponent(`${upstreamUrl}/notfound`)}`);
    const result = (await res.json()) as { ok: boolean; cached: number };
    expect(res.status).toBe(200);
    expect(result.ok).toBe(false);
    expect(result.cached).toBe(0);
  });
});
