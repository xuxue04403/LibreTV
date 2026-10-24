import { describe, expect, it } from 'vitest';
import {
  browseCategory,
  CATEGORY_BUCKETS,
  categoryLabel,
  classifyCategoryName,
  fetchSourceCategories,
  HOME_CATEGORIES,
  matchTypeId,
  matchTypeIds,
  parseSourceCategories,
  probeCategories,
  setCachedCategories,
  clearCategoryCache,
} from './categories';
import type { HttpClient, HttpResponse } from './http';
import type { SourceConfig } from './types';

function res(body: unknown, status = 200): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, url: '', headers: {}, text, bytes: new TextEncoder().encode(text) };
}

const source: SourceConfig = { key: 'k1', name: '甲源', url: 'https://a.example.com/api.php/provide/vod' };

describe('classifyCategoryName', () => {
  it('常见分类归类', () => {
    expect(classifyCategoryName('电影')).toBe('movie');
    expect(classifyCategoryName('动作片')).toBe('movie');
    expect(classifyCategoryName('国产剧')).toBe('tv');
    expect(classifyCategoryName('连续剧')).toBe('tv');
    expect(classifyCategoryName('综艺')).toBe('variety');
    expect(classifyCategoryName('动漫')).toBe('anime');
    expect(classifyCategoryName('少儿')).toBe('kids');
    expect(classifyCategoryName('纪录片')).toBe('doc');
    expect(classifyCategoryName('短剧')).toBe('short');
  });

  it('专属桶优先于通用桶（避免被「片」抢走）', () => {
    expect(classifyCategoryName('少儿动画')).toBe('kids');
    expect(classifyCategoryName('纪录电影')).toBe('doc');
    expect(classifyCategoryName('动画电影')).toBe('anime');
  });

  it('无法识别的归入其他', () => {
    expect(classifyCategoryName('福利')).toBe('other');
    expect(classifyCategoryName('')).toBe('other');
  });

  it('首页分类入口不含「其他」，且电影电视剧排在最前', () => {
    expect(HOME_CATEGORIES.map((c) => c.key)).toEqual([
      'movie',
      'tv',
      'kids',
      'variety',
      'anime',
      'doc',
      'short',
      'sports',
    ]);
    expect(categoryLabel('tv')).toBe('电视剧');
    expect(categoryLabel('movie')).toBe('电影');
  });

  it('展示顺序与判定顺序解耦：判定仍让专属桶优先', () => {
    // 展示顺序里电影排第一，但「少儿动画」这类名字仍必须先命中少儿桶
    expect(HOME_CATEGORIES[0]?.key).toBe('movie');
    expect(classifyCategoryName('少儿动画')).toBe('kids');
    expect(classifyCategoryName('纪录电影')).toBe('doc');
    expect(CATEGORY_BUCKETS.findIndex((b) => b.key === 'kids')).toBeLessThan(
      CATEGORY_BUCKETS.findIndex((b) => b.key === 'movie')
    );
  });
});

