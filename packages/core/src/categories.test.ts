import { describe, expect, it } from 'vitest';
import {
  browseCategory,
  categoryLabel,
  classifyCategoryName,
  fetchSourceCategories,
  HOME_CATEGORIES,
  matchTypeId,
  matchTypeIds,
  parseSourceCategories,
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

  it('首页分类入口不含「其他」且顺序稳定', () => {
    expect(HOME_CATEGORIES.map((c) => c.key)).toEqual(['kids', 'doc', 'anime', 'variety', 'short', 'tv', 'sports', 'movie']);
    expect(categoryLabel('tv')).toBe('电视剧');
    expect(categoryLabel('movie')).toBe('电影');
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
});
