import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
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

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      if (req.url === '/playlist.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\r\n#EXTINF:6,\r\nseg1.ts\r\n');
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
      if (req.url === '/notfound') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('nope');
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
});
