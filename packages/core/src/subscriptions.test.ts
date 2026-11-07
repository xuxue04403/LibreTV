import { describe, expect, it } from 'vitest';
import {
  isSubscriptionDue,
  normalizeSubscriptions,
  subscriptionRefreshLabel,
  type SubscriptionEntry,
} from './subscriptions';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const entry = (patch: Partial<SubscriptionEntry> = {}): SubscriptionEntry => ({
  key: 'sub_a',
  url: 'https://example.com/list.json',
  name: '示例',
  refreshDays: 3,
  lastSyncedAt: NOW - DAY,
  failStreak: 0,
  paused: false,
  addedAt: NOW - 10 * DAY,
  ...patch,
});

describe('subscriptionRefreshLabel', () => {
  it('0 天表示关闭，其余显示周期', () => {
    expect(subscriptionRefreshLabel(0)).toBe('关闭');
    expect(subscriptionRefreshLabel(7)).toBe('每 7 天');
  });
});

describe('isSubscriptionDue', () => {
  it('关闭自动刷新、暂停、未到期都不刷新', () => {
    expect(isSubscriptionDue(entry({ refreshDays: 0 }), NOW)).toBe(false);
    expect(isSubscriptionDue(entry({ paused: true }), NOW)).toBe(false);
    expect(isSubscriptionDue(entry({ lastSyncedAt: NOW - DAY }), NOW)).toBe(false);
  });

  it('从未成功同步时视为立即到期', () => {
    expect(isSubscriptionDue(entry({ lastSyncedAt: 0 }), NOW)).toBe(true);
  });

  it('达到周期后到期', () => {
    expect(isSubscriptionDue(entry({ lastSyncedAt: NOW - 3 * DAY }), NOW)).toBe(true);
    expect(isSubscriptionDue(entry({ refreshDays: 1, lastSyncedAt: NOW - DAY - 1 }), NOW)).toBe(true);
  });
});

describe('normalizeSubscriptions', () => {
  it('丢弃非法条目、去重、补齐名称与范围', () => {
    const list = normalizeSubscriptions([
      { url: 'https://a.com/x', name: '', refreshDays: 999, failStreak: -1 },
      { url: 'https://a.com/x', name: '重复' },
      { url: 'not-a-url' },
      null,
      { url: 'https://b.com/y', refreshDays: 2.6, paused: true, lastSyncedAt: NOW },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0].url).toBe('https://a.com/x');
    expect(list[0].name).toBe('a.com');
    expect(list[0].refreshDays).toBe(365);
    expect(list[0].failStreak).toBe(0);
    expect(list[1].refreshDays).toBe(3);
    expect(list[1].paused).toBe(true);
  });

  it('非数组返回空表', () => {
    expect(normalizeSubscriptions(null)).toEqual([]);
    expect(normalizeSubscriptions({})).toEqual([]);
  });
});
