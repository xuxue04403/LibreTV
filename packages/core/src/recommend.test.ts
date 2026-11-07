import { describe, expect, it } from 'vitest';
import {
  DOUBAN_TAGS,
  HOT_LISTS,
  filterAdultRecommendItems,
  hotListPath,
  parseBangumiCalendar,
  parseDoubanSubjects,
  parseHotList,
} from './recommend';

describe('parseBangumiCalendar', () => {
  it('中文名优先、评分保留一位小数、按星期归属', () => {
    const items = parseBangumiCalendar([
      {
        weekday: { id: 3, cn: '周三' },
        items: [
          {
            id: 101,
            name: '葬送のフリーレン',
            name_cn: '葬送的芙莉莲',
            images: { large: 'https://lain.bgm.tv/pic/cover/l/a.jpg' },
            rating: { score: 8.94 },
          },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '101',
      title: '葬送的芙莉莲',
      cover: 'https://lain.bgm.tv/pic/cover/l/a.jpg',
      rating: '8.9',
      weekday: 3,
      source: 'bangumi',
      isTv: true,
    });
  });

  it('丢弃非法星期、缺封面与无 id 的条目', () => {
    const items = parseBangumiCalendar([
      { weekday: { id: 8 }, items: [{ id: 1, name: 'x', images: { large: 'https://a' } }] },
      { weekday: { id: 1 }, items: [{ id: 2, name: 'y' }] },
      { weekday: { id: 2 }, items: [{ name: 'z', images: { large: 'https://a' } }] },
      { weekday: { id: 2 }, items: [{ id: 3, name: 'ok', images: { large: 'https://a' } }] },
    ]);
    expect(items.map((i) => i.id)).toEqual(['3']);
  });

  it('无评分或 0 分时不产出 rating', () => {
    const items = parseBangumiCalendar([
      { weekday: { id: 1 }, items: [{ id: 1, name: 'a', images: { large: 'https://a' }, rating: { score: 0 } }] },
    ]);
    expect(items[0]?.rating).toBeUndefined();
  });

  it('非数组输入返回空', () => {
    expect(parseBangumiCalendar(null)).toEqual([]);
    expect(parseBangumiCalendar({ items: [] })).toEqual([]);
  });
});

describe('parseDoubanSubjects', () => {
  it('读取 subjects、rate 为 0 视为无评分、type 决定 isTv', () => {
    const items = parseDoubanSubjects(
      {
        subjects: [
          { id: '1', title: '流浪地球', cover: 'https://img1.doubanio.com/a.jpg', rate: '8.3' },
          { id: '2', title: '未评分', cover: 'https://img1.doubanio.com/b.jpg', rate: '0' },
        ],
      },
      'tv'
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: '1', rating: '8.3', isTv: true, source: 'douban' });
    expect(items[1]?.rating).toBeUndefined();
  });

  it('缺封面/标题/ id 的脏数据被丢弃', () => {
    const items = parseDoubanSubjects(
      { subjects: [{ id: '1' }, { title: 'b', cover: 'https://a' }, { id: '3', title: 'c' }] },
      'movie'
    );
    expect(items).toEqual([]);
  });
});

describe('parseHotList', () => {
  it('豆瓣周榜：原生 cover 优先，镜像兜底，带 listId', () => {
    const items = parseHotList(
      {
        data: [
          { id: 1, title: 'A', rating: 8.25, cover: 'https://img1.doubanio.com/a.jpg' },
          { id: 2, title: 'B', cover_proxy: 'https://doubanio.viki.moe/b.jpg' },
        ],
      },
      'douban_tv_chinese'
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: '1',
      rating: '8.3',
      cover: 'https://img1.doubanio.com/a.jpg',
      isTv: true,
      listId: 'douban_tv_chinese',
    });
    expect(items[1]?.cover).toBe('https://doubanio.viki.moe/b.jpg');
  });

  it('百度热播剧：用序号造 id，缺海报丢弃，无评分', () => {
    const items = parseHotList(
      { data: [{ title: 'A', cover: 'https://a.jpg' }, { title: 'B', cover: null }, { title: 'C' }] },
      'baidu_teleplay'
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'baidu_0', title: 'A', isTv: true, listId: 'baidu_teleplay' });
  });

  it('响应格式不对时返回空', () => {
    expect(parseHotList(null, 'douban_movie_weekly')).toEqual([]);
    expect(parseHotList({ data: 'nope' }, 'douban_movie_weekly')).toEqual([]);
  });
});

describe('榜单与标签常量', () => {
  it('六个榜单各有 API 路径，豆瓣电影周榜不是剧集', () => {
    for (const list of HOT_LISTS) {
      expect(hotListPath(list.id)).toMatch(/^\/v2\//);
    }
    expect(HOT_LISTS.find((l) => l.id === 'douban_movie_weekly')?.isTv).toBe(false);
    expect(hotListPath('douban_show_global')).toBe('/v2/douban/weekly/show_global');
    expect(hotListPath('baidu_teleplay')).toBe('/v2/baidu/teleplay');
  });

  it('豆瓣电影与剧集标签各 10 个', () => {
    expect(DOUBAN_TAGS.movie).toHaveLength(10);
    expect(DOUBAN_TAGS.tv).toHaveLength(10);
  });
});

describe('filterAdultRecommendItems', () => {
  it('开关打开时按标题过滤，关闭时原样返回', () => {
    const items = parseDoubanSubjects(
      {
        subjects: [
          { id: '1', title: '普通电影', cover: 'https://a.jpg', rate: '7.0' },
          { id: '2', title: '情色片编年史', cover: 'https://b.jpg', rate: '7.0' },
        ],
      },
      'movie'
    );
    expect(filterAdultRecommendItems(items, true)).toHaveLength(1);
    expect(filterAdultRecommendItems(items, false)).toHaveLength(2);
  });
});
