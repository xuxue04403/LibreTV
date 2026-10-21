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
| `categories.ts` | 分类表解析、分类桶归并、按分类聚合浏览 | 上游无此能力（新增） |
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

### 分辨率自适应（`ui/theme/Scaling.kt`）

电视盒子对 `densityDpi` 的上报极不统一。1080p 报 320dpi 时逻辑尺寸正好 960×540dp，4K 报 640dpi 也是 960×540dp —— 这两种情况布局天然正确。但廉价 4K 盒子常只报 160/213dpi，逻辑宽度会变成 3840dp 或 2308dp，960dp 的设计被摊薄到 4 倍宽度里，表现为「界面不随分辨率缩放、字小到看不清、内容全挤在左上角」。

修法是把布局**归一化到设计基准**：

```
scale = min(逻辑宽度dp / 960, 逻辑高度dp / 540)  // 夹在 [0.35, 5]
```

`TvScaleSurface` 用这个比例放大 `LocalDensity`（`Density(base.density * scale, base.fontScale)`）。因为 sp 也由 density 推导，文字会跟着等比放大，不需要改任何 dp/sp 常量。取 `min` 而非 `max` 是为了 21:9 这类超宽屏：按宽度放大虽能填满横向，但纵向会溢出被裁掉。

`MainActivity` 里用 `TvScaleSurface` 包住整棵树，并且 `android:configChanges` 补上 `density`，避免个别盒子在分辨率/密度切换时重建 Activity 闪一下。

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

## 分类浏览

首页顶部的分类入口（电影 / 电视剧 / 少儿 / 综艺 / 动漫 / 纪录片 / 短剧 / 体育，按此顺序展示）不依赖任何中心化分类服务，全部现算：

1. 拉各源的分类表：`GET {api}?ac=list&pg=1`，响应里的 `class[]` 给出该源自己的 `type_id / type_name / type_pid`（缓存 6 小时）；
2. 把分类名映射到统一分类桶（`classifyCategoryName`）。判定顺序有意义——「少儿动画」必须命中「少儿」而不是「动漫」，「纪录电影」必须命中「纪录片」而不是「电影」，因此专属桶排在通用桶之前；
3. 取该桶对应的 `type_id`：**优先叶子分类**。

第 3 步是踩过坑的：Apple CMS 的父分类**不聚合**子分类内容。以量子资源为例，`?ac=videotlist&t=1`（电影片）只返回 `type_id` 恰好为 1 的那 1 条，动作片(6)、喜剧片(7)、科幻片(9) 各自独立。若直接按父分类查询，分类页会几乎空白（实测只有 1 部片）。因此实现改为：识别出该桶下所有叶子分类并行抓取；只有当某源确实没有子分类时才回退到父分类本身。

对 4 个内置源做「电影」分类实测：从 1 部变为 342 部。
分类页支持「加载更多」（追加页并去重），聚合规则与搜索页一致（同名同年合并、显示多源角标）。

### 首页只显示有内容的分类

「少儿」这类分类在部分源里一条内容都没有，入口点进去只能是空页面。因此 `probeCategories` 会在首页挂载时并发探测 8 个分类的可用性：

- 每个分类只抓 1 页、每源最多 1 个子分类（`typeLimit: 1`），4 个源约 32 个请求；
- 结果按 `min(源地址集合, 分类集合, 过滤开关)` 做键缓存 **10 分钟**，避免每次回首页都重探；
- 被 `AbortSignal` 取消的探测不写缓存，防止把「全空」结论固化；
- 探测整体失败（网络全挂）时**退回显示全部入口**，不能因为探测失败就把导航藏空；
- 成人过滤在此同样生效——唯一一条内容是成人内容时，该分类算作空。

实测（4 内置源，2026-10）：电影 ✅ 2 源、电视剧 ✅ 3 源、综艺 ✅ 3、动漫 ✅ 3、纪录片 ✅ 3、短剧 ✅ 3、体育 ✅ 2、**少儿 ❌ 0 源**，耗时约 6.8 秒。

### 展示顺序

分类有两个独立顺序，不要混为一谈：

| 顺序 | 定义处 | 用途 |
| --- | --- | --- |
| 判定顺序 | `CATEGORY_BUCKETS` 数组顺序 | `classifyCategoryName` 短路匹配，专属桶必须在前（否则「少儿动画」被「动漫」抢走） |
| 展示顺序 | `HOME_CATEGORY_ORDER` | 首页按钮排列：电影、电视剧、少儿、综艺、动漫、纪录片、短剧、体育 |

TV 端对应 `CategoryKey` 的 `enum` 声明顺序（判定用）与 `CategoryKey.home`（展示用）。

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
