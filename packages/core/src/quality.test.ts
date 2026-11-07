import { describe, expect, it } from 'vitest';
import {
  QUALITY_FAIL_TTL_MS,
  QUALITY_MAX_ENTRIES,
  QUALITY_TTL_MS,
  describeQualityBadge,
  failureReasonLabel,
  inferHeightFromBitrate,
  isQualityEntryFresh,
  isRetryableTimeout,
  mergeQualityEntries,
  qualityKey,
  qualityLabel,
} from './quality';
import type { QualityEntry } from './types';

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

function entry(over: Partial<QualityEntry> = {}): QualityEntry {
  return { sourceKey: 's', vodId: '1', from: 'probe', timestamp: NOW, ...over };
}

describe('qualityLabel', () => {
  it('就近取档', () => {
    expect(qualityLabel(2160)).toBe('4K');
    expect(qualityLabel(1440)).toBe('2K');
    expect(qualityLabel(1080)).toBe('1080P');
    expect(qualityLabel(720)).toBe('720P');
    expect(qualityLabel(540)).toBe('540P');
    expect(qualityLabel(360)).toBe('360P');
  });

  it('裁边/等比缩放仍算同一档（1924x1040、1920x960）', () => {
    expect(qualityLabel(1040)).toBe('1080P');
    expect(qualityLabel(960)).toBe('1080P');
    expect(qualityLabel(716)).toBe('720P');
  });

  it('偏差过大按原样展示，不硬抬档', () => {
    expect(qualityLabel(144)).toBe('144P');
    expect(qualityLabel(240)).toBe('240P');
    expect(qualityLabel(300)).toBe('300P');
  });

  it('无值返回 undefined', () => {
    expect(qualityLabel(0)).toBeUndefined();
    expect(qualityLabel(undefined)).toBeUndefined();
    expect(qualityLabel(-1)).toBeUndefined();
  });
});

describe('failureReasonLabel', () => {
  it('传输层失败优先于超时归因', () => {
    expect(failureReasonLabel('连接中断（多为网关超时）')).toBe('连接中断');
    expect(failureReasonLabel('请求超时')).toBe('超时');
    expect(failureReasonLabel('HTTP 403')).toBe('防盗链');
    expect(failureReasonLabel('HTTP 502')).toBe('网关异常');
    expect(failureReasonLabel('未找到播放资源')).toBe('无资源');
    expect(failureReasonLabel('无效的源或影片 ID')).toBe('源无效');
    expect(failureReasonLabel('其他错误')).toBeUndefined();
  });

  it('只有超时值得自动重试', () => {
    expect(isRetryableTimeout('请求超时')).toBe(true);
    expect(isRetryableTimeout('HTTP 500')).toBe(false);
    expect(isRetryableTimeout(undefined)).toBe(false);
  });
});

describe('isQualityEntryFresh / qualityKey', () => {
  it('成功 30 天、失败 2 分钟', () => {
    expect(isQualityEntryFresh(entry({ timestamp: NOW - QUALITY_TTL_MS + 1000 }), NOW)).toBe(true);
    expect(isQualityEntryFresh(entry({ timestamp: NOW - QUALITY_TTL_MS - 1000 }), NOW)).toBe(false);
    expect(isQualityEntryFresh(entry({ error: '请求超时', timestamp: NOW - 1000 }), NOW)).toBe(true);
    expect(isQualityEntryFresh(entry({ error: '请求超时', timestamp: NOW - QUALITY_FAIL_TTL_MS - 1 }), NOW)).toBe(false);
  });

  it('键按源 + 影片', () => {
    expect(qualityKey('a', '42')).toBe('a:42');
  });
});

describe('mergeQualityEntries', () => {
  it('play 压 probe，play 之间取较大值', () => {
    const key = qualityKey('s', '1');
    const current = { [key]: entry({ from: 'probe', height: 720 }) };
    const incoming = {
      [key]: entry({ from: 'play', height: 1080 }),
      [qualityKey('s', '2')]: entry({ from: 'play', height: 720 }),
    };
    const merged = mergeQualityEntries(current, incoming, NOW);
    expect(merged[key].height).toBe(1080);
    expect(merged[key].from).toBe('play');
    expect(merged[qualityKey('s', '2')].height).toBe(720);

    const lower = mergeQualityEntries(merged, { [key]: entry({ from: 'play', height: 480 }) }, NOW);
    expect(lower[key].height).toBe(1080);
  });

  it('probe 的「测不出」不抹掉已知档位', () => {
    const key = qualityKey('s', '1');
    const merged = mergeQualityEntries(
      { [key]: entry({ from: 'probe', height: 1080 }) },
      { [key]: entry({ from: 'probe', height: undefined }) },
      NOW
    );
    expect(merged[key].height).toBe(1080);
  });

  it('过期条目在合并时清理', () => {
    const stale = qualityKey('s', 'old');
    const merged = mergeQualityEntries(
      { [stale]: entry({ height: 720, timestamp: NOW - QUALITY_TTL_MS - 1 }) },
      {},
      NOW
    );
    expect(merged[stale]).toBeUndefined();
  });

  it('超过上限按时间淘汰最旧', () => {
    const current: Record<string, QualityEntry> = {};
    for (let i = 0; i < QUALITY_MAX_ENTRIES + 5; i++) {
      current[`s:${i}`] = entry({ vodId: String(i), timestamp: NOW - i * 1000 });
    }
    const merged = mergeQualityEntries(current, {}, NOW);
    expect(Object.keys(merged)).toHaveLength(QUALITY_MAX_ENTRIES);
    expect(merged['s:0']).toBeDefined();
    expect(merged[`s:${QUALITY_MAX_ENTRIES + 4}`]).toBeUndefined();
  });
});

describe('describeQualityBadge', () => {
  it('四态与可重试语义', () => {
    expect(describeQualityBadge(undefined)).toBeUndefined();
    expect(describeQualityBadge(undefined, true)?.kind).toBe('loading');
    expect(describeQualityBadge(entry({ height: 1080 }))?.label).toBe('1080P');
    expect(describeQualityBadge(entry({}))?.kind).toBe('unknown');
    const failed = describeQualityBadge(entry({ error: '请求超时' }));
    expect(failed?.kind).toBe('failed');
    expect(failed?.reason).toBe('超时');
    expect(failed?.retryable).toBe(true);
  });
});

describe('inferHeightFromBitrate', () => {
  it('按常见转码档位反推', () => {
    expect(inferHeightFromBitrate(12_000_000)).toBe(2160);
    expect(inferHeightFromBitrate(6_000_000)).toBe(1080);
    expect(inferHeightFromBitrate(3_500_000)).toBe(720);
    expect(inferHeightFromBitrate(2_000_000)).toBe(540);
    expect(inferHeightFromBitrate(100_000)).toBe(240);
  });
});