describe('parseSourceCategories / matchTypeId', () => {
  const payload = {
    class: [
      { type_id: 1, type_name: '电影' },
      { type_id: 2, type_name: '连续剧' },
      { type_id: 3, type_name: '综艺' },
      { type_id: 4, type_name: '动漫' },
      { type_id: 5, type_name: '少儿' },
      { type_id: 6, type_name: '动作片' },
      { type_id: 7, type_name: '喜剧片' },
    ],
  };

  it('解析 type_id/type_name 并去重', () => {
    const categories = parseSourceCategories(payload);
    expect(categories).toHaveLength(7);
    expect(categories[0]).toEqual({ id: '1', name: '电影', parentId: undefined });
    expect(parseSourceCategories({ class: null })).toEqual([]);
    expect(parseSourceCategories(null)).toEqual([]);
  });

  it('按桶匹配 type_id，按 id 升序取叶子分类', () => {
    const categories = parseSourceCategories(payload);
    // 该 payload 里「电影(1)」没有挂子分类，本身就是叶子，因此排在最前
    expect(matchTypeId(categories, 'movie')).toBe('1');
    expect(matchTypeId(categories, 'tv')).toBe('2');
    expect(matchTypeId(categories, 'kids')).toBe('5');
  });

  it('父分类不聚合子分类：优先返回叶子分类', () => {
    const categories = parseSourceCategories({
      class: [
        { type_id: 1, type_name: '电影片', type_pid: 0 },
        { type_id: 6, type_name: '动作片', type_pid: 1 },
        { type_id: 7, type_name: '喜剧片', type_pid: 1 },
        { type_id: 20, type_name: '记录片', type_pid: 1 },
      ],
    });
    const ids = matchTypeIds(categories, 'movie');
    // 6/7 是「片」结尾的叶子分类；20 归入纪录片桶，因此不应混入
    expect(ids).toEqual(['6', '7']);
  });

  it('只有顶级分类的源回退到父分类', () => {
    const categories = parseSourceCategories({ class: [{ type_id: 1, type_name: '电影' }] });
    expect(matchTypeIds(categories, 'movie')).toEqual(['1']);
  });

  it('没有对应分类时返回空数组', () => {
    const categories = parseSourceCategories({ class: [{ type_id: 9, type_name: '电影' }] });
    expect(matchTypeIds(categories, 'variety')).toEqual([]);
    expect(matchTypeId(categories, 'variety')).toBeUndefined();
  });

  it('支持不同的字段命名', () => {
    const categories = parseSourceCategories({ classes: [{ typeId: '11', typeName: '纪录片', typePid: 0 }] });
    expect(categories).toEqual([{ id: '11', name: '纪录片', parentId: undefined }]);
  });
});

describe('fetchSourceCategories', () => {
  it('请求 ac=list 并解析分类', async () => {
    const calls: string[] = [];
    const http: HttpClient = {
      async request(url) {
        calls.push(url);
        return res({ class: [{ type_id: 1, type_name: '电影' }] });
      },
    };
    const categories = await fetchSourceCategories(source, http);
    expect(calls[0]).toBe('https://a.example.com/api.php/provide/vod?ac=list&pg=1');
    expect(categories).toHaveLength(1);
  });

  it('非 JSON 或非 2xx 抛错', async () => {
    await expect(
      fetchSourceCategories(source, { request: async () => res('<html>', 500) })
    ).rejects.toThrow('HTTP 500');
    await expect(
      fetchSourceCategories(source, { request: async () => res('<html>') })
    ).rejects.toThrow('返回内容不是合法 JSON');
  });
});

