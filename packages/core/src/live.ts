/**
 * 直播 / IPTV（客户端版）。
 *
 * 对应上游 src/app/api/live/playlist、/api/live/epg 与 src/lib/xmltv.ts。
 * 全部改为客户端拉取：M3U 解析 → 频道/分组；XMLTV 解析 → 当前/下一档节目。
 * gzip 由 http 层的 maybeGunzip 处理，不依赖 Node zlib。
 */

import { maybeGunzip, type HttpClient } from './http';
import { collectGroups, parseM3u, parseM3uEpgUrl } from './m3u';
import type { EpgProgram, LiveChannel, LiveEpg, LivePlaylist } from './types';

export interface LiveOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 拉取并解析 M3U 订阅 */
export async function fetchLivePlaylist(
  url: string,
  http: HttpClient,
  opts: LiveOptions = {}
): Promise<LivePlaylist & { epgUrl?: string }> {
  const res = await http.request(url, {
    headers: { Accept: 'application/x-mpegURL, application/vnd.apple.mpegurl, text/plain, */*' },
    timeoutMs: opts.timeoutMs ?? 15_000,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`直播源拉取失败（HTTP ${res.status}）`);
  const channels = parseM3u(res.text, url);
  if (channels.length === 0) throw new Error('未解析到可用频道（可能是 txt 格式或不支持的列表）');
  return {
    name: readPlaylistName(res.text),
    channels,
    groups: collectGroups(channels),
    epgUrl: parseM3uEpgUrl(res.text, url),
  };
}

/** #EXTM3U 之后的 `#PLAYLIST:名称` 或首行注释里取订阅名 */
function readPlaylistName(content: string): string | undefined {
  const m = /^#PLAYLIST:(.+)$/m.exec(content);
  return m ? m[1].trim() : undefined;
}

/** 频道列表过滤：按分组 + 关键词（名称/原始台名）；保留调用方的扩展字段 */
export function filterChannels<T extends LiveChannel>(
  channels: T[],
  opts: { group?: string; keyword?: string }
): T[] {
  const kw = (opts.keyword || '').trim().toLowerCase();
  return channels.filter((ch) => {
    if (opts.group && (ch.group || '未分组') !== opts.group) return false;
    if (!kw) return true;
    return (
      ch.name.toLowerCase().includes(kw) ||
      (ch.rawName || '').toLowerCase().includes(kw) ||
      (ch.group || '').toLowerCase().includes(kw)
    );
  });
}

// —— XMLTV ——

const PROGRAMME_RE = /<programme\s+([^>]*?)\/>|<programme\s+([^>]*?)>([\s\S]*?)<\/programme>/g;
const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i;
const DESC_RE = /<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/i;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function decodeXmlText(raw: string): string {
  let text = raw.trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) text = cdata[1];
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 解析 `YYYYMMDDHHmmss(.fff)?( +hhmm | Z)?` 为 epoch ms；无法解析返回 NaN */
export function parseXmltvTime(raw: string): number {
  const m = raw
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.(\d{1,3}))?(?:\s*([+-])(\d{2})(\d{2})|Z)?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, frac, sign, tzh, tzm] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0), frac ? +frac.padEnd(3, '0') : 0);
  if (!sign) return utcMs;
  const offsetMin = +tzh * 60 + +tzm;
  const offsetMs = offsetMin * 60 * 1000 * (sign === '-' ? -1 : 1);
  return utcMs - offsetMs;
}

function extractAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrText))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

/** 解析 XMLTV：只保留 [now, now+windowMs] 窗口内的节目，按频道分组并按开播时间排序 */
export function parseXmltv(text: string, windowMs = DEFAULT_WINDOW_MS, now = Date.now()): Map<string, EpgProgram[]> {
  const result = new Map<string, EpgProgram[]>();
  const windowEnd = now + windowMs;
  PROGRAMME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROGRAMME_RE.exec(text))) {
    const attrText = m[1] ?? m[2] ?? '';
    const inner = m[3] ?? '';
    const attrs = extractAttrs(attrText);
    const channelId = attrs['channel']?.trim();
    if (!channelId) continue;
    const start = parseXmltvTime(attrs['start'] || '');
    const stop = parseXmltvTime(attrs['stop'] || '');
    if (!Number.isFinite(start) || !Number.isFinite(stop)) continue;
    if (stop <= now || start >= windowEnd) continue;
    const titleMatch = inner.match(TITLE_RE);
    const descMatch = inner.match(DESC_RE);
    const title = titleMatch ? decodeXmlText(titleMatch[1]) : '';
    if (!title) continue;
    const program: EpgProgram = { channelId, start, stop, title };
    if (descMatch) program.desc = decodeXmlText(descMatch[1]);
    const list = result.get(channelId);
    if (list) list.push(program);
    else result.set(channelId, [program]);
  }
  for (const list of result.values()) list.sort((a, b) => a.start - b.start);
  return result;
}

/** 取某频道当前正在播出的节目与下一个节目 */
export function currentAndNext(
  programs: EpgProgram[],
  at = Date.now()
): { current?: EpgProgram; next?: EpgProgram } {
  let current: EpgProgram | undefined;
  let next: EpgProgram | undefined;
  for (const p of programs) {
    if (p.start <= at && p.stop > at) {
      current = p;
      continue;
    }
    if (p.start > at) {
      next = p;
      break;
    }
  }
  return { current, next };
}

/** 拉取并解析 XMLTV 节目单（自动解 gzip） */
export async function fetchEpg(
  epgUrl: string,
  channelId: string,
  http: HttpClient,
  opts: LiveOptions = {}
): Promise<LiveEpg> {
  const res = await http.request(epgUrl, {
    headers: { Accept: 'application/xml, text/xml, application/gzip, */*' },
    timeoutMs: opts.timeoutMs ?? 20_000,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`节目单拉取失败（HTTP ${res.status}）`);
  const bytes = await maybeGunzip(res.bytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  const byChannel = parseXmltv(text);
  const programs = byChannel.get(channelId) ?? [];
  const { current, next } = currentAndNext(programs);
  return { channelId, current, next, programs };
}
