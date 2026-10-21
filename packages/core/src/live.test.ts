import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpResponse, HttpStreamOptions } from './http';
import { fetchLivePlaylist } from './live';
import type { LiveChannel } from './types';

const PLAYLIST = [
  '#EXTM3U x-tvg-url="https://epg.example.com/e.xml.gz"',
  '#PLAYLIST:测试订阅',
  '#EXTINF:-1 tvg-id="cctv1" group-title="央视",CCTV-1',
  'https://a/1.m3u8',
  '#EXTINF:-1 tvg-id="cctv2" group-title="央视",CCTV-2',
  'https://a/2.m3u8',
  '#EXTINF:-1 group-title="卫视",湖南卫视',
  'https://a/3.m3u8',
  '#EXTINF:-1 group-title="成人",深夜台',
  'https://a/4.m3u8',
].join('\n');

function responseOf(text: string, chunks = 1): { res: HttpResponse; chunks: Uint8Array[] } {
  const bytes = new TextEncoder().encode(text);
  // 按字节切成 chunks 份，故意可以切断多字节字符
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += Math.max(1, Math.ceil(bytes.length / chunks))) {
    parts.push(bytes.subarray(i, i + Math.max(1, Math.ceil(bytes.length / chunks))));
  }
  return {
    res: {
      ok: true,
      status: 200,
      url: 'https://example.com/list.m3u',
      headers: {},
      bytes,
      text,
    },
    chunks: parts,
  };
}

/** 模拟宿主：只有 request()，不支持流式 */
function plainHttp(text: string): HttpClient {
  const { res } = responseOf(text);
  return { request: async () => res };
}

/** 模拟宿主：支持流式，逐块回调 */
function streamingHttp(text: string, chunks: number, failAt?: number): HttpClient {
  const { res, chunks: parts } = responseOf(text, chunks);
  return {
    request: async () => res,
    async stream(_url, options: HttpStreamOptions) {
      let sent = 0;
      for (const part of parts) {
        if (failAt !== undefined && sent >= failAt) throw new Error('连接中断');
        options.onChunk(part);
        sent++;
      }
      if (failAt !== undefined) throw new Error('连接中断');
      return res;
    },
  };
}

describe('fetchLivePlaylist', () => {
  it('不支持流式时退化为一次性解析', async () => {
    const playlist = await fetchLivePlaylist('https://example.com/list.m3u', plainHttp(PLAYLIST));
    expect(playlist.channels).toHaveLength(4);
    expect(playlist.groups).toEqual(['央视', '卫视', '成人']);
    expect(playlist.name).toBe('测试订阅');
    expect(playlist.epgUrl).toBe('https://epg.example.com/e.xml.gz');
  });

  it('支持流式时也能拿到完整结果', async () => {
    const playlist = await fetchLivePlaylist(
      'https://example.com/list.m3u',
      streamingHttp(PLAYLIST, 8),
      { onChannels: () => undefined, progressIntervalMs: 0 }
    );
    expect(playlist.channels.map((c) => c.name)).toEqual(['CCTV-1', 'CCTV-2', '湖南卫视', '深夜台']);
  });

  it('渐进回调的总量等于最终频道数', async () => {
    const seen: LiveChannel[] = [];
    const playlist = await fetchLivePlaylist(
      'https://example.com/list.m3u',
      streamingHttp(PLAYLIST, 8),
      {
        progressIntervalMs: 0,
        onChannels: (added) => {
          seen.push(...added);
        },
      }
    );
    expect(seen.map((c) => c.url)).toEqual(playlist.channels.map((c) => c.url));
    expect(seen).toHaveLength(4);
  });

  it('第一批频道早于整串下载完成就能上屏', async () => {
    // 12 块：前 2 块只有头部与第一个频道，第三块之后才有更多
    const order: number[] = [];
    const playlist = await fetchLivePlaylist(
      'https://example.com/list.m3u',
      streamingHttp(PLAYLIST, 12),
      {
        progressIntervalMs: 0,
        onChannels: (added, progress) => {
          order.push(added.length);
          expect(progress.channels).toBeGreaterThanOrEqual(added.length);
        },
      }
    );
    // 至少有一次回调发生时总频道数还不是最终值 = 真正渐进
    expect(order.length).toBeGreaterThan(1);
    expect(playlist.channels).toHaveLength(4);
  });

  it('流式中途断开时用已解析的部分兜底', async () => {
    const playlist = await fetchLivePlaylist(
      'https://example.com/list.m3u',
      streamingHttp(PLAYLIST, 10, 6),
      { onChannels: () => undefined, progressIntervalMs: 0 }
    );
    expect(playlist.channels.length).toBeGreaterThan(0);
    expect(playlist.channels.length).toBeLessThanOrEqual(4);
  });

  it('一个频道都没解析到就断开时向上抛错', async () => {
    await expect(
      fetchLivePlaylist('https://example.com/list.m3u', streamingHttp(PLAYLIST, 10, 0), {
        onChannels: () => undefined,
      })
    ).rejects.toThrow(/连接中断/);
  });

  it('空列表报错而不是返回空数组', async () => {
    await expect(
      fetchLivePlaylist('https://example.com/list.m3u', plainHttp('#EXTM3U\n'), {})
    ).rejects.toThrow(/未解析到可用频道/);
  });
});
