import { describe, expect, it } from 'vitest';
import { ADULT_LIVE_KEYWORDS, filterAdultChannels, isAdultChannel } from './live';
import type { LiveChannel } from './types';

const ch = (name: string, group?: string, tvgId?: string): LiveChannel =>
  ({ id: name, name, url: `http://a/${name}.m3u8`, group, tvgId }) as LiveChannel;

/**
 * 直播频道的成人过滤。
 *
 * 此前直播链路完全没有过滤：用户在设置里开了成人屏蔽，
 * 点播生效、直播却把「Hot Adult 18+」原样列出来——两套语义不一致。
 */
describe('isAdultChannel', () => {
  it('按分组名识别', () => {
    expect(isAdultChannel({ name: '频道1', group: '成人' })).toBe(true);
    expect(isAdultChannel({ name: '频道1', group: '18+' })).toBe(true);
    expect(isAdultChannel({ name: '频道1', group: 'XXX' })).toBe(true);
    expect(isAdultChannel({ name: '频道1', group: '央视' })).toBe(false);
  });

  it('按台名识别', () => {
    expect(isAdultChannel({ name: 'Hot Adult 18+' })).toBe(true);
    expect(isAdultChannel({ name: '午夜剧场' })).toBe(true);
    expect(isAdultChannel({ name: 'Playboy TV' })).toBe(true);
    expect(isAdultChannel({ name: 'BraZZers HD' })).toBe(true);
    expect(isAdultChannel({ name: 'CCTV-1' })).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isAdultChannel({ name: 'SEX TV' })).toBe(true);
    expect(isAdultChannel({ name: 'sex tv' })).toBe(true);
  });

  it('空字段安全', () => {
    expect(isAdultChannel({})).toBe(false);
    expect(isAdultChannel({ name: '', group: '' })).toBe(false);
  });

  it('不误伤正常频道名', () => {
    for (const name of ['CCTV-5 体育', '湖南卫视', 'Discovery', '凤凰中文', 'HBO', 'National Geographic']) {
      expect(isAdultChannel({ name, group: '卫视' }), name).toBe(false);
    }
  });
});

describe('filterAdultChannels', () => {
  const list = [
    ch('CCTV-1', '央视'),
    ch('湖南卫视', '卫视'),
    ch('Hot Adult 18+', '成人'),
    ch('午夜剧场', '未分组'),
    ch('Discovery', '纪录片'),
  ];

  it('开关打开时剔除成人频道', () => {
    const kept = filterAdultChannels(list, true);
    expect(kept.map((c) => c.name)).toEqual(['CCTV-1', '湖南卫视', 'Discovery']);
  });

  it('开关关闭时原样返回', () => {
    expect(filterAdultChannels(list, false)).toHaveLength(5);
  });

  it('保留调用方的扩展字段', () => {
    const kept = filterAdultChannels(list, true);
    expect(kept[0].url).toContain('CCTV-1');
  });
});

describe('关键词表约束', () => {
  it('不含会把「情」「色」单字误伤的裸词', () => {
    for (const bad of ['情', '色', '裸体艺术']) {
      expect(ADULT_LIVE_KEYWORDS, bad).not.toContain(bad);
    }
  });
});
