/** 格式化工具，移植自 LibreTV src/lib/utils.ts（AGPL-3.0-or-later）。 */

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`;
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 地址合法性校验：仅 http(s) */
export function isValidSourceUrl(url: string): boolean {
  return /^https?:\/\/.+/.test(url);
}

/** 取 hostname 作为名称兜底；地址非法时原样返回 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 由 URL 生成稳定短 key（djb2 变体，与上游 store.subKeyPrefix 同风格） */
export function stableKey(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 清理地址末尾斜杠 */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 剧集标题：数字集用「第 N 集」，其余原样 */
export function episodeLabel(url: string, index: number): string {
  const m = /(?:^|\/)(?:第)?(\d+)(?:集)?(?:\.m3u8|\.mp4)?(?:\?|$)/.exec(url);
  if (m && Number(m[1]) > 0) return `第 ${Number(m[1])} 集`;
  return `第 ${index + 1} 集`;
}
