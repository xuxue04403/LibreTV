/**
 * M3U / M3U8 直播播放列表解析。
 *
 * 移植自 LibreTV（AGPL-3.0-or-later）src/lib/m3u-parser.ts：
 * https://github.com/LibreSpark/LibreTV
 * 改动：无（纯函数）。
 */

import type { LiveChannel } from './types';

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const ATTR_STRIP_RE = /[a-zA-Z0-9_-]+="[^"]*"/g;

function stableId(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 相对地址按订阅 URL 解析为绝对地址；仅放行 http(s) */
export function normalizeStreamUrl(raw: string, baseUrl?: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    return resolved.href;
  } catch {
    return undefined;
  }
}

/** URL 无名时的兜底名称：取路径末段，decode 后仍空则用主机名 */
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) {
      const decoded = decodeURIComponent(last).replace(/\.(m3u8?|flv|ts|mp4)$/i, '');
      if (decoded) return decoded;
    }
    return u.hostname;
  } catch {
    return '未命名频道';
  }
}

interface ExtinfContext {
  attrs: Record<string, string>;
  title: string;
  extGroup: string;
}

export function parseM3u(content: string, baseUrl?: string): LiveChannel[] {
  const channels: LiveChannel[] = [];
  if (!content) return channels;

  const seen = new Set<string>();
  let ctx: ExtinfContext | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.toUpperCase().startsWith('#EXTINF')) {
      const attrs: Record<string, string> = {};
      ATTR_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ATTR_RE.exec(line))) attrs[m[1].toLowerCase()] = m[2].trim();

      const stripped = line.replace(ATTR_STRIP_RE, '').replace(/^#EXTINF\s*:\s*/i, '');
      const commaIdx = stripped.indexOf(',');
      const title = (commaIdx >= 0 ? stripped.slice(commaIdx + 1) : stripped)
        .trim()
        .replace(/^"+|"+$/g, '');

      ctx = { attrs, title, extGroup: '' };
      continue;
    }

    if (line.toUpperCase().startsWith('#EXTGRP:')) {
      const g = line.slice('#EXTGRP:'.length).trim();
      if (ctx && g && !ctx.attrs['group-title']) ctx.extGroup = g;
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = normalizeStreamUrl(line, baseUrl);
    const cur = ctx;
    ctx = null;
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const attrs = cur?.attrs ?? {};
    const tvgId = attrs['tvg-id'] || undefined;
    const logo = attrs['tvg-logo'] ? normalizeStreamUrl(attrs['tvg-logo'], baseUrl) : undefined;
    const name = cur?.title || nameFromUrl(url);
    channels.push({
      id: tvgId || stableId(url),
      name,
      url,
      logo,
      group: attrs['group-title'] || cur?.extGroup || undefined,
      tvgId,
      rawName: attrs['tvg-name'] || undefined,
    });
  }

  return channels;
}

/** 从频道列表提取分组（去重，保持出现顺序，未分组归入「未分组」） */
export function collectGroups(channels: LiveChannel[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of channels) {
    const g = ch.group || '未分组';
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** 解析 M3U 头部 #EXTM3U 的 x-tvg-url / url-tvg 属性（EPG 地址兜底） */
export function parseM3uEpgUrl(content: string, baseUrl?: string): string | undefined {
  const firstLine = content.split(/\r?\n/, 1)[0] || '';
  if (!/^#EXTM3U/i.test(firstLine.trim())) return undefined;
  const m = /(?:x-tvg-url|url-tvg)="([^"]+)"/i.exec(firstLine);
  if (!m) return undefined;
  return normalizeStreamUrl(m[1].split(',')[0], baseUrl);
}
