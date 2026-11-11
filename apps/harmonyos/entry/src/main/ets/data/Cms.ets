/**
 * 苹果 CMS 采集接口的解析。
 *
 * 移植自 packages/core/src/cms.ts（纯函数，无平台依赖）。
 * 关键行为保持一致：
 * - 搜索响应 `list: null` 视为空结果，而不是格式错误；
 * - 分集地址优先取含 .m3u8 的那条线路（量子/非凡的第一条线路常是网页中转页，不能播）；
 * - 详情接口拿不到分集时，再从简介文本里兜底抓 m3u8。
 */
import { UserFacingError } from './Errors';
import { SearchItem, VodDetail } from '../model/Types';

/** 采集接口的一条记录（字段名沿用苹果 CMS 的 vod_* 命名） */
export interface CmsVod {
  vod_id?: number | string;
  vod_name?: string;
  vod_pic?: string;
  type_name?: string;
  vod_year?: string;
  vod_area?: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_content?: string;
  vod_actor?: string;
}

export interface CmsListResponse {
  list?: CmsVod[] | null;
  pagecount?: number;
  total?: number;
}

/** 搜索响应 → 统一结果列表 */
export function parseSearchList(data: CmsListResponse, sourceKey: string, sourceName: string,
  sourceUrl: string, sourceIsAdult: boolean = false): SearchItem[] {
  const list = data.list;
  if (list !== null && list !== undefined && !Array.isArray(list)) {
    throw new UserFacingError('API返回的数据格式无效');
  }
  const out: SearchItem[] = [];
  if (!list) {
    return out;
  }
  for (let i = 0; i < list.length; i++) {
    const vod = list[i];
    out.push({
      sourceKey: sourceKey,
      sourceName: sourceName,
      vodId: vod.vod_id === undefined || vod.vod_id === null ? '' : `${vod.vod_id}`,
      name: vod.vod_name ?? '',
      pic: trimOrUndefined(vod.vod_pic),
      typeName: trimOrUndefined(vod.type_name),
      year: trimOrUndefined(vod.vod_year),
      area: trimOrUndefined(vod.vod_area),
      remarks: trimOrUndefined(vod.vod_remarks),
      sourceUrl: sourceUrl,
      isAdult: sourceIsAdult,
    });
  }
  return out;
}

/**
 * 从 vod_play_url 提取分集地址：格式 源1$$$源2，集1$URL1#集2$URL2。
 * 优先取包含 m3u8 直链的线路；均无 m3u8 时回退第一条。
 */
export function extractEpisodesFromPlayUrl(playUrl: string): string[] {
  if (!playUrl) {
    return [];
  }
  const groups = playUrl.split('$$$');
  const cleaned: string[][] = [];
  for (let g = 0; g < groups.length; g++) {
    const parts = groups[g].split('#');
    const eps: string[] = [];
    for (let p = 0; p < parts.length; p++) {
      const seg = parts[p].split('$');
      if (seg.length > 1) {
        const url = seg[1];
        if (url.startsWith('http://') || url.startsWith('https://')) {
          eps.push(url);
        }
      }
    }
    if (eps.length > 0) {
      cleaned.push(eps);
    }
  }
  if (cleaned.length === 0) {
    return [];
  }
  for (let i = 0; i < cleaned.length; i++) {
    const eps = cleaned[i];
    for (let j = 0; j < eps.length; j++) {
      if (eps[j].indexOf('.m3u8') >= 0) {
        return eps;
      }
    }
  }
  return cleaned[0];
}

/** 从简介文本中兜底提取 m3u8 链接 */
export function extractM3u8FromText(text: string): string[] {
  if (!text) {
    return [];
  }
  const out: string[] = [];
  const re = /\$https?:\/\/[^"'\s]+?\.m3u8/g;
  const matches = text.match(re);
  if (!matches) {
    return out;
  }
  for (let i = 0; i < matches.length; i++) {
    out.push(matches[i].replace(/^\$/, ''));
  }
  return out;
}

/** 详情响应 → 统一详情 */
export function parseDetail(data: CmsListResponse): VodDetail {
  const list = data.list;
  if (!list || list.length === 0) {
    throw new UserFacingError('获取到的详情内容无效');
  }
  const vod = list[0];
  let episodes = extractEpisodesFromPlayUrl(vod.vod_play_url ?? '');
  if (episodes.length === 0) {
    episodes = extractM3u8FromText(vod.vod_content ?? '');
  }
  return {
    episodes: episodes,
    title: trimOrUndefined(vod.vod_name),
    cover: trimOrUndefined(vod.vod_pic),
    desc: trimOrUndefined(vod.vod_content),
    typeName: trimOrUndefined(vod.type_name),
    year: trimOrUndefined(vod.vod_year),
    area: trimOrUndefined(vod.vod_area),
    actor: trimOrUndefined(vod.vod_actor),
    remarks: trimOrUndefined(vod.vod_remarks),
  };
}

/** 详情页 HTML → 统一详情（部分源的接口不返回播放地址） */
export function parseDetailPageHtml(html: string): VodDetail {
  let matches = html.match(/\$(https?:\/\/[^"'\s]+?\.m3u8)/g);
  if (!matches) {
    matches = html.match(/\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g);
  }
  const episodes: string[] = [];
  const seen = new Set<string>();
  if (matches) {
    for (let i = 0; i < matches.length; i++) {
      let u = matches[i].substring(1);
      const paren = u.indexOf('(');
      if (paren > 0) {
        u = u.substring(0, paren);
      }
      if (!seen.has(u)) {
        seen.add(u);
        episodes.push(u);
      }
    }
  }
  let title: string | undefined = undefined;
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }
  let desc: string | undefined = undefined;
  const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);
  if (descMatch) {
    desc = descMatch[1].replace(/<[^>]+>/g, ' ').trim();
  }
  return { episodes: episodes, title: title, desc: desc };
}

function trimOrUndefined(v: string | undefined): string | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  const s = `${v}`.trim();
  return s.length === 0 ? undefined : s;
}
