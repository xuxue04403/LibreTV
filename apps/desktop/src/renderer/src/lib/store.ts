import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_LIVE_SOURCES, DEFAULT_SOURCES } from './defaults';
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

      seedDefaults: () =>
        set((s) => {
          if (s.defaultsSeeded) return s;
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
          const added = DEFAULT_SOURCES.filter((d) => !existingUrls.has(d.url));
          const sources = [...merged, ...added];
          return {
            sources,
            selectedKeys: [...new Set([...s.selectedKeys, ...DEFAULT_SOURCES.map((x) => x.key)])].filter(
              (key) => sources.some((x) => x.key === key)
            ),
            liveSources: [...s.liveSources, ...DEFAULT_LIVE_SOURCES.filter((d) => !s.liveSources.some((x) => x.url === d.url))],
            liveSelectedKeys: [...new Set([...s.liveSelectedKeys, ...DEFAULT_LIVE_SOURCES.map((x) => x.key)])],
            defaultsSeeded: true,
          };
        }),

      dedupeSources: () =>
        set((s) => {
          const seen = new Set<string>();
          const sources = s.sources.filter((source) => {
            if (seen.has(source.url)) return false;
            seen.add(source.url);
            return true;
          });
          const liveSeen = new Set<string>();
          const liveSources = s.liveSources.filter((source) => {
            if (liveSeen.has(source.url)) return false;
            liveSeen.add(source.url);
            return true;
          });
          const keys = new Set(sources.map((x) => x.key));
          const liveKeys = new Set(liveSources.map((x) => x.key));
          const selectedKeys = [...new Set(s.selectedKeys)].filter((key) => keys.has(key));
          const liveSelectedKeys = [...new Set(s.liveSelectedKeys)].filter((key) => liveKeys.has(key));
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
          return {
            sources: [...s.sources, ...vod],
            selectedKeys: [...new Set([...s.selectedKeys, ...vod.map((x) => x.key)])],
            liveSources: [...s.liveSources, ...live],
            liveSelectedKeys: [...new Set([...s.liveSelectedKeys, ...live.map((x) => x.key)])],
            defaultsSeeded: true,
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
        set((s) => ({
          sources: s.sources.filter((x) => x.key !== key),
          selectedKeys: s.selectedKeys.filter((k) => k !== key),
          history: s.history.filter((h) => h.sourceKey !== key),
          favorites: s.favorites.filter((f) => f.sourceKey !== key),
        })),

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
        set((s) => ({
          liveSources: s.liveSources.filter((x) => x.key !== key),
          liveSelectedKeys: s.liveSelectedKeys.filter((k) => k !== key),
        })),

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
