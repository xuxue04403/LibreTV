import { describe, expect, it } from 'vitest';
import { channelAt, indexOfChannel, stepChannelIndex } from './live-switch';

describe('stepChannelIndex', () => {
  it('正常前进/后退', () => {
    expect(stepChannelIndex(5, 0, 1)).toBe(1);
    expect(stepChannelIndex(5, 3, -1)).toBe(2);
  });

  it('首尾循环', () => {
    expect(stepChannelIndex(5, 4, 1)).toBe(0);
    expect(stepChannelIndex(5, 0, -1)).toBe(4);
  });

  it('只有一个频道时原地循环', () => {
    expect(stepChannelIndex(1, 0, 1)).toBe(0);
    expect(stepChannelIndex(1, 0, -1)).toBe(0);
  });

  it('当前不在列表里时从头/尾进入', () => {
    expect(stepChannelIndex(5, -1, 1)).toBe(0);
    expect(stepChannelIndex(5, -1, -1)).toBe(4);
  });

  it('下标越界时先取模再步进（换台不因脏数据崩）', () => {
    // 99 % 5 = 4，再 +1 回绕到 0
    expect(stepChannelIndex(5, 99, 1)).toBe(0);
    expect(stepChannelIndex(5, -99, -1)).toBe(4);
  });

  it('空列表返回 -1', () => {
    expect(stepChannelIndex(0, 0, 1)).toBe(-1);
    expect(stepChannelIndex(0, 0, -1)).toBe(-1);
    expect(stepChannelIndex(Number.NaN, 0, 1)).toBe(-1);
  });
});

describe('indexOfChannel / channelAt', () => {
  const list = [{ url: 'a' }, { url: 'b' }, { url: 'c' }];

  it('按 url 定位', () => {
    expect(indexOfChannel(list, 'b')).toBe(1);
    expect(indexOfChannel(list, 'zzz')).toBe(-1);
    expect(indexOfChannel(list, undefined)).toBe(-1);
  });

  it('越界取值为 undefined 而不是崩', () => {
    expect(channelAt(list, 2)?.url).toBe('c');
    expect(channelAt(list, 3)).toBeUndefined();
    expect(channelAt(list, -1)).toBeUndefined();
  });

  it('完整换台流程：定位 → 步进 → 取值', () => {
    const current = indexOfChannel(list, 'c');
    const next = channelAt(list, stepChannelIndex(list.length, current, 1));
    expect(next?.url).toBe('a');
  });
});
