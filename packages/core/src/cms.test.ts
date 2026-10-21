import { describe, expect, it } from 'vitest';
import {
  extractEpisodesFromPlayUrl,
  filterAdultResults,
  filterRelevantResults,
  isRelevant,
  normalizeTitle,
  parseDetail,
  parseSearchList,
} from './cms';
import type { SourceConfig } from './types';

const source: SourceConfig = { key: 'custom_0', name: '示例源', url: 'https://example.com/api.php/provide/vod' };

describe('parseSearchList', () => {
  it('解析标准搜索结果', () => {
    const list = parseSearchList(
      {
        list: [
          { vod_id: 1, vod_name: '流浪地球', vod_pic: 'https://img/1.jpg', type_name: '科幻片', vod_year: '2019' },
        ],
      },
      source
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sourceKey: 'custom_0',
      vodId: '1',
      name: '流浪地球',
      typeName: '科幻片',
      year: '2019',
      sourceUrl: source.url,
    });
  });

  it('list 为 null 时返回空数组', () => {
    expect(parseSearchList({ list: null }, source)).toEqual([]);
  });

  it('list 不是数组时抛错', () => {
    expect(() => parseSearchList({ list: 'oops' }, source)).toThrow('API返回的数据格式无效');
    expect(() => parseSearchList(null, source)).toThrow('API返回的数据格式无效');
  });
});

describe('extractEpisodesFromPlayUrl', () => {
  it('优先选包含 m3u8 的线路', () => {
    const playUrl =
      '第1集$https://x.com/share/abc.html#第2集$https://x.com/share/def.html$$$第1集$https://cdn.x.com/a/index.m3u8#第2集$https://cdn.x.com/b/index.m3u8';
    expect(extractEpisodesFromPlayUrl(playUrl)).toEqual([
      'https://cdn.x.com/a/index.m3u8',
      'https://cdn.x.com/b/index.m3u8',
    ]);
  });

  it('无 m3u8 时回退第一条线路，并过滤非 http 地址', () => {
    const playUrl = '第1集$ftp://x/a.mp4#第2集$https://x.com/b.mp4';
    expect(extractEpisodesFromPlayUrl(playUrl)).toEqual(['https://x.com/b.mp4']);
  });

  it('空输入返回空数组', () => {
    expect(extractEpisodesFromPlayUrl('')).toEqual([]);
  });
});

describe('parseDetail', () => {
  it('解析详情并提取剧集', () => {
    const detail = parseDetail(
      {
        list: [
          {
            vod_name: '三体',
            vod_pic: 'https://img/3.jpg',
            vod_content: '简介',
            type_name: '国产剧',
            vod_year: '2023',
            vod_play_url: '第1集$https://cdn/1.m3u8#第2集$https://cdn/2.m3u8',
          },
        ],
      },
      source
    );
    expect(detail.episodes).toHaveLength(2);
    expect(detail.videoInfo).toMatchObject({ title: '三体', typeName: '国产剧', sourceKey: 'custom_0' });
  });

  it('无剧集时从简介兜底提取 m3u8', () => {
    const detail = parseDetail(
      { list: [{ vod_name: 'x', vod_content: '播放地址：$https://cdn/x/index.m3u8' }] },
      source
    );
    expect(detail.episodes).toEqual(['https://cdn/x/index.m3u8']);
  });

  it('空列表抛错', () => {
    expect(() => parseDetail({ list: [] }, source)).toThrow('获取到的详情内容无效');
  });
});

describe('相关性过滤', () => {
  it('忽略标点与大小写差异', () => {
    expect(isRelevant('摔跤吧!爸爸', '摔跤吧！爸爸')).toBe(true);
    expect(isRelevant('SPY×FAMILY', 'spy family')).toBe(true);
  });

  it('多词查询要求全部命中', () => {
    const items = [{ name: '庆余年 第二季' }, { name: '庆余年' }, { name: '繁花' }];
    expect(filterRelevantResults(items, '庆余年 第二季').map((i) => i.name)).toEqual(['庆余年 第二季']);
  });

  it('季数必须匹配，不能把第 2 季当成 12 集', () => {
    expect(isRelevant('庆余年 第二季', '庆余年2')).toBe(true);
    expect(isRelevant('庆余年 第三季', '庆余年2')).toBe(false);
    expect(isRelevant('某剧 12', '某剧 2')).toBe(false);
  });

  it('normalizeTitle 去掉标点与空白', () => {
    expect(normalizeTitle('Hello, World! 你好')).toBe('helloworld你好');
  });
});

describe('成人内容过滤', () => {
  it('命中关键词时过滤', () => {
    const items = [{ typeName: '伦理片' }, { typeName: '科幻片' }];
    expect(filterAdultResults(items, true)).toEqual([{ typeName: '科幻片' }]);
    expect(filterAdultResults(items, false)).toHaveLength(2);
  });
});
