/**
 * 直播换台的频道序列工具。
 *
 * 上下键换台不只是「下一个频道」：用户按分组/关键词筛过之后，换台应当
 * 在**当前可见列表**里循环，而不是跳到一个被过滤掉的频道。这部分逻辑
 * 两端一致（桌面 Live.tsx / TV LiveScreen.kt），所以抽出来单测。
 */

export interface SwitchableChannel {
  url: string;
}

/**
 * 求下一个/上一个频道的下标，循环首尾。
 *
 * @param length    可见列表长度
 * @param current   当前下标（-1 表示不在列表里）
 * @param direction 1 = 下一个，-1 = 上一个
 * @returns 目标下标；列表为空时返回 -1
 */
export function stepChannelIndex(length: number, current: number, direction: 1 | -1): number {
  if (!Number.isFinite(length) || length <= 0) return -1;
  const size = Math.floor(length);
  const dir = direction >= 0 ? 1 : -1;
  if (!Number.isFinite(current) || current < 0) return dir === 1 ? 0 : size - 1;
  const base = Math.floor(current) % size;
  return (base + dir + size) % size;
}

/** 在列表里按 url 找下标；找不到返回 -1 */
export function indexOfChannel<T extends SwitchableChannel>(list: T[], url: string | undefined): number {
  if (!url) return -1;
  return list.findIndex((c) => c.url === url);
}

/**
 * 计算「换台后应该播放哪个频道」。
 *
 * 直接返回频道对象而不是下标，调用方不必再处理越界。
 */
export function channelAt<T extends SwitchableChannel>(list: T[], index: number): T | undefined {
  if (index < 0 || index >= list.length) return undefined;
  return list[index];
}
