/**
 * 视频详情抓取（客户端版）。
 *
 * 对应上游 src/app/api/detail/route.ts：
 * 1) 优先走 Apple CMS 列表接口 `?ac=videolist&ids=`；
 * 2) 拿不到播放地址时，降级爬详情页 HTML 提取 m3u8。
 */

import { cmsRequestHeaders, parseDetail, parseDetailPageHtml } from './cms';
import { HttpError, type HttpClient } from './http';
import type { SourceConfig, VideoDetail } from './types';

export interface DetailOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 详情页根地址（优先于 source.detail） */
  baseUrl?: string;
}

/** Apple CMS 的 vod_id 只允许字母数字下划线短横线 */
export function isValidVodId(id: string): boolean {
  return /^[\w-]+$/.test(id);
}

export async function fetchDetail(
  source: SourceConfig,
  id: string,
  http: HttpClient,
  opts: DetailOptions = {}
): Promise<VideoDetail> {
  if (!isValidVodId(id)) throw new HttpError('无效的视频ID', 400);
  if (!/^https?:\/\//i.test(source.url || '')) throw new HttpError('无效的点播源配置', 400);

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const base = source.url.replace(/\/+$/, '');
  const api = `${base}?ac=videolist&ids=${encodeURIComponent(id)}`;

  // 详情页根地址：显式 detail 优先，其次 baseUrl 参数，最后用接口地址的 origin 推导
  let detailRoot: string;
  try {
    detailRoot = (source.detail || opts.baseUrl || new URL(source.url).origin).replace(/\/+$/, '');
  } catch {
    detailRoot = '';
  }

  let resolved: VideoDetail | null = null;
  try {
    const res = await http.request(api, {
      headers: cmsRequestHeaders(),
      timeoutMs,
      signal: opts.signal,
    });
    if (res.ok) {
      try {
        const detail = parseDetail(JSON.parse(res.text), source);
        if (detail.episodes.length > 0) resolved = detail;
      } catch {
        /* 列表接口无内容 → 继续尝试详情页 */
      }
    }
  } catch {
    /* 网络失败也继续尝试详情页 */
  }

  if (!resolved && /^https?:\/\//i.test(detailRoot)) {
    const detailUrl = `${detailRoot}/index.php/vod/detail/id/${id}.html`;
    try {
      const res = await http.request(detailUrl, {
        headers: { 'User-Agent': cmsRequestHeaders()['User-Agent'] },
        timeoutMs,
        signal: opts.signal,
      });
      if (res.ok) resolved = parseDetailPageHtml(res.text, source);
    } catch {
      /* 详情页失败则走下面的统一报错 */
    }
  }

  if (!resolved || resolved.episodes.length === 0) throw new HttpError('未找到播放资源', 404);
  return resolved;
}
