# 架构设计

## 总览

```
                        ┌──────────────────────────────┐
   Apple CMS 采集站 ───▶ │ packages/core（纯 TS 逻辑）    │
   M3U / XMLTV 源   ───▶ │ 解析 · 聚合 · 订阅 · 存储模型  │
                        └──────────────┬───────────────┘
                                       │ 被两端复用（语义一致）
        ┌──────────────────────────────┴───────────────────────────┐
        │                                                          │
┌───────▼───────────────────────┐                  ┌───────────────▼──────────────┐
│ apps/desktop（Electron）       │                  │ apps/androidtv（Kotlin）      │
│  main: IPC fetch / 回环代理 /  │                  │  ViewModel: 搜索/详情/直播     │
│        DLNA 发送端             │                  │  Repository + OkHttp          │
│  renderer: React + hls.js      │                  │  Media3 ExoPlayer             │
│  preload: contextBridge        │                  │  DLNA 接收端（DMR）           │
└───────────────────────────────┘                  └──────────────────────────────┘
```

没有服务端进程、没有数据库、没有账号体系。所有状态都在本机。

## 共享核心 `packages/core`

| 模块 | 职责 | 上游来源 |
| --- | --- | --- |
| `types.ts` | 数据模型（源、搜索结果、详情、直播、历史/收藏、设置） | `src/lib/types.ts` |
| `cms.ts` | Apple CMS 搜索/详情解析、分集提取、相关性/成人过滤 | `src/lib/cms-parser.ts` |
| `m3u.ts` | M3U 解析（属性、`#EXTGRP`、相对地址、去重） | `src/lib/m3u-parser.ts` |
| `ad-filter.ts` | m3u8 广告分片过滤（URL 特征 / 超短段 / 片头段） | `src/lib/m3u8.ts` |
| `search.ts` | 多源并行聚合：分页、单源死线、逐源回调 | `src/app/api/search` |
| `detail.ts` | 详情 + 详情页 HTML 兜底 | `src/app/api/detail` |
| `live.ts` | M3U 订阅加载、XMLTV 解析、当前/下一档节目 | `src/app/api/live/*`、`src/lib/xmltv.ts` |
| `subscriptions.ts` | LibreTV-SourceList / TVBOX 配置解析（宽容 JSON） | `src/lib/source-list.ts`、`tvbox-parser.ts` |
| `group.ts` | 同名影片跨源聚合、结果去重 | 上游页面层逻辑 |
| `storage.ts` | 历史/收藏的纯函数式更新、快照导入导出 | `src/lib/store.ts` 部分 |
| `http.ts` | `HttpClient` 接口 + fetch 实现 + gzip 解码 | 新增（替代服务端抓取） |

设计约束：**core 不引用 Electron、不引用 Node 内置模块**（`node:zlib` 用 `DecompressionStream` 替代），因此同一份代码既能在主进程、渲染进程，也能在浏览器里跑。

## 桌面端

### 进程模型

```
┌──────────── main（Node） ────────────┐        ┌──────── renderer（Chromium） ────────┐
│ ipcMain 'http:fetch'   抓取 + UA     │◀──IPC──▶│ React 页面 / zustand 状态            │
│ ipcMain 'dlna:*'       SSDP + SOAP   │        │ hls.js / mpegts.js 播放器            │
│ 回环代理 127.0.0.1:随机端口?token=…  │◀──HTTP──│ 视频分片 / 封面图 / 播放列表          │
└──────────────────────────────────────┘        └──────────────────────────────────────┘
```

- **preload** 只暴露 contextBridge 白名单方法，渲染层不开 Node 集成；
- **主进程** 负责所有「浏览器做不了」的事：无 CORS 抓取、Referer 伪造、SSDP 组播、SOAP。

### 播放链路

1. 详情页拿到 `episodes[]`，点击某集进入 `/watch` 视图；
2. 若是 `.m3u8`：`src = http://127.0.0.1:<port>/t/<token>/p?url=<encoded>&ad=1`；
3. 代理拉取上游播放列表，命中则调用 `stripAdGroups` 处理；
4. 代理把分片/密钥/初始化段的地址递归改写成代理地址，并透传 `Range`；
5. hls.js 只与 127.0.0.1 通信，因此不受 CORS / 防盗链影响；
6. 进度每 5 秒写入 zustand（localStorage），换集/退出/暂停时强制落盘；下次进入自动定位。

非 HLS（mp4 直链）走同一代理，`<video>` 直接播放。

### 投屏链路（发送端）

