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

### 播放性能与失败转移

性能上有三处关键设计：

1. **代理分片直通**：`/p` 拿到上游响应后立刻 `getReader()`，只有当第一块内容看起来像播放列表（前 64 字节含 `#EXTM3U`，容忍 BOM）时才整体读入改写；其余分片走 `pipeStream`，边收边发、尊重 `drain` 背压、连接关闭即 `reader.cancel()`。旧实现把整个分片读进 Buffer 再 `res.end()`，首字节要等上游写完。上限：播放列表/图片 16MB，流 1GB。
2. **hls.js 参数**：`maxBufferLength 30` / `maxMaxBufferLength 90` / `backBufferLength 30` / `maxBufferSize 60MB`，`startLevel: -1`（自动选码率）；重试次数压到 1–2 次并配 `fragLoadingRetryDelay 500`，让失败快速暴露给换源逻辑，而不是无限重试卡住。
3. **卡顿看门狗**：`waiting` 事件起 12 秒计时器，`playing` 清除；超时直接触发换源。TV 端同理（`STALL_SECONDS = 15`）。

失败转移分两级，桌面与 TV 行为一致：

```
播放出错（hls 致命错误 / video error / 卡顿超时）
   ├─ 本集恢复计数 < 2 ──▶ 重载当前集（reloadToken / LaunchedEffect 重来）
   └─ 恢复不了 ──▶ failover()
                     ├─ 候选链里还有没试过的源 ──▶ fetchDetail 对齐集数后切过去
                     └─ 候选链空了 ──▶ discoverCandidates 按片名反查补一轮（只补一次）
```

候选链由 `packages/core/src/failover.ts` 的 `buildPlaybackCandidates` 生成，**按源轮转**而不是按结果顺序取满 8 条：搜「沙丘」时单个源可能命中 8 个版本，顺序取会让整条链全来自同一个站，而换源要解决的恰恰是该站整体挂掉。TV 端 `PlaybackCandidate.build` 是同规则的 Kotlin 实现。

### 直播列表加载

直播列表的瓶颈在**下载**，不在解析。实测 iptv-org 的 `index.m3u`（11485 个频道，2.46MB）：服务器只给约 35KB/s 且**不启用 gzip**，整串下完要 70–90 秒；而 `parseM3u` 解析 11 万行只要十几毫秒。所以优化全部围绕「不让用户盯着一分钟空列表」：

```
第 0 秒   读本地缓存（libretv-live-cache-v1，TTL 6h）──命中──▶ 立刻渲染，后台静默刷新
第 0.7 秒 流式响应首块到达 ──▶ 增量解析 ──▶ 首批频道上屏（实测 719–1431ms）
第 1–90 秒 每批新增频道 append，标题栏显示「仍在读取（x.x MB）」
第 90 秒   全部完成 ──▶ 去重后落盘
```

三段实现分别落在：

1. **`packages/core/src/m3u.ts` 的 `createM3uParser`**：`push(chunk)` 用 `indexOf('\n')` 手动切行（不用 `split`，避免大列表反复分配），跨块的半行存进 `carry`，`end()` 收尾。`parseM3u` 退化成 `push(全文) + end()` 的薄封装，保证整串与增量结果 `toEqual`。
2. **`packages/core/src/http.ts` 的 `HttpClient.stream`**：可选方法，没实现的宿主自动退回 `request()`（行为不变，只是不渐进）。空闲死线而非总时长寿（默认 20 秒无数据才断）；大列表合法地要下一分钟，给总时长设死线反而会误杀。
3. **桌面 `Live.tsx` 的增量揭示**：一次只挂载 240 张卡片（`PAGE_SIZE`），用 `IntersectionObserver` 哨兵追加，`rootMargin: 800px`。11485 个频道全量挂载会产生 92945 个 DOM 节点，首屏和滚动都要几百毫秒；窗口化后稳定在 2000–4000 个节点。换台索引仍用**全量** `visible`，所以按 ↓ 能切到尚未挂载的频道。

TV 端同构：`Repository.liveChannelsStream` 按 `batchSize = 120` 回调，`AppViewModel.refreshLive` 用 `Mutex` 累加并**节流 400ms** 才推一次 UI（一万多个频道不节流就是近百次「重算 groups + 整体替换列表」，Compose 重组会明显卡顿）；`AppStore` 用精简字段（`n/u/l/g/t/sk/sn`）而非直接序列化 `LiveChannel` 落盘，省空间也隔离模型演进。

### 直播换台

桌面与 TV 共用同一套语义（`packages/core/src/live-switch.ts` / `data/LiveSwitch.kt`）：在**当前过滤后的可见列表**里循环，而不是全量频道 —— 用户已选分组或搜过关键词，换到列表外的台会莫名其妙。

- 桌面：`LivePlayer` 在 `window` 上监听 `keydown`，`↑/PageUp` 上一台、`↓/PageDown` 下一台、`Esc` 退出、`M` 静音；顶栏另有上一台/下一台按钮与 `n / total` 计数。
- TV：`onPreviewKeyEvent` 映射 `DirectionUp/Left/ChannelUp` → 上一台、`DirectionDown/Right/ChannelDown` → 下一台、`MediaNext/Previous`、`OK` 暂停继续。`Screen.LivePlayer` 带 `playlist` 字段（进播放页时的可见列表），为空则上下键不响应（首页直播收藏就是这种）。
- 换台时立刻销毁旧实例（HLS `destroy()` / ExoPlayer `setMediaItem`），否则旧流会在后台继续占带宽和解码器。`8 秒` 的 `switching` 兜底闸门用于防止某些流迟迟不到 `STATE_READY` 导致上下键永久失灵。

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

