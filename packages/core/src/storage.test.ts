import { describe, expect, it } from 'vitest';
import { exportSourceList, normalizeSubscription, parseRelaxedJson, parseSubscription } from './subscriptions';
import { DEFAULT_SETTINGS, normalizeSettings, parseSnapshot, toggleFavorite, upsertHistory } from './storage';
import { currentAndNext, parseXmltv, parseXmltvTime } from './live';
import { episodeLabel, formatTime, stableKey, trimSlash } from './format';

describe('parseSubscription', () => {
  it('解析 LibreTV-SourceList', () => {
    const parsed = parseSubscription(
      JSON.stringify({
        name: '我的源',
        version: 2,
        sources: [{ name: 'A', url: 'https://a/api.php/provide/vod/' }],
        liveSources: [{ name: 'L', url: 'https://l/list.m3u', epg: 'https://l/epg.xml.gz' }],
      }),
      'https://sub.example.com/list.json'
    );
    expect(parsed.name).toBe('我的源');
    expect(parsed.stats.format).toBe('libretv');
    expect(parsed.sources[0]).toMatchObject({ name: 'A', url: 'https://a/api.php/provide/vod' });
    expect(parsed.sources[0].key).toMatch(/^sub_.+_0$/);
    expect(parsed.liveSources[0].epg).toBe('https://l/epg.xml.gz');
  });

  it('解析 TVBOX 配置并跳过 Spider/XML/不可搜索', () => {
    const parsed = normalizeSubscription({
      sites: [
        { name: 'CMS', api: 'https://cms/api.php/provide/vod', type: 1 },
        { name: 'Spider', api: 'csp_AppYs', type: 3 },
        { name: 'XML', api: 'https://x/api.php/provide/vod/at/xml', type: 0 },
        { name: 'NoSearch', api: 'https://n/api.php/provide/vod', type: 1, searchable: 0 },
        { name: 'Implicit', api: 'https://i/api.php/provide/vod', type: 0 },
      ],
      lives: [
        { name: '直播', url: 'https://l/list.m3u8', type: 0 },
        { name: 'TXT', url: 'https://l/channels.txt', type: 0 },
      ],
    });
    expect(parsed.sources.map((s) => s.name)).toEqual(['CMS', 'Implicit']);
    expect(parsed.liveSources).toHaveLength(1);
    expect(parsed.stats.skippedByReason).toMatchObject({ spider: 1, xml: 1, unsearchable: 1, nonM3uLive: 1 });
  });

  it('裸数组视为点播源', () => {
    const parsed = normalizeSubscription([{ name: 'A', url: 'https://a/api.php/provide/vod' }]);
    expect(parsed.stats.format).toBe('array');
    expect(parsed.sources).toHaveLength(1);
  });

  it('按 URL 去重并剔除非法地址', () => {
    const parsed = normalizeSubscription({
      sources: [
        { url: 'https://a/api.php/provide/vod' },
        { url: 'https://a/api.php/provide/vod/' },
        { url: 'ftp://bad' },
        { url: 'not-a-url' },
      ],
    });
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.stats.skippedByReason.invalidUrl).toBe(2);
  });

  it('格式不对时抛错', () => {
    expect(() => normalizeSubscription({ foo: 1 })).toThrow('订阅内容格式不正确');
    expect(() => parseSubscription('not json')).toThrow('订阅内容不是合法的 JSON');
  });

  it('宽容解析注释与尾随逗号', () => {
    const text = `{
      // 注释
      "sources": [
        { "name": "A", "url": "https://a/api.php/provide/vod" }, // 尾随逗号在下一行
      ],
    }`;
    expect(() => parseSubscription(text)).not.toThrow();
    const obj = parseRelaxedJson<{ a: number[] }>('{ "a": [1,2,] }');
    expect(obj.a).toEqual([1, 2]);
  });

  it('exportSourceList 可被自身再次解析', () => {
    const json = exportSourceList(
      [{ key: 'k', name: 'A', url: 'https://a/api.php/provide/vod' }],
      [{ key: 'l', name: 'L', url: 'https://l/list.m3u' }]
    );
    const parsed = parseSubscription(json);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.liveSources).toHaveLength(1);
  });
});

