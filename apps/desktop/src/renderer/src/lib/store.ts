import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DEFAULTS_VERSION, DEFAULT_LIVE_SELECTED_KEYS, DEFAULT_LIVE_SOURCES, DEFAULT_SOURCES } from './defaults';
import {
  DEFAULT_SETTINGS,
  dedupeHistory as dedupeHistoryList,
  stableKey,
  toggleFavorite as toggleFavoriteList,
  toggleLiveFavorite as toggleLiveFavoriteList,
  upsertHistory,
  type AppSettings,
  type FavoriteEntry,
  type HistoryEntry,
  type LiveFavoriteEntry,
  type LiveSourceConfig,
  type SourceConfig,
} from '@libretv/core';

export interface AppState {
  settings: AppSettings;
  sources: SourceConfig[];
  selectedKeys: string[];
  liveSources: LiveSourceConfig[];
  liveSelectedKeys: string[];
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
  liveFavorites: LiveFavoriteEntry[];
  recentSearches: string[];
  /** 是否已完成首次启动的内置默认源导入 */
  defaultsSeeded: boolean;
  /**
   * 已经同步过的内置源清单版本（见 `defaults/sources.json` 的 `version`）。
   *
   * 光有 `defaultsSeeded` 布尔量不够：老用户早就 seeded 过，新增的内置源
   * 永远进不来。这个数字让「内置源升级」只在版本前进时补一次。
   */
  defaultsVersion: number;
  /** 用户主动删掉的内置源地址：升级补源时不要把它们又塞回来 */
  removedDefaultUrls: string[];

  /** 首次导入 + 版本升级时补齐新增的内置源（幂等） */
  seedDefaults: () => void;
  /** 合并重复配置的源（同一地址只留一条），修老版本重复注入留下的数据 */
  dedupeSources: () => void;
  restoreDefaults: () => void;

  updateSettings: (patch: Partial<AppSettings>) => void;
  addSource: (source: Omit<SourceConfig, 'key'>) => void;
  updateSource: (key: string, patch: Partial<SourceConfig>) => void;
  removeSource: (key: string) => void;
  toggleSource: (key: string) => void;
  addLiveSource: (source: Omit<LiveSourceConfig, 'key'>) => void;
  removeLiveSource: (key: string) => void;
  toggleLiveSource: (key: string) => void;
  recordHistory: (entry: Omit<HistoryEntry, 'updatedAt'>) => void;
  /** 清掉老版本按 id 去重留下的同名重复记录（启动时跑一次即可） */
  dedupeHistory: () => void;
  toggleFavorite: (entry: Omit<FavoriteEntry, 'createdAt'>) => void;
  toggleLiveFavorite: (entry: Omit<LiveFavoriteEntry, 'createdAt'>) => void;
  addRecentSearch: (keyword: string) => void;
  importSources: (sources: SourceConfig[], liveSources: LiveSourceConfig[]) => { addedVod: number; addedLive: number };
  clearHistory: () => void;
  removeHistory: (id: string) => void;
  replaceAll: (data: Partial<Pick<AppState, 'sources' | 'selectedKeys' | 'liveSources' | 'liveSelectedKeys' | 'history' | 'favorites' | 'liveFavorites' | 'settings'>>) => void;
}

function uniqueKey(prefix: string, existing: string[]): string {
  let key = `${prefix}_${stableKey(`${Date.now()}_${Math.random()}`)}`;
  while (existing.includes(key)) key = `${prefix}_${stableKey(`${key}_${Math.random()}`)}`;
  return key;
}

/**
 * 包装过的 localStorage：写失败时不再向调用方抛异常。
 *
 * zustand 的 `persist` 在 `setItem` 上没有 try/catch，而 `setState` 是同步
 * `return setItem(...)`——所以一旦配额写满，**每次 `recordHistory` 都会抛**，
 * 后面那句 `savedRef.current = …` 就被跳过，播放进度链路直接断掉，
 * 而且异常发生在事件处理器里，ErrorBoundary 也捕获不到。
 *
 * 这里退一步：写不下就先把「可有可无」的缓存键清掉再试一次，仍失败就只打日志。
 * 进度存不下来是遗憾，比整个历史记录写不进去、还连带抛异常好得多。
 */
