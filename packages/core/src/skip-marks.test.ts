import { describe, expect, it } from 'vitest';
import { findSkipTarget, normalizeSkipMarks, skipMarkKey, type SkipMarks } from './skip-marks';

const marks = (patch: Partial<SkipMarks> = {}): SkipMarks => ({ segments: [], ...patch });

describe('skipMarkKey', () => {
  it('标题去空白、转小写，年份作为后缀', () => {
    expect(skipMarkKey('  The  Last  of Us ', '2023')).toBe('thelastofus|2023');
    expect(skipMarkKey('漫长的季节')).toBe('漫长的季节');
  });

  it('数值年份同样可用', () => {
    expect(skipMarkKey('黑镜', 2011)).toBe('黑镜|2011');
  });
});

describe('findSkipTarget', () => {
  it('没有标记或未启用时返回 null', () => {
    expect(findSkipTarget(undefined, 10, 100)).toBeNull();
    expect(findSkipTarget(marks({ introEnd: 30, enabled: false }), 10, 100)).toBeNull();
  });

  it('片头区间内命中，跳到片头结束点', () => {
    expect(findSkipTarget(marks({ introEnd: 90 }), 12, 2400)).toEqual({ kind: 'intro', start: 0, end: 90 });
  });

  it('接近片头末尾不再命中，避免跳完又命中', () => {
    expect(findSkipTarget(marks({ introEnd: 90 }), 89.8, 2400)).toBeNull();
  });

  it('中段区间内命中', () => {
    const target = findSkipTarget(marks({ segments: [{ start: 600, end: 660 }] }), 610, 2400);
    expect(target).toEqual({ kind: 'mid', start: 600, end: 660 });
  });

  it('中段区间之后不再命中', () => {
    expect(findSkipTarget(marks({ segments: [{ start: 600, end: 660 }] }), 700, 2400)).toBeNull();
  });

  it('片尾区间内命中，end 为总时长', () => {
    expect(findSkipTarget(marks({ outroStart: 2300 }), 2301, 2400)).toEqual({ kind: 'outro', start: 2300, end: 2400 });
  });

  it('片尾开始前不命中', () => {
    expect(findSkipTarget(marks({ outroStart: 2300 }), 2299, 2400)).toBeNull();
  });

  it('时长为 0 时不判片尾', () => {
    expect(findSkipTarget(marks({ outroStart: 2300 }), 2301, 0)).toBeNull();
  });

  it('片头与中段重叠时优先片头', () => {
    const target = findSkipTarget(marks({ introEnd: 90, segments: [{ start: 0, end: 120 }] }), 10, 2400);
    expect(target?.kind).toBe('intro');
  });
});

describe('normalizeSkipMarks', () => {
  it('丢弃非法字段、排序中段、保留 enabled=false', () => {
    const result = normalizeSkipMarks({
      a: { introEnd: 30, outroStart: -1, segments: [{ start: 100, end: 130 }, { start: 10, end: 12 }, { start: 5, end: 5.2 }] },
      b: { enabled: false, introEnd: 8 },
      c: { segments: [] },
      d: 'nope',
      '': { introEnd: 1 },
    });
    expect(Object.keys(result).sort()).toEqual(['a', 'b']);
    expect(result.a.segments).toEqual([
      { start: 10, end: 12 },
      { start: 100, end: 130 },
    ]);
    expect(result.a.outroStart).toBeUndefined();
    expect(result.b.enabled).toBe(false);
  });

  it('非对象输入返回空表', () => {
    expect(normalizeSkipMarks(null)).toEqual({});
    expect(normalizeSkipMarks('x')).toEqual({});
  });
});