describe('browseCategory', () => {
  it('按分类聚合多个源，缺该分类的源标记 supported=false', async () => {
    clearCategoryCache();
    const http: HttpClient = {
      async request(url) {
        if (url.includes('/a.example.com')) {
          if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
          return res({ pagecount: 1, list: [{ vod_id: 11, vod_name: '流浪地球', type_name: '电影' }] });
        }
        if (url.includes('ac=list')) return res({ class: [{ type_id: 2, type_name: '连续剧' }] });
        return res({ list: [] });
      },
    };
    const result = await browseCategory({
      sources: [source, { key: 'k2', name: '乙源', url: 'https://b.example.com/api.php/provide/vod' }],
      key: 'movie',
      http,
    });
    expect(result.items.map((i) => i.vodId)).toEqual(['11']);
    expect(result.supportedSources).toBe(1);
    expect(result.outcomes.find((o) => o.sourceKey === 'k2')).toMatchObject({ ok: true, supported: false });
  });

  it('分类表走缓存，第二次不再请求 ac=list', async () => {
    clearCategoryCache();
    const calls: string[] = [];
    const http: HttpClient = {
      async request(url) {
        calls.push(url);
        if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
        return res({ pagecount: 1, list: [] });
      },
    };
    await browseCategory({ sources: [source], key: 'movie', http });
    await browseCategory({ sources: [source], key: 'movie', http });
    expect(calls.filter((url) => url.includes('ac=list'))).toHaveLength(1);
  });

  it('切回同一个分类直接读缓存，不再打任何接口', async () => {
    clearCategoryCache();
    const calls: string[] = [];
    const http: HttpClient = {
      async request(url) {
        calls.push(url);
        if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
        return res({ pagecount: 1, list: [{ vod_id: 11, vod_name: '流浪地球', type_name: '电影' }] });
      },
    };
    const first = await browseCategory({ sources: [source], key: 'movie', http });
    const before = calls.length;
    const second = await browseCategory({ sources: [source], key: 'movie', http });
    expect(calls.length).toBe(before);
    expect(second.items.map((i) => i.vodId)).toEqual(first.items.map((i) => i.vodId));
  });

  it('换分类不会命中另一个分类的缓存', async () => {
    clearCategoryCache();
    const calls: string[] = [];
    const http: HttpClient = {
      async request(url) {
        calls.push(url);
        if (url.includes('ac=list')) {
          return res({ class: [{ type_id: 1, type_name: '电影' }, { type_id: 2, type_name: '连续剧' }] });
        }
        return res({ pagecount: 1, list: [{ vod_id: 11, vod_name: 'x' }] });
      },
    };
    await browseCategory({ sources: [source], key: 'movie', http });
    const afterMovie = calls.length;
    await browseCategory({ sources: [source], key: 'tv', http });
    expect(calls.length).toBeGreaterThan(afterMovie);
  });

  it('分页：按 pages 拉取并遵守 pagecount', async () => {
    clearCategoryCache();
    setCachedCategories(source.url, [{ id: '1', name: '电影' }]);
    const pages: string[] = [];
    const http: HttpClient = {
      async request(url) {
        const page = /pg=(\d+)/.exec(url)?.[1] ?? '1';
        pages.push(page);
        return res({ pagecount: 2, list: [{ vod_id: Number(page), vod_name: 'x' }] });
      },
    };
    const result = await browseCategory({ sources: [source], key: 'movie', http, pages: 5 });
    expect(pages).toEqual(['1', '2']);
    expect(result.items).toHaveLength(2);
  });

  it('源失败时记录错误但不影响其他源', async () => {
    clearCategoryCache();
    const http: HttpClient = {
      async request(url) {
        if (url.includes('/a.example.com')) {
          if (url.includes('ac=list')) return res({ class: [{ type_id: 1, type_name: '电影' }] });
          return res({ list: [{ vod_id: 1, vod_name: 'x' }] });
        }
        return res('', 500);
      },
    };
    const result = await browseCategory({
      sources: [source, { key: 'k2', name: '乙源', url: 'https://b.example.com/api.php/provide/vod' }],
      key: 'movie',
      http,
    });
    expect(result.items).toHaveLength(1);
    expect(result.outcomes.find((o) => o.sourceKey === 'k2')?.ok).toBe(false);
  });

  it('分类浏览默认过滤成人分类内容', async () => {
    clearCategoryCache();
    setCachedCategories(source.url, [
      { id: '1', name: '电影片' },
      { id: '34', name: '伦理片', parentId: '1' },
      { id: '6', name: '动作片', parentId: '1' },
    ]);
    const http: HttpClient = {
      async request(url) {
        const typeId = /[?&]t=(\d+)/.exec(url)?.[1];
        if (typeId === '34') {
          return res({ list: [{ vod_id: 34, vod_name: '成人内容', type_name: '伦理片' }] });
        }
        return res({ list: [{ vod_id: 6, vod_name: '动作电影', type_name: '动作片' }] });
      },
    };
    // 伦理片名字带「片」会归入电影桶，必须在分类浏览里同样被过滤掉
    const filtered = await browseCategory({ sources: [source], key: 'movie', http });
    expect(filtered.items.map((i) => i.vodId)).toEqual(['6']);

    clearCategoryCache();
    setCachedCategories(source.url, [
      { id: '1', name: '电影片' },
      { id: '34', name: '伦理片', parentId: '1' },
      { id: '6', name: '动作片', parentId: '1' },
    ]);
    const unfiltered = await browseCategory({ sources: [source], key: 'movie', http, filterAdult: false });
    expect(unfiltered.items).toHaveLength(2);
  });

  it('翻页只抓目标页，不会把前面的页全部重下一遍', async () => {
    clearCategoryCache();
    setCachedCategories(source.url, [
      { id: '1', name: '电影片' },
      { id: '6', name: '动作片', parentId: '1' },
    ]);
    const requested: string[] = [];
    const http: HttpClient = {
      async request(url) {
        requested.push(url);
        const page = Number(/[?&]pg=(\d+)/.exec(url)?.[1] ?? '1');
        return res({ page, pagecount: 8, list: [{ vod_id: 100 + page, vod_name: `电影${page}`, type_name: '动作片' }] });
      },
    };

    const first = await browseCategory({ sources: [source], key: 'movie', http, pages: 1, startPage: 1 });
    expect(first.items.map((i) => i.vodId)).toEqual(['101']);
    expect(requested).toHaveLength(1);

    // 追加第 2 页：只应该再打 1 个请求（pg=2），而不是 2 个（pg=1+pg=2）
    requested.length = 0;
    const second = await browseCategory({ sources: [source], key: 'movie', http, pages: 1, startPage: 2 });
    expect(second.items.map((i) => i.vodId)).toEqual(['102']);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('pg=2');
  });
});