describe('storage 纯函数', () => {
  it('upsertHistory 去重置顶并裁剪', () => {
    let list = upsertHistory([], { id: 'a:1', sourceKey: 'a', vodId: '1', title: 'A', sourceName: 's', episodeIndex: 0, episodeCount: 10, position: 5, duration: 100 });
    list = upsertHistory(list, { id: 'a:2', sourceKey: 'a', vodId: '2', title: 'B', sourceName: 's', episodeIndex: 1, episodeCount: 2, position: 1, duration: 10 });
    list = upsertHistory(list, { ...list[0], position: 30 });
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('a:2');
    expect(list[0].position).toBe(30);
  });

  it('toggleFavorite 可增删', () => {
    const entry = { id: 'a:1', sourceKey: 'a', vodId: '1', title: 'A' };
    let list = toggleFavorite([], entry);
    expect(list).toHaveLength(1);
    list = toggleFavorite(list, entry);
    expect(list).toHaveLength(0);
  });

  it('normalizeSettings 补默认值', () => {
    expect(normalizeSettings({ adFilter: false })).toMatchObject({ adFilter: false, adultFilter: DEFAULT_SETTINGS.adultFilter });
  });

  it('parseSnapshot 拒绝非法输入并兼容 customAPIs', () => {
    expect(parseSnapshot('nope')).toBeNull();
    const snap = parseSnapshot(JSON.stringify({ customAPIs: [{ key: 'k', name: 'A', url: 'https://a' }], history: [] }));
    expect(snap?.sources).toHaveLength(1);
    expect(snap?.selectedKeys).toEqual(['k']);
  });
});

describe('EPG', () => {
  it('parseXmltvTime 支持时区与 Z', () => {
    expect(parseXmltvTime('20240101120000 +0800')).toBe(Date.UTC(2024, 0, 1, 4, 0, 0));
    expect(parseXmltvTime('20240101120000')).toBe(Date.UTC(2024, 0, 1, 12, 0, 0));
    expect(parseXmltvTime('bad')).toBeNaN();
  });

  it('parseXmltv 按窗口裁剪并解码实体', () => {
    const now = Date.UTC(2024, 0, 1, 12, 0, 0);
    const xml = `<tv>
      <programme start="20240101110000 +0000" stop="20240101130000 +0000" channel="cctv1">
        <title>新闻 &amp; 联播</title><desc><![CDATA[描述]]></desc>
      </programme>
      <programme start="20240101130000 +0000" stop="20240101140000 +0000" channel="cctv1"><title>焦点访谈</title></programme>
      <programme start="20240102000000 +0000" stop="20240102010000 +0000" channel="cctv1"><title>太远了</title></programme>
    </tv>`;
    const map = parseXmltv(xml, 3 * 3600 * 1000, now);
    const list = map.get('cctv1')!;
    expect(list.map((p) => p.title)).toEqual(['新闻 & 联播', '焦点访谈']);
    expect(currentAndNext(list, now).current?.title).toBe('新闻 & 联播');
    expect(currentAndNext(list, now).next?.title).toBe('焦点访谈');
  });
});

describe('format 辅助', () => {
  it('formatTime', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(75)).toBe('01:15');
    expect(formatTime(3675)).toBe('1:01:15');
    expect(formatTime(-1)).toBe('00:00');
  });

  it('trimSlash / stableKey / episodeLabel', () => {
    expect(trimSlash('https://a/b///')).toBe('https://a/b');
    expect(stableKey('abc')).toBe(stableKey('abc'));
    expect(stableKey('abc')).not.toBe(stableKey('abd'));
    expect(episodeLabel('https://cdn/12.m3u8', 0)).toBe('第 12 集');
    expect(episodeLabel('https://cdn/abc.m3u8', 3)).toBe('第 4 集');
  });
});
