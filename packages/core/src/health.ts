/**
 * 源健康度：连续失败自动暂停，避免每次搜索都先等一个已经死掉的源。
 *
 * 规则（与上游 LibreTV 的 sourceHealth 对齐）：
 * - 连续失败 2 次进入暂停；暂停时长逐级加长：30 分钟 → 24 小时 → 永久；
 * - 暂停到期后第一次再失败，失败计数从 1 重新累计（不会一次失败就再次长期停用）；
 * - 成功一次把停用等级降一级，但不一次性清零：刚恢复的源再挂一次，
 *   应该按上一级时长继续停，而不是又从头给 30 分钟；
 * - 暂停只影响「搜索时是否发起请求」，不改用户勾选 —— 勾选是用户的意图，
 *   暂停只是临时事实，恢复后不该要求用户重新去设置里打勾。
 *
 * 数据只放在桌面端本地，7 天没有参与搜索的普通条目会被清理（永久停用的保留，
 * 直到用户手动恢复）。
 */

/** 连续失败达到这个次数就暂停 */
export const SOURCE_HEALTH_FAIL_THRESHOLD = 2;

/** 第 1、2 次暂停的时长；第 3 次起永久，需手动恢复 */
export const SOURCE_HEALTH_LADDER_MS = [30 * 60 * 1000, 24 * 60 * 60 * 1000] as const;

/** 7 天没参与过搜索的普通条目清理 */
export const SOURCE_HEALTH_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** 永久停用用最大安全整数表示（JSON 里不能存 Infinity） */
export const SOURCE_HEALTH_PERMANENT = Number.MAX_SAFE_INTEGER;

export interface SourceHealthEntry {
  /** 连续失败次数（成功或已暂停时归零） */
  failStreak: number;
  /** 已累计的停用等级：1=30 分钟，2=24 小时，3=永久 */
  disableCount: number;
  /** 暂停到什么时候；0 表示正常。永久的值为 SOURCE_HEALTH_PERMANENT */
  disabledUntil: number;
  /** 最后一次状态变化时间，用于清理长期不参与搜索的条目 */
  updatedAt: number;
}

export type SourceHealthMap = Record<string, SourceHealthEntry>;

export interface SourceDisableEvent {
  key: string;
  /** 本次停用后的等级（1..3） */
  level: number;
  permanent: boolean;
  ttlMs: number;
}

export function emptySourceHealth(now: number): SourceHealthEntry {
  return { failStreak: 0, disableCount: 0, disabledUntil: 0, updatedAt: now };
}

export function isSourceDisabled(entry: SourceHealthEntry | undefined, now: number): boolean {
  return Boolean(entry && entry.disabledUntil > now);
}

/**
 * 记一次失败。返回新条目，以及「本次失败导致暂停」时的事件（供 UI 提示）。
 *
 * 已经处于暂停期的源不应再被请求；万一被请求并失败，不重复累计，
 * 否则一个死源会因为并发补搜被瞬间推到永久停用。
 */
export function recordSourceFailure(
  current: SourceHealthEntry | undefined,
  now: number
): { entry: SourceHealthEntry; event: SourceDisableEvent | null } {
  if (current && current.disabledUntil > now) {
    return { entry: current, event: null };
  }

  // 暂停到期后的第一次失败：新窗口从 0 开始，下面 +1 即为 1。
  // disableCount 保留，成功降级逻辑才有「上一级」可降。
  const base: SourceHealthEntry =
    current && current.disabledUntil !== 0
      ? { ...current, failStreak: 0, disabledUntil: 0 }
      : current ?? emptySourceHealth(now);

  const failStreak = base.failStreak + 1;
  if (failStreak < SOURCE_HEALTH_FAIL_THRESHOLD) {
    return { entry: { ...base, failStreak, updatedAt: now }, event: null };
  }

  const level = Math.min(base.disableCount + 1, SOURCE_HEALTH_LADDER_MS.length + 1);
  const permanent = level > SOURCE_HEALTH_LADDER_MS.length;
  const ttlMs = permanent ? SOURCE_HEALTH_PERMANENT : SOURCE_HEALTH_LADDER_MS[level - 1];
  return {
    entry: {
      failStreak: 0,
      disableCount: level,
      disabledUntil: permanent ? SOURCE_HEALTH_PERMANENT : now + ttlMs,
      updatedAt: now,
    },
    event: { key: '', level, permanent, ttlMs },
  };
}

/** 成功一次：等级降一级、清暂停与连续失败计数 */
export function recordSourceSuccess(current: SourceHealthEntry | undefined, now: number): SourceHealthEntry {
  return {
    failStreak: 0,
    disableCount: Math.max(0, (current?.disableCount ?? 0) - 1),
    disabledUntil: 0,
    updatedAt: now,
  };
}

/** 用户手动恢复：直接删掉健康记录，回到全新状态 */
export function clearSourceHealth(map: SourceHealthMap, key: string): SourceHealthMap {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** 清理 7 天没参与搜索的普通条目；仍在暂停期或永久停用的保留 */
export function pruneSourceHealth(map: SourceHealthMap, now: number): SourceHealthMap {
  let changed = false;
  const next: SourceHealthMap = {};
  for (const [key, entry] of Object.entries(map)) {
    const permanent = entry.disabledUntil === SOURCE_HEALTH_PERMANENT;
    // 暂停中的条目 updatedAt 停在「暂停那一刻」，不能只看 age：
    // 24 小时档第二天再看就被清掉的话，暂停会凭空失效。
    if (!permanent && !isSourceDisabled(entry, now) && now - entry.updatedAt > SOURCE_HEALTH_STALE_MS) {
      changed = true;
      continue;
    }
    next[key] = entry;
  }
  return changed ? next : map;
}

/** 暂停时长的中文描述（用于 toast / 列表提示） */
export function describeSourceDisable(level: number): string {
  if (level >= 3) return '已永久暂停';
  if (level === 2) return '暂停 24 小时';
  return '暂停 30 分钟';
}

/** 剩余暂停时间的简短描述（用于源列表徽章） */
export function describeDisabledRemaining(entry: SourceHealthEntry | undefined, now: number): string {
  if (!entry || entry.disabledUntil <= now) return '';
  if (entry.disabledUntil === SOURCE_HEALTH_PERMANENT) return '已暂停';
  const minutes = Math.ceil((entry.disabledUntil - now) / 60000);
  return minutes >= 60 ? `剩 ${Math.ceil(minutes / 60)} 小时` : `剩 ${minutes} 分钟`;
}