const quotaSafeStorage = {
  getItem(name: string): string | null {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string): void {
    try {
      localStorage.setItem(name, value);
    } catch {
      // 配额满了：先释放纯缓存（分类目录 / 检索 / 直播频道），它们下次能重新抓
      for (const key of ['libretv-live-cache-v1', 'libretv-search-cache-v1', 'libretv-catalog-v1']) {
        try {
          localStorage.removeItem(key);
        } catch {
          /* ignore */
        }
      }
      try {
        localStorage.setItem(name, value);
      } catch (err) {
        console.warn('[libretv] 本地存储写入失败，本次状态未持久化', err);
      }
    }
  },
  removeItem(name: string): void {
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      sources: [],
      selectedKeys: [],
      liveSources: [],
      liveSelectedKeys: [],
      history: [],
      favorites: [],
      liveFavorites: [],
      recentSearches: [],
      defaultsSeeded: false,
      defaultsVersion: 0,
      removedDefaultUrls: [],

      seedDefaults: () =>
        set((s) => {
          const version = DEFAULTS_VERSION;
          const upgraded = s.defaultsVersion < version;
          // 首次启动与「内置源清单升级」走同一条路径：两边都只补「本地没有的 url」，
          // 因此重复执行是安全的。老用户升级时不能只靠 defaultsSeeded 布尔量，
          // 否则新增的内置源永远进不来（这正是加 defaultsVersion 的原因）。
          if (s.defaultsSeeded && !upgraded) return s;
          // 老版本可能会把内置源重复写进存储（同一 url 出现多次），
          // 这里补一次合并：先按 url 去重，再补齐 selectedKeys。
          const existingUrls = new Set(s.sources.map((x) => x.url));
          const merged: typeof s.sources = [];
          const seen = new Set<string>();
          for (const source of s.sources) {
            if (seen.has(source.url)) continue;
            seen.add(source.url);
            merged.push(source);
          }
          // 用户删掉过的内置源不要再塞回来：升级补源不能把「我不想要这个站」
          // 变成「每次升级都复活一次」。
          const removed = new Set(s.removedDefaultUrls);
          const added = DEFAULT_SOURCES.filter((d) => !existingUrls.has(d.url) && !removed.has(d.url));
          const sources = [...merged, ...added];
          const liveRemoved = removed;
          const addedLive = DEFAULT_LIVE_SOURCES.filter(
            (d) => !s.liveSources.some((x) => x.url === d.url) && !liveRemoved.has(d.url)
          );
          const liveSources = [...s.liveSources, ...addedLive];
          const defaultLiveSelected = new Set(DEFAULT_LIVE_SELECTED_KEYS);
          return {
            sources,
            selectedKeys: [...new Set([...s.selectedKeys, ...added.map((x) => x.key)])].filter((key) =>
              sources.some((x) => x.key === key)
            ),
            liveSources,
            // 只勾选清单里「默认启用」的内置源：iptv-org 全球频道这类默认关掉的
            // 源虽然进列表，但不参与加载，否则新用户开箱就是一屏死台。
            liveSelectedKeys: [
              ...new Set([
                ...s.liveSelectedKeys,
                ...addedLive.filter((x) => defaultLiveSelected.has(x.key)).map((x) => x.key),
              ]),
            ].filter((key) => liveSources.some((x) => x.key === key)),
            defaultsSeeded: true,
            defaultsVersion: version,
          };
        }),

      dedupeSources: () =>
        set((s) => {
          // 记下「被删掉的 key → 保留的 key」：同地址的两条源里，用户启用的可能
          // 正好是后一条。只按 key 过滤会把这种源静默停用，用户会以为「我明明
          // 开着这个源，怎么没内容了」——把启用状态搬到留下来的那条上。
          const keepByUrl = new Map<string, string>();
          const sources = s.sources.filter((source) => {
            if (!keepByUrl.has(source.url)) keepByUrl.set(source.url, source.key);
            return keepByUrl.get(source.url) === source.key;
          });
          const liveKeepByUrl = new Map<string, string>();
          const liveSources = s.liveSources.filter((source) => {
            if (!liveKeepByUrl.has(source.url)) liveKeepByUrl.set(source.url, source.key);
            return liveKeepByUrl.get(source.url) === source.key;
          });
          const keys = new Set(sources.map((x) => x.key));
          const liveKeys = new Set(liveSources.map((x) => x.key));
          const remap = (list: string[], kept: Set<string>, pool: { key: string; url: string }[], byUrl: Map<string, string>) =>
            [
              ...new Set(
                list
                  .map((key) =>
                    kept.has(key) ? key : byUrl.get(pool.find((x) => x.key === key)?.url ?? ''),
                  )
                  .filter((key): key is string => Boolean(key)),
              ),
            ];
          const selectedKeys = remap(s.selectedKeys, keys, s.sources, keepByUrl);
          const liveSelectedKeys = remap(s.liveSelectedKeys, liveKeys, s.liveSources, liveKeepByUrl);
          const changed =
            sources.length !== s.sources.length ||
            liveSources.length !== s.liveSources.length ||
            selectedKeys.length !== s.selectedKeys.length ||
            liveSelectedKeys.length !== s.liveSelectedKeys.length;
          if (!changed) return s;
          return { sources, liveSources, selectedKeys, liveSelectedKeys };
        }),

      restoreDefaults: () =>
        set((s) => {
          const vod = DEFAULT_SOURCES.filter((d) => !s.sources.some((x) => x.url === d.url));
          const live = DEFAULT_LIVE_SOURCES.filter((d) => !s.liveSources.some((x) => x.url === d.url));
          // 用户明确点了「恢复」：把「不再自动补回」的名单一并清掉，
          // 否则下次内置源清单升级时这些刚恢复的地址又会被当成「用户删掉的」。
          const restored = new Set([...vod.map((x) => x.url), ...live.map((x) => x.url)]);
          // 恢复默认同样只勾选「默认启用」的那几个，「恢复默认源」不该顺手把
          // 一万多个境外台打开（那是打开后立刻卡死）
          const defaultLiveSelected = new Set(DEFAULT_LIVE_SELECTED_KEYS);
          return {
            sources: [...s.sources, ...vod],
            selectedKeys: [...new Set([...s.selectedKeys, ...vod.map((x) => x.key)])],
            liveSources: [...s.liveSources, ...live],
            liveSelectedKeys: [
              ...new Set([
                ...s.liveSelectedKeys,
                ...live.filter((x) => defaultLiveSelected.has(x.key)).map((x) => x.key),
              ]),
            ],
            removedDefaultUrls: s.removedDefaultUrls.filter((url) => !restored.has(url)),
            defaultsSeeded: true,
            defaultsVersion: DEFAULTS_VERSION,
          };
        }),

      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      addSource: (source) =>
        set((s) => {
          const key = uniqueKey('custom', s.sources.map((x) => x.key));
          return {
            sources: [...s.sources, { ...source, key }],
            selectedKeys: [...s.selectedKeys, key],
          };
        }),

      updateSource: (key, patch) =>
        set((s) => ({
          sources: s.sources.map((x) => (x.key === key ? { ...x, ...patch } : x)),
        })),

      removeSource: (key) =>
        set((s) => {
          const target = s.sources.find((x) => x.key === key);
          // 记下被删掉的内置源地址：内置源清单升级时不能再把它塞回来
          const isBuiltin = Boolean(target && DEFAULT_SOURCES.some((d) => d.url === target.url));
          return {
            sources: s.sources.filter((x) => x.key !== key),
            selectedKeys: s.selectedKeys.filter((k) => k !== key),
            history: s.history.filter((h) => h.sourceKey !== key),
            favorites: s.favorites.filter((f) => f.sourceKey !== key),
            removedDefaultUrls:
              isBuiltin && target ? [...new Set([...s.removedDefaultUrls, target.url])] : s.removedDefaultUrls,
          };
        }),

      toggleSource: (key) =>
        set((s) => ({
          selectedKeys: s.selectedKeys.includes(key)
            ? s.selectedKeys.filter((k) => k !== key)
            : [...s.selectedKeys, key],
        })),

      addLiveSource: (source) =>
        set((s) => {
          const key = uniqueKey('live', s.liveSources.map((x) => x.key));
          return {
            liveSources: [...s.liveSources, { ...source, key }],
            liveSelectedKeys: [...s.liveSelectedKeys, key],
          };
        }),

      removeLiveSource: (key) =>
        set((s) => {
          const target = s.liveSources.find((x) => x.key === key);
          const isBuiltin = Boolean(target && DEFAULT_LIVE_SOURCES.some((d) => d.url === target.url));
          return {
            liveSources: s.liveSources.filter((x) => x.key !== key),
            liveSelectedKeys: s.liveSelectedKeys.filter((k) => k !== key),
            removedDefaultUrls:
              isBuiltin && target ? [...new Set([...s.removedDefaultUrls, target.url])] : s.removedDefaultUrls,
          };
        }),

      toggleLiveSource: (key) =>
        set((s) => ({
          liveSelectedKeys: s.liveSelectedKeys.includes(key)
            ? s.liveSelectedKeys.filter((k) => k !== key)
            : [...s.liveSelectedKeys, key],
        })),

      recordHistory: (entry) =>
        set((s) => ({ history: upsertHistory(s.history, entry) })),

      dedupeHistory: () =>
        set((s) => {
          const next = dedupeHistoryList(s.history);
          // 没有变化就不要触发重渲染
          return next.length === s.history.length ? s : { history: next };
        }),

      toggleFavorite: (entry) =>
        set((s) => ({ favorites: toggleFavoriteList(s.favorites, entry) })),

      toggleLiveFavorite: (entry) =>
        set((s) => ({ liveFavorites: toggleLiveFavoriteList(s.liveFavorites, entry) })),

      addRecentSearch: (keyword) =>
        set((s) => {
          const kw = keyword.trim();
          if (!kw) return s;
          return { recentSearches: [kw, ...s.recentSearches.filter((x) => x !== kw)].slice(0, 12) };
        }),

      importSources: (incomingVod, incomingLive) => {
        const state = get();
        const existingVodUrls = new Set(state.sources.map((s) => s.url));
        const existingLiveUrls = new Set(state.liveSources.map((s) => s.url));
        const vod = incomingVod.filter((s) => !existingVodUrls.has(s.url));
        const live = incomingLive.filter((s) => !existingLiveUrls.has(s.url));
        if (vod.length === 0 && live.length === 0) return { addedVod: 0, addedLive: 0 };
        set({
          sources: [...state.sources, ...vod],
          selectedKeys: [...new Set([...state.selectedKeys, ...vod.map((s) => s.key)])],
          liveSources: [...state.liveSources, ...live],
          liveSelectedKeys: [...new Set([...state.liveSelectedKeys, ...live.map((s) => s.key)])],
        });
        return { addedVod: vod.length, addedLive: live.length };
      },

      clearHistory: () => set({ history: [] }),

      removeHistory: (id) => set((s) => ({ history: s.history.filter((h) => h.id !== id) })),

      replaceAll: (data) =>
        set((s) => ({
          sources: data.sources ?? s.sources,
          selectedKeys: data.selectedKeys ?? s.selectedKeys,
          liveSources: data.liveSources ?? s.liveSources,
          liveSelectedKeys: data.liveSelectedKeys ?? s.liveSelectedKeys,
          history: data.history ?? s.history,
          favorites: data.favorites ?? s.favorites,
          liveFavorites: data.liveFavorites ?? s.liveFavorites,
          settings: data.settings ?? s.settings,
        })),
    }),
    {
      name: 'libretv-desktop-v1',
      version: 1,
      storage: createJSONStorage(() => quotaSafeStorage),
      partialize: (s) => ({
        settings: s.settings,
        sources: s.sources,
        selectedKeys: s.selectedKeys,
        liveSources: s.liveSources,
        liveSelectedKeys: s.liveSelectedKeys,
        history: s.history,
        favorites: s.favorites,
        liveFavorites: s.liveFavorites,
        recentSearches: s.recentSearches,
        defaultsSeeded: s.defaultsSeeded,
        // 这两个字段决定「内置源清单升级时补哪些源」，必须持久化：
        // 只存 defaultsSeeded 的话，老用户永远停在旧的内置源列表上。
        defaultsVersion: s.defaultsVersion,
        removedDefaultUrls: s.removedDefaultUrls,
      }),
    }
  )
);

/** 当前参与搜索的源 */
export function activeSources(state: AppState): SourceConfig[] {
  return state.sources.filter((s) => state.selectedKeys.includes(s.key));
}

/** 当前已启用的直播源 */
export function activeLiveSources(state: AppState): LiveSourceConfig[] {
  return state.liveSources.filter((s) => state.liveSelectedKeys.includes(s.key));
}

export function getState(): AppState {
  return useAppStore.getState();
}
