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

  /**
   * 直播分片一路带 live=1：URL 里是滚动序号，缓存与预取永远不可能命中，
   * 代理必须靠这个标志跳过「复制一份进内存」。
   */
  it('直播列表改写出的子地址带 live=1', () => {
    const out = rewritePlaylistForTest('#EXTM3U\n#EXTINF:6,\nseg1.ts\n', base, proxy, false, true);
    expect(out).toContain(`${proxy}/p?ad=0&live=1&url=${encodeURIComponent('https://cdn.example.com/hls/seg1.ts')}`);
  });

  it('点播列表改写出的子地址不带 live=1', () => {
    const out = rewritePlaylistForTest('#EXTM3U\n#EXTINF:6,\nseg1.ts\n#EXT-X-ENDLIST\n', base, proxy, false, false);
    expect(out).toContain(`${proxy}/p?ad=0&url=`);
    expect(out).not.toContain('live=1');
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

/**
 * 「一直转圈」回归：上游接了 TCP 连接却永不回响应头时，代理必须自己放弃。
 * 修复前这一跳没有任何超时，播放器既拿不到数据也收不到错误，界面只能靠
 * 20 秒看门狗兜底 —— 用户看到的就是「点了个台，一直在加载」。
 */
describe('fetchChecked：上游不响应要有死线', () => {
  it('迟迟不回响应头会按超时报错，而不是永久挂起', async () => {
    const silent = createServer(() => {
      /* 故意什么都不回：保持连接但不发响应头 */
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as { port: number }).port;
    const started = Date.now();
    try {
      await expect(
        fetchChecked(
          new URL(`http://127.0.0.1:${port}/hang.ts`),
          { method: 'GET' },
          false,
          async (raw) => new URL(raw),
          250
        )
      ).rejects.toThrow(/没有响应/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      silent.closeAllConnections?.();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  it('已经收到响应头之后不再受死线约束（大分片照常慢慢流）', async () => {
    // 先回头，再拖 600ms 才结束 body：死线若覆盖到 body 就会把这片砍断
    const slowBody = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write(Buffer.alloc(1024, 1));
      setTimeout(() => res.end(Buffer.alloc(1024, 2)), 600);
    });
    await new Promise<void>((r) => slowBody.listen(0, '127.0.0.1', () => r()));
    const port = (slowBody.address() as { port: number }).port;
    try {
      const res = await fetchChecked(
        new URL(`http://127.0.0.1:${port}/seg.ts`),
        { method: 'GET' },
        false,
        async (raw) => new URL(raw),
        200
      );
      expect(res.status).toBe(200);
      const bytes = await res.arrayBuffer();
      expect(bytes.byteLength).toBe(2048);
    } finally {
      slowBody.closeAllConnections?.();
      await new Promise<void>((r) => slowBody.close(() => r()));
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
        // 带 ENDLIST 才是点播：代理据此判定「不是直播」，子地址不带 live=1
        res.end('#EXTM3U\r\n#EXTINF:6,\r\nseg1.ts\r\n#EXT-X-ENDLIST\r\n');
        return;
      }
      if (req.url === '/live.m3u8') {
        // 直播列表：没有 ENDLIST，改写出来的子地址必须带 live=1
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\r\n#EXT-X-TARGETDURATION:6\r\n#EXTINF:6,\r\nlive1.ts\r\n');
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
        res.end('#EXTM3U\n#EXTINF:6,\nseg1.ts\n#EXT-X-ENDLIST\n');
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
      if (req.url && /^\/rg\d\.ts$/.test(req.url)) {
        segmentHits.set(req.url, (segmentHits.get(req.url) ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end(Buffer.alloc(4096, 5));
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
      // master 播放列表：里面列的是**子播放列表**而不是分片。
      // 这种响应绝不能进预取缓存，否则命中时会把未改写的 m3u8 原样回给播放器。
      if (req.url === '/master.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nchild.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nchild2.m3u8\n'
        );
        return;
      }
      if (req.url === '/child.m3u8' || req.url === '/child2.m3u8') {
        segmentHits.set(req.url, (segmentHits.get(req.url) ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\npf1.ts\n#EXT-X-ENDLIST\n');
        return;
      }
      if (req.url === '/range.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrg1.ts\n#EXT-X-ENDLIST\n');
        return;
      }
      // 上游写到一半直接断开：用来验证残缺分片不会被缓存
      if (req.url === '/truncated.ts') {
        segmentHits.set(req.url, (segmentHits.get(req.url) ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': '8192' });
        res.write(Buffer.alloc(1024, 7));
        setTimeout(() => res.destroy(), 20);
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
   * 直播分片必须只透传：既不进内存缓存（永远命中不了，白复制一遍），
   * 也不能带一小时的浏览器缓存头（否则重连时可能拿到过期分片）。
   */
  it('直播分片（live=1）不写缓存：同一个分片两次都要回源', async () => {
    const target = encodeURIComponent(`${upstreamUrl}/pf9.ts`);
    const first = await fetch(`${proxyBase}/p?live=1&url=${target}`);
    expect(first.headers.get('cache-control')).toBe('no-store');
    await first.arrayBuffer();
    const second = await fetch(`${proxyBase}/p?live=1&url=${target}`);
    expect(second.headers.get('cache-control')).toBe('no-store');
    await second.arrayBuffer();
    expect(segmentHits.get('/pf9.ts')).toBe(2);
  });

  it('直播列表改写出的分片地址带 live=1', async () => {
    const res = await proxyGet('/live.m3u8');
    const body = await res.text();
    expect(body).toContain('live=1');
    expect(body).toContain(encodeURIComponent(`${upstreamUrl}/live1.ts`));
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

  /**
   * master 播放列表里列的是子播放列表，不是分片。
   *
   * 如果把子播放列表原样缓存，`/p` 命中时会把它**未经改写**地返回给播放器，
   * 播放器拿到的是直连 CDN 的地址 —— 跨域被拦或丢 Referer 被判盗链，
   * 表现为「某些片子起播直接黑屏」。所以这类响应必须留在改写路径上。
   */
  it('不缓存播放列表，命中路径不会把未改写的内容回给播放器', async () => {
    segmentHits.clear();
    // 用一个没被前面用例碰过的分片集合，避免「已经预热过就跳过」让 cached 恒为 0
    const warmed = (await (
      await fetch(`${proxyBase}/prefetch?url=${encodeURIComponent(`${upstreamUrl}/prefetch.m3u8`)}&count=3`)
    ).json()) as { ok: boolean; cached: number };
    expect(warmed.ok).toBe(true);

    // 对 master 走一次预取：子播放列表不应被缓存
    await fetch(`${proxyBase}/prefetch?url=${encodeURIComponent(`${upstreamUrl}/master.m3u8`)}&count=2`);
    const hitsAfterPrefetch = segmentHits.get('/child.m3u8') ?? 0;

    // 播放器请求子播放列表：必须经过改写，且不能吃缓存
    const res = await proxyGet('/child.m3u8');
    const text = await res.text();
    expect(text).toContain('/p?');
    expect(text).not.toContain('#EXT-X-STREAM-INF');
    expect(segmentHits.get('/child.m3u8')).toBe(hitsAfterPrefetch + 1);
  });

  /**
   * 上游中途断开时，已发出的部分会照常给下游，但**不能**留在缓存里。
   * 否则播放器下次命中缓存会拿到半截分片 —— 花屏、噪点、或直接卡住。
   *
   * 注意：下游也会收到「Content-Length 声明 8KB 但只来了 1KB」的残缺响应，
   * 所以请求本身会以 terminated 报错——这正是预期行为，不是代理的 bug。
   */
  /**
   * 带 Range 的请求不能吃预取缓存。
   *
   * 缓存里存的是完整分片（预取用无 Range 的 GET），而命中分支只按 200 回整段。
   * `#EXT-X-BYTERANGE` 的源（hls.js 会发 `Range: bytes=X-Y`）拿到整段却按自己的
   * 范围切片，解出来是错位字节 —— 花屏。这类请求必须回源，让上游自己回 206。
   */
  it('带 Range 的请求不吃预取缓存', async () => {
    segmentHits.clear();
    // 用一个前面用例没碰过的分片，避免「已经预热过就跳过」让计数对不上
    await fetch(`${proxyBase}/prefetch?url=${encodeURIComponent(`${upstreamUrl}/range.m3u8`)}&count=1`);
    const before = segmentHits.get('/rg1.ts') ?? 0;
    expect(before).toBeGreaterThanOrEqual(1);

    // 不带 Range：命中缓存，不回源
    await proxyGet('/rg1.ts').then((r) => r.arrayBuffer());
    expect(segmentHits.get('/rg1.ts')).toBe(before);

    const res = await fetch(`${proxyBase}/p?url=${encodeURIComponent(`${upstreamUrl}/rg1.ts`)}`, {
      headers: { Range: 'bytes=0-511' },
    });
    await res.arrayBuffer();
    // 必须回源：上游计数 +1
    expect(segmentHits.get('/rg1.ts')).toBe(before + 1);
  });

  it('上游中途断开的分片不进缓存', async () => {
    segmentHits.clear();
    const hitsBefore = segmentHits.get('/truncated.ts') ?? 0;

    // 第一次：上游断流，下游拿到的是残缺响应
    await proxyGet('/truncated.ts')
      .then((r) => r.arrayBuffer())
      .catch(() => undefined);
    expect(segmentHits.get('/truncated.ts')).toBe(hitsBefore + 1);

    // 第二次：必须重新回源，而不是命中那份残缺缓存
    await proxyGet('/truncated.ts')
      .then((r) => r.arrayBuffer())
      .catch(() => undefined);
    expect(segmentHits.get('/truncated.ts')).toBe(hitsBefore + 2);
  });
});