describe('probeCategories（首页隐藏空分类）', () => {
  function makeHttp(byType: Record<string, string[]>): HttpClient {
    return {
      async request(url) {
        if (url.includes('ac=list')) {
          return res({
            class: [
              { type_id: 1, type_name: '电影' },
              { type_id: 2, type_name: '连续剧' },
              { type_id: 5, type_name: '少儿' },
            ],
          });
        }
        const typeId = /[?&]t=(\d+)/.exec(url)?.[1] ?? '';
        const names = byType[typeId] ?? [];
        return res({
          pagecount: 1,
          list: names.map((name, i) => ({ vod_id: Number(`${typeId}${i}`), vod_name: name, type_name: '' })),
        });
      },
    };
  }

  it('只把确有内容的分类标记为可用', async () => {
    clearCategoryCache();
    // 「少儿」分类在源里存在但一条内容都没有 -> 首页应当隐藏
    const http = makeHttp({ '1': ['一部电影'], '2': ['一部电视剧'], '5': [] });
    const results = await probeCategories({
      sources: [source],
      http,
      keys: ['movie', 'tv', 'kids'],
    });
    expect(results.map((r) => [r.key, r.available])).toEqual([
      ['movie', true],
      ['tv', true],
      ['kids', false],
    ]);
    expect(results.find((r) => r.key === 'kids')?.hits).toBe(0);
    expect(results.find((r) => r.key === 'movie')?.sample?.name).toBe('一部电影');
  });

  it('按 HOME 顺序返回全部默认分类', async () => {
    clearCategoryCache();
    const http = makeHttp({ '1': ['x'], '2': ['y'], '5': ['z'] });
    const results = await probeCategories({ sources: [source], http });
    expect(results.map((r) => r.key)).toEqual(HOME_CATEGORIES.map((c) => c.key));
  });

  it('每个分类完成时就回调，便于边探测边点亮入口', async () => {
    clearCategoryCache();
    const seen: string[] = [];
    const http = makeHttp({ '1': ['x'] });
    await probeCategories({
      sources: [source],
      http,
      keys: ['movie', 'kids'],
      onProbe: (r) => seen.push(`${r.key}:${r.available}`),
    });
    expect(seen.sort()).toEqual(['kids:false', 'movie:true']);
  });

  it('单个分类抛错时按不可用处理，不影响其他分类', async () => {
    clearCategoryCache();
    const http: HttpClient = {
      async request(url) {
        if (url.includes('ac=list')) return res('', 500);
        return res({ list: [] });
      },
    };
    const results = await probeCategories({ sources: [source], http, keys: ['movie', 'tv'] });
    expect(results.every((r) => !r.available)).toBe(true);
    expect(results).toHaveLength(2);
  });

  it('成人内容算作空分类（过滤后无线索即隐藏入口）', async () => {
    clearCategoryCache();
    setCachedCategories(source.url, [
      { id: '1', name: '电影片' },
      { id: '34', name: '伦理片', parentId: '1' },
    ]);
    const http: HttpClient = {
      async request(url) {
        if (url.includes('ac=list')) {
          return res({ class: [{ type_id: 1, type_name: '电影片' }, { type_id: 34, type_name: '伦理片' }] });
        }
        const typeId = /[?&]t=(\d+)/.exec(url)?.[1];
        if (typeId === '34') {
          return res({ list: [{ vod_id: 34, vod_name: '成人内容', type_name: '伦理片' }] });
        }
        return res({ list: [] });
      },
    };
    const results = await probeCategories({ sources: [source], http, keys: ['movie'] });
    // 唯一的条目被成人过滤拦下，电影分类实际为空
    expect(results[0].available).toBe(false);
  });
});
