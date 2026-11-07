/**
 * 跳过标记：片头结束点、片尾开始点、中段区间。
 *
 * 标记按「剧名 + 年份」聚合，而不是按某一集的地址，所以同一部剧换集、
 * 换同名片源都能复用；存储与合并规则放在渲染层（zustand persist），
 * 这里只做纯函数，方便单测与 TV 端复用。
 */

export interface SkipSegment {
  /** 起点（秒） */
  start: number;
  /** 终点（秒），播放到这里自动跳过 */
  end: number;
}

export interface SkipMarks {
  /** 片头结束秒：0 秒起播到该点之间自动跳过 */
  introEnd?: number;
  /** 片尾开始秒：到该点之后自动跳过（并交给连播逻辑） */
  outroStart?: number;
  /** 中段区间（如广告/回顾） */
  segments: SkipSegment[];
  /** 这部剧是否启用自动跳过；缺省视为启用 */
  enabled?: boolean;
}

export type SkipMarkMap = Record<string, SkipMarks>;

/** 判定命中后返回要跳到的时间点；`kind === 'outro'` 时 end 为 duration */
export type SkipTarget =
  | { kind: 'intro'; start: number; end: number }
  | { kind: 'mid'; start: number; end: number }
  | { kind: 'outro'; start: number; end: number };

/** 边界容差：太贴近片段末尾就不再跳，避免跳完立刻又命中 */
const EDGE_TOLERANCE = 0.5;

/** 归一化标题，仅用于聚合键（与展示、搜索无关） */
export function skipMarkKey(title: string, year?: string | number): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, '');
  const y = typeof year === 'number' ? String(year) : (year ?? '').trim();
  return y ? `${normalized}|${y}` : normalized;
}

function readSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** 清洗持久化数据：非法/越界字段丢弃，坏条目整条跳过 */
export function normalizeSkipMarks(raw: unknown): SkipMarkMap {
  if (!raw || typeof raw !== 'object') return {};
  const result: SkipMarkMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object') continue;
    const obj = value as Partial<SkipMarks> & { segments?: unknown };
    const marks: SkipMarks = { segments: [] };
    const introEnd = readSeconds(obj.introEnd);
    const outroStart = readSeconds(obj.outroStart);
    if (introEnd !== undefined) marks.introEnd = introEnd;
    if (outroStart !== undefined) marks.outroStart = outroStart;
    if (obj.enabled === false) marks.enabled = false;
    if (Array.isArray(obj.segments)) {
      for (const seg of obj.segments) {
        if (!seg || typeof seg !== 'object') continue;
        const start = readSeconds((seg as SkipSegment).start);
        const end = readSeconds((seg as SkipSegment).end);
        if (start === undefined || end === undefined || end - start < 1) continue;
        marks.segments.push({ start, end });
      }
      marks.segments.sort((a, b) => a.start - b.start);
    }
    const hasAny = marks.introEnd !== undefined || marks.outroStart !== undefined || marks.segments.length > 0;
    if (hasAny) result[key] = marks;
  }
  return result;
}

/**
 * 当前播放时间命中的跳过目标。
 *
 * - 片头：`[0, introEnd)` 内命中，跳到 introEnd；
 * - 片尾：`[outroStart, duration)` 内命中，跳到 duration（由调用方决定是否连播）；
 * - 中段：`[start, end)` 内命中，跳到 end；
 * 同时命中时按「片头 → 中段 → 片尾」优先级，只返回一个。
 */
export function findSkipTarget(
  marks: SkipMarks | undefined,
  time: number,
  duration: number,
): SkipTarget | null {
  if (!marks || marks.enabled === false) return null;
  if (!Number.isFinite(time) || time < 0) return null;

  const introEnd = marks.introEnd;
  if (introEnd !== undefined && introEnd > EDGE_TOLERANCE && time < introEnd - EDGE_TOLERANCE) {
    return { kind: 'intro', start: 0, end: introEnd };
  }

  for (const seg of marks.segments) {
    if (time >= seg.start && time < seg.end - EDGE_TOLERANCE) {
      return { kind: 'mid', start: seg.start, end: seg.end };
    }
  }

  const outroStart = marks.outroStart;
  if (outroStart !== undefined && duration > 0 && outroStart < duration - EDGE_TOLERANCE && time >= outroStart) {
    return { kind: 'outro', start: outroStart, end: duration };
  }

  return null;
}