「自动缩放」的判据是**同一张卡片占屏宽的比例处处相同**，而不是某个固定像素值。`TvUiScaleTest` 里有一条专门的断言：同一个 128dp 卡片，在 720p@320、1080p@160/213/320、4K@160/320/640 上占屏宽都是 13.33%（= `128 × 2 / 1920`）。

#### 本机验证 TV 端的方法

`system-images;android-tv;x86` 在部分网络下会一直下载失败（zip 停在 0 字节，报 `Error on ZipFile unknown archive`）。改用普通系统镜像同样能验证：**`system-images;android-35;default;x86_64`** 配合 `-d tv_1080p` 建 AVD，App 以 leanback activity 正常拉起、D-pad 可用，只是桌面启动器是手机样式（不影响 App 内部）。建好后的启动命令（后台、无窗口）：

```powershell
emulator.exe -avd <名字> -no-window -no-audio -no-boot-anim `
  -gpu swiftshader_indirect -no-snapshot -port 5556
adb -s emulator-5556 shell am start -n org.libretv.tv/.MainActivity
```

两个小坑：`am start -n org.libretv.tv/MainActivity` 会报 `Activity class does not exist`，必须写带点的 `.MainActivity`；模拟器时区默认 GMT，别按日志时间戳误判时序。

焦点问题不要靠肉眼看截图判断，用 `uiautomator dump` 拿 `focused="true"` 的 `bounds` 序列来对比最准——「按 ↓ 焦点跳去左侧导航栏」就是这么发现的（分类行 `[292,654][564,760]` → 下一跳直接变成导航栏 `[27,663][181,817]`）。

### 播放器调优与失败转移

`data/Playback.kt` 统一构建 `ExoPlayer`，不散落在 UI 层（点播 `PlayerScreen` 与直播 `LivePlayerScreen` 共用同一个构建器）：

- `DefaultLoadControl`：`MIN_BUFFER_MS 1500` / `MAX_BUFFER_MS 30000` / `BUFFER_FOR_PLAYBACK_MS 1500` / `BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS 3000` / `BACK_BUFFER_MS 20000`，并 `setPrioritizeTimeOverSizeThresholds(true)`。起播只要 1.5 秒缓冲就出画面，长缓冲留给播放中兜底。
- `DefaultHttpDataSource.Factory`：固定 `Net.UA`、`connectTimeout 12s` / `readTimeout 20s`、`allowCrossProtocolRedirects`、`Accept-Encoding: identity`（避免拿到 gzip 的分片流）。OkHttp 无 CORS 概念，也不需要回环代理。
- `setHandleAudioBecomingNoisy(true)` 让拔耳机/切输出时自动暂停。

失败转移与桌面端同构：`Player.Listener.onPlayerError` 和 15 秒缓冲看门狗都调 `AppViewModel.failoverPlayback(player, tried, episodeIndex, discovered)`，它返回 `FailoverResult`（新 `Screen.Player` + 对齐后的集数）；候选链空了会 `repo.discoverCandidates` 按片名补一轮，补过仍失败才报错。`openDetail` 也做了候选扇出：前 3 个候选并行拉详情，谁先成功就展示谁（`DETAIL_FANOUT = 3`、`DETAIL_TIMEOUT_MS = 9000`）。

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

探测要 6~10 秒，如果每次都等它回来再渲染，首页会出现「先显示 8 个、几秒后少一个」的跳动。所以结论按「源签名」落盘：桌面端存 `localStorage`（`libretv-category-availability-v1`），TV 端存 DataStore（`category-availability`，格式 `签名\tkey1,key2`）。下次启动先按上次结论渲染，后台探测回来再覆盖；签名变化（换了源、切了成人过滤）时旧结论自动失效。

实测（4 内置源，2026-10）：电影 ✅ 2 源、电视剧 ✅ 3 源、综艺 ✅ 3、动漫 ✅ 3、纪录片 ✅ 3、短剧 ✅ 3、体育 ✅ 2、**少儿 ❌ 0 源**，耗时约 6.8 秒。

#### 不能拿「源还没到」当作「探测结论是空」

TV 端曾经有个只在真机才暴露的竞态：冷启动后首页分类区一直显示「所选源暂未返回任何分类内容」，而同一页的「4/4 启用点播源」却是对的。源加载没问题，坏在探测的时序。

`AppViewModel` 的 `data` 是 `seedIfNeeded()` 之后异步 `collect` 出来的，首帧组合时 `activeSources()` 还是空数组。旧代码在这个分支里写下 `availableCategories = emptyList()` 再返回——等于把「还没探测」记录成了「探测过、结论是无」，而触发探测的 `LaunchedEffect` 键是 `Unit`，源到位后不会重跑，首页就永久停在空态。

正确的写法是两件事一起做：

- 探测函数遇到空源**直接 return，不写任何结论**（`AppViewModel.probeCategories`），让 UI 继续停在「正在识别可用分类…」；
- 触发键改成**源签名**而非 `Unit`：`remember(data.sources, data.selected, data.settings.adultFilter)` 算出 `签名 = 启用的源 key 排序后拼接 + "|" + adultFilter`，`LaunchedEffect(签名)` 一到位就重探（TV 端 `HomeScreen.CategoryRow`）。

同一个坑在空态文案上也要区分开：`available == null` 是「还在识别」，`emptyList()` 才是「确实没有」。两者显示同一句话，用户和后续排错的人都分不清。

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