```
renderer「投屏」──▶ main: dlna:discover
                        ├─ UDP 组播 M-SEARCH（ST=MediaRenderer / ssdp:all）
                        ├─ 收集 LOCATION → GET description.xml
                        └─ 解析 friendlyName + AVTransport controlURL
renderer 选设备 ──▶ main: dlna:cast
                        ├─ SOAP SetAVTransportURI（DIDL-Lite 元数据 + 原始地址）
                        └─ SOAP Play
```

注意：投屏推送的是**原始上游地址**（不是回环代理地址），否则电视无法访问 `127.0.0.1`。

### 内置默认源

`defaults/sources.json` 是唯一事实来源：桌面端通过 Vite alias `@defaults` 在构建期内联，Android TV 在 `preBuild` 阶段复制到 `assets/default-sources.json`。首次启动写入本地状态并置 `defaultsSeeded=true`；之后即使用户删光也不会自动加回，直到手动「恢复默认源」。

## Android TV 端

### 分层

```
MainActivity ── Compose UI（Home/Search/Detail/Player/Live/Settings/Cast）
     │                │
     │                └── AppViewModel（StateFlow<AppData> + 页面状态）
     │                        └── Repository ── Net(OkHttp) ── 采集站 / M3U
     └── DlnaServer（SSDP + HTTP/SOAP，后台线程）
AppStore（DataStore Preferences，整份 AppData 以 JSON 存储）
```

### 电视交互要点

- **焦点**：`TvCard` 统一处理「聚焦放大 1.05x + 橙色描边 + zIndex 提升」，避免被相邻卡片裁切；
- **播放页不放置可聚焦按钮条**：遥控器在按钮间移动成本高，改为把操作映射到按键（OK / ←→ / ↑ / 返回），屏幕只显示状态与提示；
- **字体**：正文 15–16sp、标题 21sp 起，适配 3 米观看距离；
- **输入**：搜索框聚焦时弹出系统 IME，另提供历史片名一键搜索。

### 投屏链路（接收端 DMR）

```
手机 ── SSDP M-SEARCH ──▶ DlnaServer（239.255.255.250:1900）
     ◀── 200 OK + LOCATION: http://<tv-ip>:<port>/description.xml
手机 ── GET /description.xml ──▶ 设备描述（MediaRenderer + 3 个服务）
手机 ── POST /AVTransport/control ──▶ SetAVTransportURI(CurrentURI, Metadata)
                                        └─ CastRuntime.pending → Compose 自动进入播放页
     ── Play / GetTransportInfo / GetPositionInfo / Seek / GetVolume …
```

- 自研实现，不依赖已停止维护的 Cling；
- 需要 `WifiManager.MulticastLock`（已申请 `CHANGE_WIFI_MULTICAST_STATE`），否则收不到组播；
- 设备名「LibreTV 电视」，固定 UDN 保证手机端记住设备。

## 数据模型

桌面端 zustand（`libretv-desktop-v1`）与 TV 端 DataStore 结构对齐：

```ts
interface AppData {
  settings: { adultFilter, adFilter, autoplayNext, theme, resumePlayback }
  sources: SourceConfig[]          // key/name/url/detail
  selectedKeys: string[]
  liveSources: LiveSourceConfig[]  // key/name/url/epg
  liveSelectedKeys: string[]
  history: HistoryEntry[]          // 按 id 去重置顶，上限 200 / 100
  favorites: FavoriteEntry[]
  liveFavorites: LiveFavoriteEntry[]
  defaultsSeeded: boolean          // TV 端为 seeded
}
```

## 错误处理与降级

| 场景 | 行为 |
| --- | --- |
| 单个源超时 | 该源标「超时」，其余源结果照常展示（10s 单源死线） |
| 所有源失败 | 顶部提示 + 保留各源失败原因徽章 |
| 详情接口无播放地址 | 自动爬详情页；仍失败则提示换源 |
| HLS 分片 404 | hls.js 触发 `NETWORK_ERROR` → 自动 `startLoad()`；连续失败展示「返回换源」 |
| 媒体解码错误 | `recoverMediaError()` 一次，仍失败则提示 |
| 投屏设备拒绝 | 解析 SOAP `errorCode` 并回显到面板 |
| 媒体代理拒绝私网 | 面板提示，自建源可用 `LTV_ALLOW_PRIVATE_MEDIA=1` 放行 |

## 已知限制

- 直连会向采集站暴露用户 IP（上游用服务端规避）；
- Android TV 暂无 HLS 广告过滤、画质探测、EPG 展示；
- DLNA 接收端只实现控制类动作，未实现 GENA 事件订阅（部分手机依赖事件回调刷新进度，可能显示 0:00）；
- 投屏不支持受 DRM 保护的流。
