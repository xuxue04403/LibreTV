/**
 * 统一的用户可见错误。
 *
 * 与 Android 端的 UserFacingError 对应：message 直接展示给用户，
 * 不需要再套一层「加载失败：」前缀。
 */
export class UserFacingError extends Error {
  status: number;

  constructor(message: string, status: number = 0) {
    super(message);
    this.name = 'UserFacingError';
    this.status = status;
  }
}

/** 把任意异常转成一句能给用户看的话 */
export function describeError(err: Object | null | undefined): string {
  if (err === null || err === undefined) {
    return '未知错误';
  }
  if (err instanceof Error) {
    const msg = err.message;
    return msg && msg.length > 0 ? msg : '未知错误';
  }
  return `${err}`;
}
