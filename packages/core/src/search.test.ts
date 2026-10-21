import { describe, expect, it, vi } from 'vitest';
import { groupSearchResults, dedupeResults } from './group';
import type { HttpClient, HttpResponse } from './http';
import { searchSources } from './search';
import type { SearchResultItem, SourceConfig } from './types';

function res(body: unknown, status = 200): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, url: '', headers: {}, text, bytes: new TextEncoder().encode(text) };
}

/** 按 URL 前缀路由的假 HTTP 客户端 */
function makeHttp(handler: (url: string) => HttpResponse | Promise<HttpResponse>): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(url) {
      calls.push(url);
      return handler(url);
    },
  };
}

const s1: SourceConfig = { key: 'k1', name: '甲源', url: 'https://a.example.com/api.php/provide/vod/' };
const s2: SourceConfig = { key: 'k2', name: '乙源', url: 'https://b.example.com/api.php/provide/vod' };

describe('searchSources', () => {
  it('并行聚合、过滤无关结果并统计失败源', async () => {
    const http = makeHttp((url) => {
      if (url.startsWith('https://a.example.com')) {
        return res({
          pagecount: 1,
          list: [
            { vod_id: 1, vod_name: '流浪地球', type_name: '科幻片' },
            { vod_id: 2, vod_name: '完全无关的片名', type_name: '科幻片' },
          ],
        });
      }
      return res({ error: 'boom' }, 500);
    });

    const result = await searchSources({ wd: '流浪地球', sources: [s1, s2], http, filterAdult: true });
    expect(result.list.map((i) => i.vodId)).toEqual(['1']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ sourceKey: 'k2', error: 'HTTP 500' });
  });

  it('按 pagecount 抓取后续页，并受 maxPages 限制', async () => {
    const http = makeHttp((url) => {
      const page = Number(/pg=(\d+)/.exec(url)?.[1] ?? '1');
      return res({ pagecount: 5, list: [{ vod_id: page, vod_name: `庆余年 第${page}页` }] });
    });
    const result = await searchSources({ wd: '庆余年', sources: [s1], http, maxPages: 2 });
    expect(http.calls).toHaveLength(2);
    expect(result.list.map((i) => i.vodId)).toEqual(['1', '2']);
  });

  it('逐源回调 onSource（先到先回）', async () => {
    const seen: string[] = [];
    const http = makeHttp(() => res({ list: [] }));
    await searchSources({
      wd: 'x',
      sources: [s1, s2],
      http,
      onSource: (o) => seen.push(o.sourceKey),
    });
    expect(seen.sort()).toEqual(['k1', 'k2']);
  });

  it('源超时被标记 timedOut 且不影响其他源', async () => {
    const http = makeHttp(async (url) => {
      if (url.startsWith('https://a.example.com')) {
        await new Promise((r) => setTimeout(r, 50));
        return res({ list: [] });
      }
      return res({ list: [{ vod_id: 9, vod_name: 'x' }] });
    });
    const result = await searchSources({ wd: 'x', sources: [s1, s2], http, timeoutMs: 20 });
    expect(result.list).toHaveLength(1);
    expect(result.failures.some((f) => f.timedOut)).toBe(true);
  });

  it('无效地址直接失败，不发请求', async () => {
    const http = makeHttp(() => res({}));
    const result = await searchSources({
      wd: 'x',
      sources: [{ key: 'bad', name: 'bad', url: 'ftp://x' }],
      http,
    });
    expect(http.calls).toHaveLength(0);
    expect(result.failures[0].error).toBe('无效的源地址');
  });

  it('调用方 signal 中止时不悬挂', async () => {
    const controller = new AbortController();
    const http = makeHttp(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return res({ list: [] });
    });
    const p = searchSources({ wd: 'x', sources: [s1], http, signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    await expect(p).resolves.toBeDefined();
  });
});

describe('groupSearchResults', () => {
  const item = (name: string, sourceName: string, year?: string): SearchResultItem => ({
    sourceKey: sourceName,
    sourceName,
    vodId: `${sourceName}-${name}`,
    name,
    year,
  });

  it('同名同年的跨源结果合并为一组', () => {
    const groups = groupSearchResults([item('三体', '甲源', '2023'), item('三体', '乙源', '2023'), item('繁花', '甲源')]);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe('三体#2023');
    expect(groups[0].items).toHaveLength(2);
  });

  it('年份不同不合并', () => {
    const groups = groupSearchResults([item('三体', '甲源', '2023'), item('三体', '乙源', '2024')]);
    expect(groups).toHaveLength(2);
  });

  it('dedupeResults 按源 + vodId 去重', () => {
    expect(dedupeResults([item('a', 's'), item('a', 's'), item('a', 't')])).toHaveLength(2);
  });
});

describe('searchSources 稳定性', () => {
  it('同一结果重复出现时只保留一条', async () => {
    const http = makeHttp(() => res({ list: [{ vod_id: 1, vod_name: 'x' }] }));
    const result = await searchSources({ wd: 'x', sources: [s1, s1], http });
    expect(result.list).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
