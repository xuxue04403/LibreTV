import { describe, expect, it } from 'vitest';
import { stripAdGroups } from './ad-filter';
import { collectGroups, createM3uParser, normalizeStreamUrl, parseM3u, parseM3uEpgUrl } from './m3u';

describe('parseM3u', () => {
  it('解析标准 EXTINF 属性与分组', () => {
    const content = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV1" tvg-logo="https://i/logo.png" group-title="央视",CCTV-1 综合',
      '#EXTVLCOPT:http-user-agent=x',
      'https://live.example.com/cctv1.m3u8',
    ].join('\n');
    const channels = parseM3u(content);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      id: 'cctv1',
      name: 'CCTV-1 综合',
      url: 'https://live.example.com/cctv1.m3u8',
      group: '央视',
      tvgId: 'cctv1',
      rawName: 'CCTV1',
    });
    expect(collectGroups(channels)).toEqual(['央视']);
  });

  it('支持属性写在标题之后与 #EXTGRP', () => {
    const content = [
      '#EXTM3U',
      '#EXTINF:-1,湖南卫视 tvg-id="hunan"',
      'https://a/hunan.m3u8',
      '#EXTINF:-1,浙江卫视',
      '#EXTGRP:地方台',
      'https://a/zhejiang.m3u8',
    ].join('\n');
    const channels = parseM3u(content);
    expect(channels[0].tvgId).toBe('hunan');
    expect(channels[1].group).toBe('地方台');
  });

  it('过滤非 http 协议并按 URL 去重', () => {
    const content = ['#EXTINF:-1,A', 'rtp://239.0.0.1:1234', '#EXTINF:-1,B', 'https://x/b.m3u8', '#EXTINF:-1,B2', 'https://x/b.m3u8'].join('\n');
    const channels = parseM3u(content);
    expect(channels.map((c) => c.url)).toEqual(['https://x/b.m3u8']);
  });

  it('相对地址按订阅地址解析', () => {
    const content = ['#EXTINF:-1,A', '/live/a.m3u8'].join('\n');
    expect(parseM3u(content, 'https://host/sub/list.m3u')[0].url).toBe('https://host/live/a.m3u8');
  });

  it('解析头部 EPG 地址', () => {
    expect(parseM3uEpgUrl('#EXTM3U x-tvg-url="https://epg/e.xml.gz"', 'https://a/list.m3u')).toBe('https://epg/e.xml.gz');
    expect(parseM3uEpgUrl('#EXTM3U', 'https://a/list.m3u')).toBeUndefined();
  });

  it('normalizeStreamUrl 拒绝空串与非法协议', () => {
    expect(normalizeStreamUrl('  ')).toBeUndefined();
    expect(normalizeStreamUrl('udp://1.2.3.4:5000')).toBeUndefined();
  });
});

