import defaultsRaw from '@defaults';
import type { LiveSourceConfig, SourceConfig } from '@libretv/core';

interface DefaultsFile {
  name: string;
  version?: number;
  sources: { name: string; url: string; detail?: string; isAdult?: boolean }[];
  liveSources: { name: string; url: string; epg?: string; selected?: boolean; note?: string }[];
}

const data = defaultsRaw as unknown as DefaultsFile;

/**
 * 内置源清单的版本号（`defaults/sources.json` 的 `version`）。
 *
 * 加新内置源时必须同时把这个数字加一，否则老用户的存储里已经
 * `defaultsSeeded: true`，新源永远补不进来。
 */
export const DEFAULTS_VERSION = Number(data.version ?? 0);

/**
 * 内置默认源：与 Android TV 端 assets 里的 default-sources.json 是同一份文件
 * （仓库 defaults/sources.json），避免两端各维护一份。
 *
 * `key` 由下标生成，所以**只能在末尾追加**新源：插在中间会让老用户已保存的
 * `builtin_N` 指向另一个站，历史记录与收藏会串台。
 */
export const DEFAULT_SOURCES: SourceConfig[] = (data.sources ?? []).map((source, index) => ({
  key: `builtin_${index}`,
  name: source.name,
  url: source.url,
  detail: source.detail,
  isAdult: source.isAdult,
}));

export const DEFAULT_LIVE_SOURCES: LiveSourceConfig[] = (data.liveSources ?? []).map((source, index) => ({
  key: `builtin_live_${index}`,
  name: source.name,
  url: source.url,
  epg: source.epg,
}));

/**
 * 新装用户默认启用的内置直播源。
 *
 * 「iptv-org 全球频道」有一万多个频道、「iptv-org 中国频道」实测 138 个里只有 66
 * 个能打开，开着它们只会让用户随便点一个台就是死台。清单里用 `selected: false`
 * 标出来：源照样加进列表，只是默认不勾选，需要时在设置里手动打开。默认启用的
 * 只有 Collect-IPTV 精选（实测 94% 可播、首响中位数 169ms）。
 */
export const DEFAULT_LIVE_SELECTED_KEYS: string[] = (data.liveSources ?? [])
  .map((source, index) => (source.selected === false ? null : `builtin_live_${index}`))
  .filter((key): key is string => key !== null);

/** 清单里明确标了 `selected: false` 的内置直播源 key */
export const DEFAULT_LIVE_DISABLED_KEYS: string[] = (data.liveSources ?? [])
  .map((source, index) => (source.selected === false ? `builtin_live_${index}` : null))
  .filter((key): key is string => key !== null);

/**
 * 从哪个清单版本开始「只默认启用健康源」。
 *
 * 到 v4 为止老用户是三个直播源全开的，只改 `selected` 对他们没有任何效果（他们的
 * 勾选状态早就存进 `liveSelectedKeys` 了），所以升级到该版本时**取消勾选一次**。
 * 只做这一次：用户之后手动打开的，不会在下次升级时又被关掉。
 */
export const LIVE_SELECTION_VERSION = 5;

/** 默认不启用的内置源在设置页需要解释一句，否则用户以为它坏了 */
export const DEFAULT_LIVE_NOTES: Record<string, string> = Object.fromEntries(
  (data.liveSources ?? [])
    .map((source, index) => [`builtin_live_${index}`, source.note ?? ''] as const)
    .filter(([, note]) => note !== '')
);

export const DEFAULTS_NOTICE =
  '内置源均为第三方公开接口，与本项目无隶属关系；仅作开箱即用的示例，可在设置中随时停用或删除。';
