/**
 * 本地持久化。
 *
 * 用鸿蒙的 Preferences 存一份 JSON（与 Android 端的 DataStore 单文件、桌面端的
 * localStorage 单 key 是同一思路）：数据量小，整体读写最简单，也便于两端对照排查。
 * 写入做了 400ms 防抖，播放进度每秒回调一次时不会把 IO 打满。
 */
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { AppData, emptyData } from '../model/Types';
import { defaultSettings } from '../model/Types';

const STORE_NAME = 'libretv_store';
const DATA_KEY = 'app_data_v1';
const SAVE_DEBOUNCE_MS = 400;

export class Storage {
  private store: preferences.Preferences | null = null;
  private pending: AppData | null = null;
  private timer: number = -1;

  async init(context: common.UIAbilityContext): Promise<void> {
    this.store = await preferences.getPreferences(context, STORE_NAME);
  }

  /** 同步读一次（Preferences 有内存缓存，getSync 可用） */
  loadSync(): AppData {
    if (this.store === null) {
      return emptyData();
    }
    try {
      const raw = this.store.getSync(DATA_KEY, '') as string;
      if (!raw || raw.length === 0) {
        return emptyData();
      }
      return normalize(JSON.parse(raw) as AppData);
    } catch (err) {
      return emptyData();
    }
  }

  /** 防抖写盘 */
  saveSoon(data: AppData): void {
    this.pending = data;
    if (this.timer !== -1) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = -1;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 立即写盘（页面销毁、切后台时调用） */
  flush(): void {
    const data = this.pending;
    if (data === null || this.store === null) {
      return;
    }
    this.pending = null;
    try {
      this.store.putSync(DATA_KEY, JSON.stringify(data));
      this.store.flush();
    } catch (err) {
      // 写失败只在内存里保留，用户下次操作会再触发一次写入
    }
  }

  /** 清空（设置页的「清空观看历史」等场景复用） */
  clearAll(): void {
    if (this.store === null) {
      return;
    }
    try {
      this.store.deleteSync(DATA_KEY);
      this.store.flush();
    } catch (err) {
      // 忽略：读的时候会退回 emptyData
    }
  }
}

/**
 * 兜底补齐字段：老版本存下来的 JSON 可能缺字段，
 * 直接当 AppData 用会在界面上炸出 undefined。
 */
function normalize(raw: AppData): AppData {
  const base = emptyData();
  return {
    sources: raw.sources ?? base.sources,
    selected: raw.selected ?? base.selected,
    liveSources: raw.liveSources ?? base.liveSources,
    liveSelected: raw.liveSelected ?? base.liveSelected,
    history: raw.history ?? base.history,
    favorites: raw.favorites ?? base.favorites,
    liveFavorites: raw.liveFavorites ?? base.liveFavorites,
    settings: raw.settings ?? defaultSettings(),
    seeded: raw.seeded === true,
    defaultsVersion: typeof raw.defaultsVersion === 'number' ? raw.defaultsVersion : 0,
    removedDefaultUrls: raw.removedDefaultUrls ?? [],
  };
}