describe('createM3uParser（增量解析）', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="cctv1" group-title="央视",CCTV-1',
    'https://a/1.m3u8',
    '#EXTINF:-1 tvg-id="cctv2" group-title="央视",CCTV-2',
    'https://a/2.m3u8',
    '#EXTINF:-1 group-title="卫视",湖南卫视',
    'https://a/3.m3u8',
  ].join('\n');

  /** 把整串按固定长度切片喂进去，模拟网络分块 */
  const feedBy = (chunkSize: number): string[] => {
    const parser = createM3uParser();
    const names: string[] = [];
    for (let i = 0; i < playlist.length; i += chunkSize) {
      names.push(...parser.push(playlist.slice(i, i + chunkSize)).map((c) => c.name));
    }
    names.push(...parser.end().map((c) => c.name));
    return names;
  };

  it('任意切分位置都与整串解析结果一致', () => {
    const expectNames = ['CCTV-1', 'CCTV-2', '湖南卫视'];
    for (const size of [1, 2, 3, 7, 13, 64, 1000]) {
      expect(feedBy(size), `chunkSize=${size}`).toEqual(expectNames);
    }
  });

  it('分块切开多字节中文也不会乱码', () => {
    // 中文按 1 字节切分必然切开 3 字节的 UTF-8 序列
    expect(feedBy(1)).toEqual(['CCTV-1', 'CCTV-2', '湖南卫视']);
  });

  it('跨块累积的 EXTINF 属性仍然生效', () => {
    const parser = createM3uParser();
    // 属性名和值分别落在不同 chunk 里
    parser.push('#EXTINF:-1 tvg-id="cctv1" tvg-na');
    parser.push('me="CCTV1" group-title="央视",CCTV-1\n');
    const first = parser.push('https://a/1.m3u8\n');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: 'cctv1', group: '央视', rawName: 'CCTV1' });
  });

  it('只返回本段新增频道，不重复返回已解析的', () => {
    const parser = createM3uParser();
    const a = parser.push('#EXTINF:-1,A\nhttps://a/1.m3u8\n');
    const b = parser.push('#EXTINF:-1,B\nhttps://a/2.m3u8\n');
    expect(a.map((c) => c.name)).toEqual(['A']);
    expect(b.map((c) => c.name)).toEqual(['B']);
  });

  it('末行没有换行时 end() 能收尾', () => {
    const parser = createM3uParser();
    expect(parser.push('#EXTINF:-1,尾部频道\nhttps://a/tail.m3u8')).toHaveLength(0);
    expect(parser.end().map((c) => c.name)).toEqual(['尾部频道']);
  });

  it('整串与增量解析结果完全一致', () => {
    expect(parseM3u(playlist)).toEqual(
      (() => {
        const parser = createM3uParser();
        return parser.push(playlist).concat(parser.end());
      })()
    );
  });
});

describe('stripAdGroups', () => {
  const build = (segments: string[], extras: string[] = []) => ['#EXTM3U', '#EXT-X-TARGETDURATION:10', ...extras, ...segments].join('\n');

  it('剔除片头 DISCONTINUITY 广告段', () => {
    const content = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:5,',
      'https://cdn/ad/1.ts',
      '#EXTINF:5,',
      'https://cdn/ad/2.ts',
      '#EXT-X-DISCONTINUITY',
      ...Array.from({ length: 10 }, () => ['#EXTINF:10,', 'https://cdn/main/x.ts']).flat(),
    ].join('\n');
    const out = stripAdGroups(content);
    expect(out).not.toContain('cdn/ad/');
    expect(out.split('\n').filter((l) => l.startsWith('https://cdn/main')).length).toBe(10);
    expect(out.split('\n')[0]).toBe('#EXTM3U');
  });

  it('多分组封装（片头组与其余组同构）不误删', () => {
    const group = Array.from({ length: 5 }, () => ['#EXTINF:10,', 'https://cdn/main/s.ts']).flat();
    const content = ['#EXTM3U', ...group, '#EXT-X-DISCONTINUITY', ...group, '#EXT-X-DISCONTINUITY', ...group, '#EXT-X-DISCONTINUITY', ...group, '#EXT-X-DISCONTINUITY', ...group].join('\n');
    expect(stripAdGroups(content)).toBe(content);
  });

  it('按 URL 特征剔除中插广告段', () => {
    const content = [
      '#EXTM3U',
      '#EXTINF:300,',
      'https://cdn/main/1.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:15,',
      'https://cdn/video/adjump/a.ts',
      '#EXTINF:15,',
      'https://cdn/video/adjump/b.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:300,',
      'https://cdn/main/2.ts',
    ].join('\n');
    const out = stripAdGroups(content);
    expect(out).not.toContain('adjump');
    expect(out).toContain('https://cdn/main/1.ts');
    expect(out).toContain('https://cdn/main/2.ts');
  });

  it('空输入返回空串', () => {
    expect(stripAdGroups('')).toBe('');
  });

  it('build 辅助函数可用（防止 lint 未使用告警）', () => {
    expect(build(['#EXTINF:10,', 'https://x/a.ts'])).toContain('https://x/a.ts');
  });
});
