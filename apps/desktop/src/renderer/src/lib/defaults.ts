import defaultsRaw from '@defaults';
import type { LiveSourceConfig, SourceConfig } from '@libretv/core';

interface DefaultsFile {
  name: string;
  sources: { name: string; url: string; detail?: string; isAdult?: boolean }[];
  liveSources: { name: string; url: string; epg?: string }[];
}

const data = defaultsRaw as unknown as DefaultsFile;

/**
 * 内置默认源：与 Android TV 端 assets 里的 default-sources.json 是同一份文件
 * （仓库 defaults/sources.json），避免两端各维护一份。
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

export const DEFAULTS_NOTICE =
  '内置源均为第三方公开接口，与本项目无隶属关系；仅作开箱即用的示例，可在设置中随时停用或删除。';
