import { describe, expect, it } from 'vitest';
import { stripAdGroups } from './ad-filter';
import { collectGroups, normalizeStreamUrl, parseM3u, parseM3uEpgUrl } from './m3u';

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
