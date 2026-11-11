/**
 * URL 小工具。
 *
 * ArkTS 没有浏览器里的全局 URL，只能用 @kit.ArkTS 的 url.URL；
 * 这里把常用的「取 origin」包一层，避免每个调用点都 try/catch。
 */
import { url as ArkUrl } from '@kit.ArkTS';

/** 取协议 + 主机 + 端口，例：https://api.ffzyapi.com/api.php → https://api.ffzyapi.com */
export function originOf(raw: string): string {
  try {
    return new ArkUrl.URL(raw).origin;
  } catch (err) {
    return '';
  }
}

/** 解析相对地址到 baseUrl 上，失败返回空串 */
export function resolveUrl(raw: string, baseUrl: string): string {
  try {
    return new ArkUrl.URL(raw, baseUrl).toString();
  } catch (err) {
    return '';
  }
}
