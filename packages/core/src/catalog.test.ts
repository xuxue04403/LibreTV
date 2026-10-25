import { describe, expect, it } from 'vitest';
import {
  CATALOG_TTL_MS,
  MAX_CATALOG_ITEMS,
  MAX_SEARCH_KEYWORDS,
  MAX_SEARCH_ITEMS,
  SEARCH_CACHE_TTL_MS,
  catalogItems,
  catalogSignature,
  dedupeItems,
  emptyCatalog,
  isCatalogFresh,
  searchCacheItems,
  searchCacheKey,
  staleCategories,
  withCatalogEntry,
  withSearchEntry,
  type SearchCacheSnapshot,
} from './catalog';
import type { CategoryKey } from './categories';
import type { SearchResultItem, SourceConfig } from './types';

function item(name: string, vodId = '1', sourceKey = 'a'): SearchResultItem {
  return {
    sourceKey,
    sourceName: sourceKey,
    vodId,
    name,
    pic: `https://img/${vodId}.jpg`,
    typeName: '电影',
    year: '2026',
  };
}

const sources: SourceConfig[] = [
  { key: 'a', name: 'A', url: 'https://a.example.com/api.php/provide/vod' },
  { key: 'b', name: 'B', url: 'https://b.example.com/api.php/provide/vod' },
];

describe('catalogSignature', () => {
  it('源顺序不影响签名', () => {
    expect(catalogSignature(sources, true)).toBe(catalogSignature([...sources].reverse(), true));
  });

  it('源集合或成人开关变化都会换签名', () => {
    const base = catalogSignature(sources, true);
    expect(base).not.toBe(catalogSignature(sources, false));
    expect(base).not.toBe(catalogSignature(sources.slice(0, 1), true));
    expect(base).not.toBe(catalogSignature([...sources, { key: 'c', name: 'C', url: 'https://c' }], true));
  });
});

describe('catalog 条目读写', () => {
  it('写入后能读回', () => {
    const snap = withCatalogEntry(emptyCatalog('sig'), 'movie', [item('沙丘'), item('沙丘2', '2')]);
    expect(catalogItems(snap, 'movie')?.map((i) => i.name)).toEqual(['沙丘', '沙丘2']);
  });

  it('没缓存过的分类返回 undefined 而不是空数组', () => {
    // 界面要区分「没缓存（显示骨架）」和「缓存里就是空的（显示空状态）」
    expect(catalogItems(emptyCatalog('sig'), 'tv')).toBeUndefined();
  });

  it('空列表不覆盖已有缓存', () => {
    const snap = withCatalogEntry(emptyCatalog('sig'), 'movie', [item('沙丘')]);
    expect(catalogItems(withCatalogEntry(snap, 'movie', []), 'movie')).toHaveLength(1);
  });

  it('超出上限时截断', () => {
    const many = Array.from({ length: MAX_CATALOG_ITEMS + 60 }, (_, i) => item(`片${i}`, `${i}`));
    const snap = withCatalogEntry(emptyCatalog('sig'), 'movie', many);
    expect(catalogItems(snap, 'movie')).toHaveLength(MAX_CATALOG_ITEMS);
  });

  it('过期后不新鲜但内容仍在（可以先用旧内容顶上）', () => {
    const now = 1_000_000;
    const snap = withCatalogEntry(emptyCatalog('sig'), 'movie', [item('沙丘')], now);
    expect(isCatalogFresh(snap, 'movie', now + 1000)).toBe(true);
    expect(isCatalogFresh(snap, 'movie', now + CATALOG_TTL_MS + 1)).toBe(false);
    expect(catalogItems(snap, 'movie')).toHaveLength(1);
  });

  it('从未缓存的分类不新鲜', () => {
    expect(isCatalogFresh(emptyCatalog('sig'), 'anime')).toBe(false);
  });

  it('staleCategories 只返回没缓存或过期的', () => {
    const now = 1_000_000;
    const snap = withCatalogEntry(emptyCatalog('sig'), 'movie', [item('沙丘')], now);
    const keys: CategoryKey[] = ['movie', 'tv', 'anime'];
    expect(staleCategories(snap, keys, now + 1000)).toEqual(['tv', 'anime']);
    expect(staleCategories(snap, keys, now + CATALOG_TTL_MS + 1)).toEqual(keys);
  });
});

describe('searchCache', () => {
  it('命中同一关键词', () => {
    const snap = withSearchEntry({ entries: {} }, '沙丘', true, [item('沙丘')]);
    expect(searchCacheItems(snap, '沙丘', true)).toHaveLength(1);
  });

  it('关键词忽略大小写与首尾空格', () => {
    const snap = withSearchEntry({ entries: {} }, 'Dune', true, [item('Dune')]);
    expect(searchCacheItems(snap, '  dune ', true)).toHaveLength(1);
    expect(searchCacheKey('  DUNE ', true)).toBe(searchCacheKey('dune', true));
  });

  it('成人开关不同不共用缓存', () => {
    const snap = withSearchEntry({ entries: {} }, '沙丘', true, [item('沙丘')]);
    expect(searchCacheItems(snap, '沙丘', false)).toBeUndefined();
  });

  it('过期不再命中', () => {
    const now = 5_000_000;
    const snap = withSearchEntry({ entries: {} }, '沙丘', true, [item('沙丘')], now);
    expect(searchCacheItems(snap, '沙丘', true, now + 1000)).toHaveLength(1);
    expect(searchCacheItems(snap, '沙丘', true, now + SEARCH_CACHE_TTL_MS + 1)).toBeUndefined();
  });

  it('空结果不写缓存', () => {
    expect(withSearchEntry({ entries: {} }, '沙丘', true, []).entries).toEqual({});
  });

  it('关键词超过上限时丢最旧的', () => {
    let snap: SearchCacheSnapshot = { entries: {} };
    for (let i = 0; i < MAX_SEARCH_KEYWORDS + 5; i++) {
      snap = withSearchEntry(snap, `词${i}`, true, [item(`片${i}`)], 1_000 + i);
    }
    expect(Object.keys(snap.entries)).toHaveLength(MAX_SEARCH_KEYWORDS);
    const now = 1_000 + MAX_SEARCH_KEYWORDS + 4;
    expect(searchCacheItems(snap, `词${MAX_SEARCH_KEYWORDS + 4}`, true, now)).toHaveLength(1);
    expect(searchCacheItems(snap, '词0', true, now)).toBeUndefined();
  });

  it('单关键词条目截断', () => {
    const many = Array.from({ length: MAX_SEARCH_ITEMS + 50 }, (_, i) => item(`片${i}`, `${i}`));
    const snap = withSearchEntry({ entries: {} }, '沙丘', true, many);
    expect(searchCacheItems(snap, '沙丘', true)).toHaveLength(MAX_SEARCH_ITEMS);
  });

  it('没有快照时返回 undefined', () => {
    expect(searchCacheItems(undefined, '沙丘', true)).toBeUndefined();
  });
});

describe('dedupeItems', () => {
  it('按源:片 ID 去重且保持顺序', () => {
    const list = [item('沙丘', '1', 'a'), item('沙丘', '1', 'a'), item('沙丘', '1', 'b'), item('沙丘2', '2', 'a')];
    expect(dedupeItems(list).map((i) => `${i.sourceKey}:${i.vodId}`)).toEqual(['a:1', 'b:1', 'a:2']);
  });
});
