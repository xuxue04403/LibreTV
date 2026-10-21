/**
 * 共享数据模型。
 *
 * 移植自 LibreTV（AGPL-3.0-or-later）src/lib/types.ts：
 * https://github.com/LibreSpark/LibreTV
 * 改动：去掉服务端响应/鉴权类型，补充客户端本地存储模型。
 */

/** 采集站（Apple CMS 资源站）描述 */
export interface SourceConfig {
  /** 唯一标识，如 "custom_0" */
  key: string;
  name: string;
  /** API 根地址，如 https://example.com/api.php/provide/vod */
  url: string;
  /** 可选：详情页根地址（部分源需要爬详情页提取 m3u8） */
  detail?: string;
  isAdult?: boolean;
}

export interface SearchResultItem {
  sourceKey: string;
  sourceName: string;
  vodId: string;
  name: string;
  pic?: string;
  typeName?: string;
  year?: string;
  area?: string;
  remarks?: string;
  /** 自定义源的 API 地址，详情请求需要 */
  sourceUrl?: string;
  isAdult?: boolean;
}

export interface VideoInfo {
  title?: string;
  cover?: string;
  desc?: string;
  typeName?: string;
  year?: string;
  area?: string;
  director?: string;
  actor?: string;
  remarks?: string;
  sourceKey: string;
  sourceName: string;
  sourceUrl?: string;
}

export interface VideoDetail {
  episodes: string[];
  videoInfo: VideoInfo;
}

export interface SourceSearchOutcome {
  sourceKey: string;
  /** 源显示名（结果徽章直接使用，避免再回查源配置） */
  sourceName: string;
  ok: boolean;
  list: SearchResultItem[];
  error?: string;
  /** 因超时失败：源可能只是慢，前端以琥珀色区分于真正的失败 */
  timedOut?: boolean;
  /** 该源搜索总耗时（ms） */
  ms?: number;
}

/** 同名影片跨源聚合后的一张卡片 */
export interface AggregatedGroup {
  /** 归一化标题（分组键） */
  key: string;
  /** 展示用标题（取第一条结果的原始标题） */
  name: string;
  /** 组内各来源结果，按源名排序 */
  items: SearchResultItem[];
}

// —— 直播 / IPTV ——

/** 直播源（M3U 订阅）配置 */
export interface LiveSourceConfig {
  key: string;
  name: string;
  /** M3U 订阅地址 */
  url: string;
  /** 可选：XMLTV 节目单地址 */
  epg?: string;
}

/** 单个直播频道（由 M3U 解析得到） */
export interface LiveChannel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  rawName?: string;
}

export interface LivePlaylist {
  /** 订阅名（M3U 无名时为空） */
  name?: string;
  channels: LiveChannel[];
  groups: string[];
}

export interface EpgProgram {
  channelId: string;
  /** epoch ms */
  start: number;
  /** epoch ms */
  stop: number;
  title: string;
  desc?: string;
}

export interface LiveEpg {
  channelId: string;
  current?: EpgProgram;
  next?: EpgProgram;
  programs: EpgProgram[];
}

// —— 本地存储模型（客户端专有） ——

export interface AppSettings {
  /** 成人内容过滤 */
  adultFilter: boolean;
  /** 播放列表广告分片过滤 */
  adFilter: boolean;
  /** 自动连播下一集 */
  autoplayNext: boolean;
  /** 主题 */
  theme: 'dark' | 'light' | 'system';
  /** 记住播放进度 */
  resumePlayback: boolean;
}

export interface HistoryEntry {
  /** `${sourceKey}:${vodId}` */
  id: string;
  sourceKey: string;
  vodId: string;
  title: string;
  cover?: string;
  sourceName: string;
  /** 当前集下标 */
  episodeIndex: number;
  episodeCount: number;
  /** 当前集地址 */
  episodeUrl?: string;
  /** 播放位置（秒） */
  position: number;
  /** 总时长（秒） */
  duration: number;
  updatedAt: number;
}

export interface FavoriteEntry {
  id: string;
  sourceKey: string;
  vodId: string;
  title: string;
  cover?: string;
  createdAt: number;
}

export interface LiveFavoriteEntry {
  url: string;
  name: string;
  logo?: string;
  group?: string;
  createdAt: number;
}
