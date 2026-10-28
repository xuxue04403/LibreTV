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
 * 「iptv-org 全球频道」有一万多个频道，且绝大多数在境内根本连不上（实测中国大陆
 * 频道可播率 48%，全球榜更低）；开着它只会让用户随便点一个台就是死台。清单里
 * 用 `selected: false` 标出来：源照样加进列表，只是默认不勾选，需要外语台时
 * 在设置里手动打开。
 *
 * 注意只影响**新装**用户：老用户的选择存在 `liveSelectedKeys` 里，升级时
 * 我们不能替他改主意。
 */
export const DEFAULT_LIVE_SELECTED_KEYS: string[] = (data.liveSources ?? [])
  .map((source, index) => (source.selected === false ? null : `builtin_live_${index}`))
  .filter((key): key is string => key !== null);

/** 默认不启用的内置源在设置页需要解释一句，否则用户以为它坏了 */
export const DEFAULT_LIVE_NOTES: Record<string, string> = Object.fromEntries(
  (data.liveSources ?? [])
    .map((source, index) => [`builtin_live_${index}`, source.note ?? ''] as const)
    .filter(([, note]) => note !== '')
);

export const DEFAULTS_NOTICE =
  '内置源均为第三方公开接口，与本项目无隶属关系；仅作开箱即用的示例，可在设置中随时停用或删除。';
