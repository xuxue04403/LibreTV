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
4. **点播即预取**：`Watch.tsx` 在创建 hls.js 之前调 `prefetchSegments(episodeUrl)`，主进程 `/prefetch?url=…&count=8` 解析 m3u8 并把开头 8 个分片抓进 `SegmentCache`（64MB 上限、单条 8MB、LRU、并发 3）。`/p` 路由**在回源之前**先查这份缓存，命中直接回内存副本。起播原本要串「等 m3u8 → 等首个分片」两跳 RTT，现在第二跳是内存命中。注意 `/prefetch` 必须允许从内网地址取（联调 mock CMS 时），且失败要返回 `ok:false` 而不是 5xx——预取失败不能影响正常播放。
   - **带 `Range` 的请求一律回源**（`cacheEligible` 判断）。缓存里存的是完整分片（预取用的是无 Range 的 GET），命中分支只按 200 回整段；`#EXT-X-BYTERANGE` 的源会拿到整段却按自己的范围切片，解出来是错位字节 —— 花屏，比慢一点糟糕得多。
   - **两条预热链路要做 in-flight 去重**：渲染层 `/prefetch` 与代理回 m3u8 时的自动预热几乎同时启动，只查 `cache.get()` 挡不住（双方都在对方 `put` 之前看到"没缓存"），同一批分片会下两遍。
   - **master 播放列表要往下钻一层**：多码率源（国内采集站主流形态）的 m3u8 里列的是子播放列表，直接当分片抓只会白下一个 m3u8，却还返回 `ok:true`。`/prefetch` 按 `BANDWIDTH` 取中间档再解析一次；`cached === 0` 时如实报 `ok:false`。
   - 只缓存 `status === 200`（206 是局部响应，当整段缓存会给出错位数据），且 `Content-Length` 与实收字节不符时不入缓存（chunked 上游干净地提前 EOF 也会产生残缺分片）。

失败转移分两级，桌面与 TV 行为一致：

```
播放出错（hls 致命错误 / video error / 卡顿超时）
   ├─ 本集恢复计数 < 2 ──▶ 重载当前集（reloadToken / LaunchedEffect 重来）
   └─ 恢复不了 ──▶ failover()
                     ├─ 候选链里还有没试过的源 ──▶ fetchDetail 对齐集数后切过去
                     └─ 候选链空了 ──▶ discoverCandidates 按片名反查补一轮（只补一次）
```

候选链由 `packages/core/src/failover.ts` 的 `buildPlaybackCandidates` 生成，**按源轮转**而不是按结果顺序取满 8 条：搜「沙丘」时单个源可能命中 8 个版本，顺序取会让整条链全来自同一个站，而换源要解决的恰恰是该站整体挂掉。TV 端 `PlaybackCandidate.build` 是同规则的 Kotlin 实现。

#### 透传 Content-Length 前必须看有没有 content-encoding

`pipeStream` 会把上游的 `Content-Length` 透传给渲染层，但这里有个必须绕开的坑：**undici 解压响应体之后，头里仍然留着压缩时的长度**。

实测（gzip 的上游）：响应头 `content-encoding: gzip` + `content-length: 52`，而 `await res.arrayBuffer()` 拿到的是 **540 字节明文**。代理若照抄这个 52，Chromium 只读前 52 字节就认为响应结束，剩下 488 字节被当成下一个响应 —— 分片被截断，解码出来就是花屏/噪点，而且**是否出现取决于该 CDN 有没有对这一块启用压缩**，所以表现为「有时候」。

修法：只要上游声明过 `content-encoding`，就不透传 `Content-Length`，改走 chunked（`apps/desktop/src/main/proxy.ts` 的 `upstreamEncoding` 判断）。回归测试在 `proxy.test.ts`：「上游 gzip 的分片不会被截断」。

TV 端不经过这个代理（ExoPlayer 直连），OkHttp 自己解压并会重算长度，不存在该问题。

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

### 直播起播慢：一半是死台，一半是我们自己在等

用户反馈「看直播时频道加载缓慢，且经常加载不出来」。先量清楚再改：

| 指标 | iptv-org 中国频道 | Collect-IPTV 精选 |
| --- | --- | --- |
| m3u8 频道数 | 138 | 452 |
| 实际可打开 | 66（**48%**） | 427（**94%**） |
| 首响 p50 / p90 | 508ms / 994ms | **169ms** / 655ms |

也就是说「加载不出来」约有一半来自**源数据本身**：iptv-org 中国榜里近一半是 403、超时或返回 HTML 错误页。默认把三个直播源全勾上、又按「全球频道（一万多个、绝大多数境内打不开）」排在最前，用户随手点一个就是死台。

**改动 1：默认只开健康源。**`defaults/sources.json` 给两个 iptv-org 源加 `"selected": false`（外加 `note` 字段在设置页解释一句），`defaultsVersion` 4→5。默认启用的只有 Collect-IPTV 精选。源照样进列表，只是新装用户默认不勾。

但**光改 `selected` 对老用户是无效的**：他们的勾选状态早在 `liveSelectedKeys` / `liveSelected` 里存着了。所以 `defaultsVersion` 跨过 `LIVE_SELECTION_VERSION = 5` 时**取消勾选一次**（`s.liveSelectedKeys.filter(key => !DEFAULT_LIVE_DISABLED_KEYS.includes(key))`，TV 同构）。只做这一次——用户之后手动打开的，不会在下一次升级时又被关掉。这也是为什么这个迁移要绑版本号而不是每次 `seedDefaults` 都跑。桌面与 TV 的 `restoreBuiltinSources` / `restoreDefaults` 也改成只勾「默认启用」的那批，否则点一次「恢复默认源」又顺手把一万多个境外台打开。

**改动 2：代理层三处会卡住的地方。**

- `fetchChecked` 原来 `await fetch(...)` **没有任何超时**，上游挂住这一跳就永久挂着，界面只能靠 15 秒看门狗兜底。现在每跳带 `HEADER_TIMEOUT_MS = 12_000` 的 `AbortController`，**只盖「等响应头」不盖 body** —— 大分片本来要下几秒，给总时长设死线会砍成半截，那是花屏不是省时间。
- `assertAllowedTarget` 原来**每个分片都做一次 `dns.lookup`**。加 `lookupCached(host)`（60 秒 TTL、512 条上限、in-flight 合并，否则「N 次串行解析」只是变成「N 次并发解析」）。实测单次解析 0–26ms，不算瓶颈，但每片一次纯属白给。
- 直播分片原来也会被攒进内存镜像缓存并自动预热。直播分片地址每次都变，缓存命中率约等于 0，白白占内存和带宽。现在直播走 `live=1` 标记：列表改写出的子地址带 `live=1`，`/p` 据此走 `no-store`、跳过预热、跳过 mirror。实测改写 149/149 子地址都带 `live=1`，列表与分片响应头都是 `no-store`。

**改动 3：起播位置才是「换台慢」的主因。**hls.js 默认从直播边缘往回 `liveSyncDurationCount = 3` 个切片开始播，而 IPTV 的切片普遍很长（实测 Anhui TV `target=5s`、CCTV+ 1 平均 9.77s、Baicheng 平均 6.52s），**要先攒 15–30 秒内容才肯出声**。改成落后 1 个切片（上限 4 个）+ `maxLiveSyncPlaybackRate: 1.5` 追帧后，同一批频道实测：Anhui TV 5.5s→1.7s、CCTV+ 1 1.9s→0.88s、Baicheng 1.0s→0.75s。

**改动 4：死台要快速给结论。**还没出过画面时的 fatal 错误**不再自救**：换台场景下用户就等着结论，每次 `startLoad()` 都是又一轮 8–12 秒的转圈。实测死台给结论的时间从「一律 15 秒（靠看门狗）」变成 10.6–15 秒（hls.js 先失败的直接 1–2 秒），出过画面之后再炸仍然保留 2 次自救。

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

### 全屏与播放页的关系

桌面端的全屏走 `BrowserWindow.setFullScreen()`（不是元素全屏），所以 `document.fullscreenElement` 恒为 `null`，判断全屏只能用 `win.isFullScreen()`。三个约束：

1. **状态以主进程为准**：预加载脚本暴露 `isFullscreen()` 与 `onFullscreenChange(cb)`，主进程在 `enter-full-screen` / `leave-full-screen` 时回推。用户按 F11 或走菜单栏不经过应用内按钮，没有这条回推图标就会失真。
2. **Esc 先退全屏再退播放**：否则全屏下按 Esc 会把播放页关掉、窗口留在满屏，用户找不到边框。
3. **离开播放页要还原窗口**：全屏通常是播放页里开的，卸载时若仍在全屏就调 `setFullscreen(false)`；否则回到首页还在满屏。

### 观看记录的跨源去重

`HistoryEntry.id` 是 `源key:vodId`（与上游一致），只按 id 去重的话，同一部片子从两个采集源各播一次就会留两条同名卡片 —— 首页「继续观看」第一眼就能看出来。

改为**按片名去重**：`packages/core/src/storage.ts` 的 `historyGroupKey(title) = normalizeTitle(title)`（`normalizeTitle` 复用 CMS 的标题归一化：去空白、标点、符号并小写），`upsertHistory` 同时按 id 与片名排他；TV 端 `AppViewModel.saveProgress` 用 `Parsers.normalizeTitle` 实现同一语义。

老数据在启动时清理一次（桌面 `App.tsx` 的 `dedupeHistory()`、TV `dedupeStoredHistory()`），两者都幂等。续播查找相应加兜底：先按 id 精确命中，找不到再按片名找（`findResumeByTitle` / `Parsers.normalizeTitle` 比较），这样换源后也能接着看。**不带年份**是刻意的：采集站标题常带副标题（`流浪地球 2` vs `流浪地球2 4K`），带年份会把同一部片子拆成两条。

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

#### 弹出的面板必须主动把焦点送进去

播放页的根 `Box` 自己是 `focusable()` 的（为了接方向键做快进快退）。Compose 的方向键搜索只在**当前焦点节点的兄弟节点**之间找，不会下钻到它的子节点，于是「↑ 打开选集抽屉」之后左右键完全没反应——抽屉里的卡片永远拿不到焦点。

修法是在面板出现时用 `FocusRequester` 主动送焦点：

- 抽屉：`LaunchedEffect(drawerVisible)` 里先 `scrollToItem(index)`，`delay(90)` 等 `AnimatedVisibility` 展开一帧，再请求当前集卡片的焦点；收起时把焦点还给根节点，否则左右键快进会一起失灵。
- 错误面板：同理，面板出现后把焦点交给「换源重试」按钮，否则重试/下一集/返回三个按钮点不到。

顺带一个约束：抽屉里每张卡片都要有**稳定的** `FocusRequester`（存在 `remember` 的 Map 里按集数索引），不能每次组合都 `FocusRequester()` 新建——新实例和挂上去的那个不是同一个，请求会落空。

#### 想知道「焦点进了某张卡片」，用 TvCard 自己的回调

`ui/Components.kt` 的 `TvCard` 把外部传入的 `modifier` 放在最前面，后面还接 `focusRequester` / `clickable`。所以在外层写 `Modifier.onFocusChanged { … }` 是**收不到事件**的：焦点描边照常出现（那是 `interaction` 的焦点态画的），回调却一次都不触发。实测 `previewCategory` 一次也没被调用，标题和焦点 chip 长期对不上。

需要的回调统一走 `TvCard(onFocusChange = …)`，它内部本来就用 `collectIsFocusedAsState()` 观察焦点（描边、放大都靠这份状态），转发出去才可靠。

#### 验证时先确认跑的是哪个包

`app/build.gradle.kts` 的 debug 构建带 `applicationIdSuffix = ".debug"`。所以装了 debug APK 之后 `am start -n org.libretv.tv/.MainActivity` 启动的仍是**更早装的那个 release 包**，改动看起来"完全没生效"。调试安装包要显式启动 `org.libretv.tv.debug/org.libretv.tv.MainActivity`，或者先 `adb uninstall org.libretv.tv`。

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

焦点问题不要靠肉眼看截图判断，用 `uiautomator dump` 拿 `focused="true"` 的 `bounds` 序列来对比最准——「按 ↓ 焦点跳去导航栏」就是这么发现的（分类行 `[292,654][564,760]` → 下一跳直接变成导航栏 `[27,663][181,817]`）。

### 播放器调优与失败转移

`data/Playback.kt` 统一构建 `ExoPlayer`，不散落在 UI 层（点播 `PlayerScreen` 与直播 `LivePlayerScreen` 共用同一个构建器）：

- `DefaultLoadControl`：参数集中在 `data/PlaybackTuning.kt`，当前 `MIN_BUFFER_MS 2500` / `MAX_BUFFER_MS 30000` / `BUFFER_FOR_PLAYBACK_MS 1200` / `BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS 2000` / `BACK_BUFFER_MS 20000`，并 `setPrioritizeTimeOverSizeThresholds(true)`。起播门槛（1.2s）低于「卡顿后恢复」门槛（2s），首播更快而恢复更稳。
- **这些数字不能随手改**：Media3 有三条硬约束——`maxBufferMs >= minBufferMs`、`minBufferMs >= bufferForPlaybackMs`、`minBufferMs >= bufferForPlaybackAfterRebufferMs`。违反任意一条，`DefaultLoadControl.build()` 会抛 `IllegalArgumentException`，而它发生在 Compose 的帧回调里，**用户看到的就是「按播放整个 App 闪退」**，编译器与 lint 都查不出来。曾经 `MIN_BUFFER_MS 1500` 配 `AFTER_REBUFFER 3000` 就踩过，装上 APK 一点播放必崩。现在约束由 `PlaybackTuning.violations()` 表达（返回全部违规项而非撞第一条就抛），`PlaybackTuningTest` 守着当前参数合法、且拿历史坏值能复现违规；`Playback.build()` 里另有一道 `check` 兜底。
- `DefaultHttpDataSource.Factory`：固定 `Net.UA`、`connectTimeout 12s` / `readTimeout 20s`、`allowCrossProtocolRedirects`、`Accept-Encoding: identity`（避免拿到 gzip 的分片流）。OkHttp 无 CORS 概念，也不需要回环代理。
- `setHandleAudioBecomingNoisy(true)` 让拔耳机/切输出时自动暂停。
- **分片预取**：`PlayerScreen` 在 `prepare()` 之前先调 `SegmentPrefetch.start(url)`，后台解析 m3u8 并把开头 8 个分片抓进内存（`SegmentLru`，**32MB 上限、单条 4MB 上限**、LRU 淘汰、并发 3）。播放器的数据源换成 `PrefetchAwareDataSource`——它在发起 HTTP 之前先查这份缓存，命中就直接把字节喂给 ExoPlayer，没命中再原样交给 `DefaultHttpDataSource`。**两条路径必须接上，否则预取只是白跑一遍网络**。
  - HLS 走的是手工构造的 `HlsMediaSource`（为了挂 `AdFilteringPlaylistParserFactory`），它自带数据源工厂、会**绕开** `Playback.build()` 里的 `setMediaSourceFactory(...)`。所以这里必须显式写 `Playback.prefetchingDataSourceFactory()`——用成裸 `dataSourceFactory()` 的话预取 100% 失效，反而让每个分片多下一次。
  - 只对 `position == 0` **且** `length == LENGTH_UNSET` 的整段请求走缓存。`#EXT-X-BYTERANGE` 从 0 开始但要有限长度，命中后整段喂出去会让调用方按错边界切字节（帧边界错乱）。
  - 预取必须先 `AdFilter.strip(...)` 再取分片，并与播放侧用同一个 `adFilter` 开关：被摘掉的广告段播放器永远不会请求，照原样预取等于白下几 MB、还挤占并发闸门与配额。
  - 基准地址要用**跟随重定向之后的最终 URL**（`Net.getTextWithUrl`）：CDN 常把 m3u8 302 到另一个目录，用入口地址拼相对分片会全部 404，而现象只有"预取毫无效果"，几乎不可能靠现象发现。
  - 缓存要在 `PlayerScreen` 卸载时与 `Application.onTrimMemory`/`onLowMemory` 时清空：32MB 的 `ByteArray` 对 heap 常见只有 192MB 的盒子不是小数目。
  - 桌面端同理（见「播放性能与失败转移」的 `/prefetch`）。

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

### 分类结果缓存（5 分钟）

分类之间来回切换是最常见的操作，而一次分类浏览要打「每源 1 次分类表 + 每源最多 6 个子分类」，即 4 个源约 24 个请求。用户反馈「每次切分类都像在重新加载一遍播放源」，指的就是这个。

因此 `browseCategory` 与 TV 端 `Repository.browseCategory` 都对**第一页结果**做了 5 分钟内存缓存：

- 只缓存 `pages === 1`：翻页是有意的追加动作，缓存住反而看不到新内容；
- 键包含分类、成人过滤开关、`typeLimit` 与源地址集合，换源 / 切过滤自然失效；
- 被 `AbortSignal` 取消的结果**不写缓存**，否则下次切回来看到的是半截列表；
- TV 端只缓存 `supported == true` 的结论——失败的源下次还要重试，缓存失败会让它一直显示「失败」。

### TV：焦点移上去就切换并加载

桌面端分类页靠点击切换，TV 端原本也必须按一次 OK。现在**分类胶囊和顶部导航都加了「焦点即切换」**：遥控器一路划过去，页面内容和当前页就跟着换。

分类行的实现（`CategoryScreen` 的 `onFocusChange` + `AppViewModel.previewCategory`）：

- 只在 `screen is Screen.Category` 时生效——首页分类行复用同一张卡片，那里应当按 OK 才进页面；
- 防抖 **70ms**：遥控器连按时一次移动只发一轮请求，又短到用户感觉不到延迟；
- **不能校验「category.key 还是不是进入时的那个」**。曾经写过 `if (category.key != current.key) return`，本意是防止迟到的预载把页面拽回悬停项，实际效果是：先悬停 A（A 加载完，`category.key` 变成 A），再悬停 B 时 `current` 里的 key 是更早的值，判断成立 → B 直接放弃加载。表现就是「第一个分类能自动加载，之后都必须按 OK」。
- `LaunchedEffect(state.key)` 抢焦点只在**首次进入本页**时做一次（`focusRestored` 标记）；每次分类变化都抢一次的话，用户刚按 ↓ 进网格就会被拽回分类行。

导航栏的实现（`CastScreen.NavRail` 的 `onFocusChange` + `App.kt`）：

- 焦点落到某个导航项就 `vm.go(item.screen)`，不用按 OK；
- 但这引出第二个问题：各页面自己有「进入后把焦点抢到第一个可操作元素」的 `LaunchedEffect`（搜索页抢搜索框、首页抢第一个分类胶囊）。焦点刚进导航栏就被目标页拽走，走不到第二项。解法是 `AppViewModel.navFocusHold`：焦点进入导航项时置位，页面在抢焦点前先检查它；焦点离开导航项后给 **250ms 宽限**再解除——上一个项失焦和下一个项获焦之间有空档，立刻解除会让目标页趁空档抢走焦点。
- 1.3.1 起导航从**左侧竖列改成顶部横栏**（`Row`，76dp 高）：16:9 的电视上竖向导航白占 9% 宽度，横向空间本该留给海报。焦点移动方向也随变成 ←/→，顶栏右侧固定一个「投屏就绪 / 投屏接收」入口（原来只在首页 banner 里，banner 删掉后需要一个固定位置）。

实测（emulator-5556，1.3.1）：分类行连按两次 → 依次是「电视剧 128 部」→「综艺 4 个源有此分类」；导航栏连按 → 首页 → 搜索 → 直播 → 设置，焦点一路停在顶栏不被拽走。

### 分类目录与检索结果的本地缓存

用户反馈「每次切换分类、每次检索都像在重新加载播放源」。根源不是解析慢——实测 `parseM3u` 解析 3957 个频道只要 16ms——而是**一次分类浏览要打 4 个源 × 最多 4 个子分类**，冷启动 2~6 秒；`Repository.browseCache` 又只在内存里，进程一退就没了。

现在两端都把「每个分类的第一页」和「最近的检索结果」落盘，切分类/再搜同一片名时零网络：

| 层 | 桌面端 | TV 端 |
| --- | --- | --- |
| 纯逻辑（TTL、截断、签名、淘汰） | `packages/core/src/catalog.ts` | 同一份逻辑的 Kotlin 实现 `data/CatalogCache.kt`、`data/SearchCache.kt` |
| 落盘 | `localStorage`（`libretv-catalog-v1`、`libretv-search-cache-v1`） | DataStore（`catalog-cache`、`search-cache`，格式 `签名\tJSON`） |
| 适配层 | `lib/catalog-cache.ts` | `AppStore.catalog()` / `saveCatalog()` |

规则（两端逐条对齐，`packages/core/src/catalog.test.ts` 18 项 + `CatalogCacheTest.kt` 17 项覆盖）：

- **签名**：启用源地址排序拼接 + `|` + 成人过滤开关。源顺序变化不作废缓存，源集合或开关变化整体作废；
- **TTL**：目录 6 小时、检索 30 分钟，过期只是「该刷新了」，界面仍先用旧内容顶上（空页面比旧内容糟得多）；
- **刷新判据与 TTL 分开**：`staleCategories` 用 `CATALOG_REFRESH_MS`（1 小时）判，不用 6 小时 TTL——拿 TTL 去判会让每小时的定时刷新醒来 6 次、5 次空转，「每小时刷新」实际变成 6 小时一次；
- **条目上限**：每分类 240 条、每关键词 100 条、关键词最多留 12 个（按时间戳丢最旧）；
- **空结果不覆盖**：刷新失败或源临时抽风时写空会把已有内容清空，所以 `withEntry` 遇到空列表原样返回；空分类用 `markCatalogChecked` 只记时间不动内容，否则它永远不算新鲜，后台每小时都重打一轮；
- **没缓存过返回 `undefined` 而不是空数组**：界面要区分「还在加载（显示骨架）」与「确实没有（显示空态）」。

**上限为什么从 20×300 收到 12×100**：`localStorage` 按 UTF-16 计费，20 × 300 条实测占 **3.41MB**，加上目录的 1.09MB 共 4.5MB，逼近 Chromium 单源 10MB 配额（=5M 字符）。一旦写满，`writeJson` 会吞掉 `QuotaExceeded` 导致目录永远停在旧值；更麻烦的是 zustand persist 的 `setItem` 没有 try/catch，`recordHistory` 会开始抛异常，播放进度链路直接断掉。所以桌面端 `lib/store.ts` 额外包了一层 `quotaSafeStorage`：写入失败时先清掉三个纯缓存键再重试，仍失败就只告警——**宁可丢缓存，也不能让观看记录写不进去**。

实测（桌面端，4 内置源）：

| 场景 | 耗时 |
| --- | --- |
| 冷启动首次进电影分类 | 首屏内容 12 张骨架 → 319 部 |
| 切到电视剧再切回电影 | **182ms**（命中内存/落盘缓存） |
| 重启应用后进电影分类 | **42ms，257 部**（直接命中 localStorage） |
| 首次搜索 | 5034ms |
| 同词再搜 | 1926ms（先出缓存，网络结果覆盖） |

TV 端 DataStore 文件从 967 B 增长到 **333 KB**（两个分类各 240 条），冷启动 8.7 秒后首页内容行已经出现「14 部 / 查看全部」。

#### 启动预热与每小时刷新

用户要求「程序启动时自动拉取刷新播放源数据，后台每小时自动拉取一次并更新缓存」：

- 桌面端 `lib/catalog-warmer.ts`：`startCatalogWarmup()` 在 `initBridge()` 之后调用，延迟 1.5 秒（让 Hero / 继续观看先渲染完）再抓，之后 `setInterval(CATALOG_REFRESH_MS)`；`stopCatalogWarmup()` 在 `App` 卸载时同时清掉 interval 和那一次 1.5 秒的 boot 定时器（原来只清 interval，卸载后仍会发出整批请求）；
- TV 端 `AppViewModel.init` 里一条 `while (true) { refreshCatalog(); delay(REFRESH_INTERVAL_MS) }`；
- 只抓**没缓存过或已过期**的分类（`staleCategories` / `missingCategories`），命中缓存的不重复请求；
- 目标分类**不能靠「已有缓存」反推**：桌面端曾用「首启只抓电影 + 电视剧，其余靠已有缓存判断」的写法，结果首启只写进这两个，另外 6 个永远判不出「缺」，与 TV 端遍历全部 8 个的行为漂移。现在固定遍历 `HOME_CATEGORIES`，只有「一条缓存都没有」时才退回先抓两个；
- 并发度刻意压到 2（桌面）而不是全开：预热不该和用户主动点击抢带宽；
- 预热失败一律吞掉：用户点进分类时页面自己还会再拉一次；
- TV 端目录落盘有 500ms 合并窗口（`CATALOG_SAVE_DEBOUNCE_MS`）：一轮刷新会逐分类写 8 次、每份序列化约 557KB，DataStore 又是整文件重写，不合并就是九次连续大文件写，和播放抢磁盘。

#### 分类浏览边收边渲染

`typeLimit` 默认值从 6 降到 **4**：实测 `typeLimit=6` 要 6577ms / 459 部，`=4` 只要 3847ms / 300 部——少抓两个子分类省下近 3 秒，而首屏本来也看不完 460 部。

再进一步，`browseCategory` 新增 `onPartial(items, outcomes)` 回调：4 源 × 4 子分类共 16 个请求全回来要 3~6 秒，而第一个源通常 1~3 秒就有内容。回调给的是**已合并、去重、过滤过的完整快照**，UI 直接整体替换即可——不让调用方自己做增量合并，那正是最容易出错的地方（去重、成人过滤、分组顺序都要重算一遍）。

实现上有个必须守住的点：`done` 数组按**完成顺序**累积，但最终 `collected` 必须按**源声明顺序**还原，写成 `uniqueSources.map((_, i) => uniqueCollected[i])`。早期用 `Map<sourceKey, entry>` 回查，一旦两个源撞 key（用户导入的源完全可能）就会把多个源折叠成一条，内容无声丢失。

实测：首个增量 3253ms / 60 部，最终 5314ms / 300 部。桌面端接入后，用户点分类约 **0.8 秒**就能看到第一屏内容。

#### 别拿「空列表」当省略号

TV 端 `CatalogSnapshot.itemsOf()` 对没缓存过的分类返回 `null`（Kotlin 的 `List?`）、core 的 `catalogItems()` 返回 `undefined`。如果图省事返回空列表，`refreshHomeRows()` 会认为「所有分类都缓存过了但都是空的」，首页内容流永远不渲染——而真正的空态和加载态也没法区分。

### 并发闸门：别把采集站打挂

用户报过「竟然没有电影分类？8 个源失败」，而内置源只有 4 个。两个原因叠在一起：

1. **源被重复写入**：`seedDefaults` 只按 flag 幂等，不按 URL 去重，被调用两次就变成 8 条同样的源；
2. **没有总闸门**：分类浏览是「每源 × 每分类」的笛卡尔积。实测「预热 movie+tv」与「用户点 documentary」同时发生时，4 个源发出了 **45 个请求、峰值并发 33**，耗时 5125ms。采集站对这种流量一律回 503 或直接断连——于是**所有源同时失败，分类渲染成空**，看起来像「这个站没有电影分类」。

这条坑值得单独记：**「全部源失败」在界面上和「这个分类真的没内容」长得一样**，而前者的诱因往往是客户端自己打太猛。

修法三层：

- `packages/core/src/limiter.ts`：`createLimiter(n)` 是信号量 + 队列（`size` 反映「执行中 + 排队中」，用 `Object.defineProperty` 定义 getter——`Object.assign` 会在赋值那一刻求值 getter，把 `size` 固化成 0）。`catalogLimiter = createLimiter(6)` 是全局总闸，`sourceLimiter(key) = createLimiter(3)` 是**每个源**各自的闸；两层叠加，单个站最多 3 个并发，所有站合计最多 6 个。TV 端同语义的 `Net.gated(host) { ... }`。
- **同地址源只打一次**：`browseCategory` 在 `Promise.all` 之前按 `source.url` 分组，重复的源不请求，直接产出一条 `ok: true, supported: false, error: "与「X」重复，已跳过"`。实测 8 条重复源：不同地址去重让魔都从 503 变成功，结果从 340 部涨到 460 部。
- **存储层去重**：桌面 `store.dedupeSources()` 与 TV `AppViewModel.dedupeStoredSources()` 在启动时按 URL 合并 `sources`/`liveSources`，并重建 `selectedKeys`（**只去重 sources 不够**，`selectedKeys` 里也会堆重复的 key）。

最后，失败原因必须显示出来。undici 在 DNS/TLS/重置时统一抛 `TypeError: fetch failed`，真因在 `err.cause.code` 里；`apps/desktop/src/main/index.ts` 的 `describeFetchError()` 把它映射成「域名解析失败 / 连接被拒绝 / 连接超时 / 证书校验失败」等中文短语，分类页的 hint 与空态都会带上（`HTTP 503×2`、`连接超时`）。同时区分两种空态：**「所有源都没能返回内容」**（该重试或检查网络）与**「这个分类暂时没有内容」**（该换个分类），混用会把用户引到错误方向。

### 首页只显示有内容的分类

「少儿」这类分类在部分源里一条内容都没有，入口点进去只能是空页面。因此 `probeCategories` 会在首页挂载时并发探测 8 个分类的可用性：

- 每个分类只抓 1 页、每源最多 1 个子分类（`typeLimit: 1`），4 个源约 32 个请求；
- 结果按 `min(源地址集合, 分类集合, 过滤开关)` 做键缓存 **10 分钟**，避免每次回首页都重探；
- 被 `AbortSignal` 取消的探测不写缓存，防止把「全空」结论固化；
- 探测整体失败（网络全挂）时**退回显示全部入口**，不能因为探测失败就把导航藏空；
- 成人过滤在此同样生效——唯一一条内容是成人内容时，该分类算作空。

探测要 6~10 秒，如果每次都等它回来再渲染，首页会出现「先显示 8 个、几秒后少一个」的跳动。所以结论按「源签名」落盘：桌面端存 `localStorage`（`libretv-category-availability-v1`），TV 端存 DataStore（`category-availability`，格式 `签名\tkey1,key2`）。下次启动先按上次结论渲染，后台探测回来再覆盖；签名变化（换了源、切了成人过滤）时旧结论自动失效。

实测（4 内置源，2026-10）：电影 ✅ 2 源、电视剧 ✅ 3 源、综艺 ✅ 3、动漫 ✅ 3、纪录片 ✅ 3、短剧 ✅ 3、体育 ✅ 2、**少儿 ❌ 0 源**，耗时约 6.8 秒。

### 分类桶要认真实站点的切法

`CATEGORY_BUCKETS` 最初按「父级聚合名」写关键词（`港台剧`、`日韩剧`、`短剧`、`体育赛事`），但真实采集站并不这么给：

- 电影天堂/如意/360 把「香港剧、台湾剧、日本剧、泰国剧」当成挂在「连续剧」下的**独立子分类**，名字里没有「剧」以外的任何线索；
- 极速/红牛把「古装仙侠、现代都市、反转爽剧、AI漫剧」挂在「短剧」下，另外还有「台球、斯诺克、NBA」这类赛事名——百度资源甚至把这些题材名做成了**独立顶级分类**（没有父分类可继承）；
- 这些分类既不会进「电视剧/短剧/体育」桶（名字对不上关键词），也不会被展示（归 other）——用户看到的就是「分类里有内容，但点电视剧只有 100 部」。

`tools/audit/unmapped-content.ts` 用**分集中位数**反推内容类型（电影恒为 1、剧集 20+、单集短剧为 1 但片长明显更短），确认了这些题材名确实属于对应桶，然后：

- 关键词表补齐地区剧（`香港剧/台湾剧/韩国剧/日本剧/泰国剧/港澳剧/大陆剧/内地剧/其他剧`）、赛事（`台球/网球/斯诺克/NBA`）、短剧题材（`古装仙侠/现代都市/反转爽剧/AI漫剧/…`）；
- 新增 `bucketOf(category, byId)`：**名字判得出桶就用名字，判不出再逐级继承父分类**（带 `seen` 防环）。名字优先是关键——「记录片」挂在「电影片」下，它必须是纪录片；
- `BUCKET_INHERIT_BLOCKLIST` 拦住 `未分类/其他/其它/预告片/花絮/待定`：这些兜底分类不能因为父级是「电影」就混进正经桶。

实测 8 源 × 8 分类（`tools/audit/bucket-coverage.ts`）：**「电视剧」从 113 部变 300 部、「短剧」221 部、「体育」200 部**，8 个源全部能对上前 8 个分类（仅「少儿」仍是 0）。这个缺陷在原来 4 个源上就存在（360 资源同样有 `14=香港剧`），不是新源引入的。

#### 不能拿「源还没到」当作「探测结论是空」

TV 端曾经有个只在真机才暴露的竞态：冷启动后首页分类区一直显示「所选源暂未返回任何分类内容」，而同一页的「4/4 启用点播源」却是对的。源加载没问题，坏在探测的时序。

`AppViewModel` 的 `data` 是 `seedIfNeeded()` 之后异步 `collect` 出来的，首帧组合时 `activeSources()` 还是空数组。旧代码在这个分支里写下 `availableCategories = emptyList()` 再返回——等于把「还没探测」记录成了「探测过、结论是无」，而触发探测的 `LaunchedEffect` 键是 `Unit`，源到位后不会重跑，首页就永久停在空态。

正确的写法是两件事一起做：

- 探测函数遇到空源**直接 return，不写任何结论**（`AppViewModel.probeCategories`），让 UI 继续停在「正在识别可用分类…」；
- 触发键改成**源签名**而非 `Unit`：`remember(data.sources, data.selected, data.settings.adultFilter)` 算出 `签名 = 启用的源 key 排序后拼接 + "|" + adultFilter`，`LaunchedEffect(签名)` 一到位就重探（TV 端 `HomeScreen.CategoryRow`）。

同一个坑在空态文案上也要区分开：`available == null` 是「还在识别」，`emptyList()` 才是「确实没有」。两者显示同一句话，用户和后续排错的人都分不清。

桌面端还要再细分一层：`CategoryButtons` 先判断 `sources.length === 0`（一个源都没加）与「源都在但全被停用」，这两种都**不是**「源没有这个分类」，各自给出去设置页的引导，只有真正探测出空结果才说「暂未返回任何分类内容」。

### 首页横幅的布局

首页顶部的 `.hero`（TV 是 `HomeScreen.HomeHero`）原先是「标题 / 说明 / 按钮行 / 统计」四段竖排，桌面端实测 204px 高、TV 端写死 232dp——在一个 823px 高、540dp 设计高度的窗口里分别占掉 25% 与 43%，正下方最该被看到的分类入口反而要滚一屏。

改成左右两栏后高度降到桌面 92px / TV 152dp：

- 左栏 `hero-copy` 只说清这是什么（一句话，窄窗口下自动换行到两行）；
- 右栏 `hero-actions` 放按钮与统计，`margin-left: auto` 右贴，统计之间用 `border-left` 分隔；
- 两栏用 `flex-wrap: wrap` 兜底：窗口窄到 1024px（`BrowserWindow.minWidth`）时右栏整体换到下一行，高度回到 113px，不会把文字挤成竖排。

**TV 端不是把桌面 CSS 搬过去**：Compose 里是 `Row` + 左 `Column(weight(1f))` + 右 `Column(horizontalAlignment = End)`，横幅高度由 `.height(152.dp)` 固定而非内容撑开。电视是 10 尺屏，右栏按钮与统计两行必须在 540dp 设计高内放得下，所以统计标签缩短为「点播源 / 直播源 / 记录」而不是「启用点播源…」。改完先首屏就能同时看到横幅与分类行，遥控器焦点序列仍是「开始搜索 → 分类行 → 数据源卡」。

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
  history: HistoryEntry[]          // 按片名去重置顶，上限 200 / 100
  favorites: FavoriteEntry[]
  liveFavorites: LiveFavoriteEntry[]
  defaultsSeeded: boolean          // TV 端为 seeded
  defaultsVersion: number          // 内置源清单版本，< DEFAULTS_VERSION 时补源
  removedDefaultUrls: string[]     // 用户删过的内置源，升级补源时跳过
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

### 拼音首字母检索（TV）

遥控器在电视上敲中文很痛苦，所以搜索框同时接受拼音首字母：qmmk → 「奇妙萌可」。

采集站的 wd 只支持中文 LIKE，所以拼音只能在本地做，前提是有一张「汉字 → 首字母」表：

- 表由 	ools/gen-pinyin-table.mjs 用 pinyin-pro 离线生成，覆盖 U+4E00..U+9FFF 共 20992 个码位，生僻字记 ?；
- 两端共用同一份数据，形状不同：TS 侧是 packages/core/src/pinyin-table.ts，Kotlin 侧是 pps/androidtv/app/src/main/assets/pinyin-table.txt（启动时 Pinyin.install 读入）；
- 匹配只认**连续命中**（initials.includes(query)），不做跳字母匹配——qmx 在 qmmkzsyxl 里出现过，放行它噪声太大。

**索引从哪来**：采集站无法按拼音查询，只能拿「已经见过的片名」反查。

1. 本次会话搜索 / 分类浏览过的条目（Repository.seenItems）；
2. 落盘的索引（AppStore 的 pinyin-index，上限 6000 条，攒够 80 条增量写一次）——这是第二次开机仍能命中的原因；
3. 各源「最新列表」（?ac=videolist&pg=n，不带 wd/），1.3.2 起最多翻 24 页，30 秒预算；
4. 启动后台**预热**：索引不足 3000 条时，每源抓 20 页（60 秒预算）补进索引并持久化，每页都进索引（取消也不丢进度）；用户一开始检索就 `warmJob?.cancel()` 让路。

**在线扫描的并发策略（1.3.2，两次踩坑换来的）**：

- 别按「页码」推进（先扫所有源第 1 页，再一起扫第 2 页）：每轮都要等最慢的那个源，而列表里有源会挂到超时。实测 AVD 上**一轮恰好 8 秒**，40 秒预算只够翻 4 页。
- 也别「每源串行往下翻」：串行时每页都要付一次完整 TTFB（ffzyapi 实测 2.3 s/页），「师兄啊师兄」在第 11 页 → 26 秒，超预算。
- 现在用**源内滑动窗口并发**（`PINYIN_WINDOW = 5` 页一起抓，命中即停）+ **扫描专用限流**（`PINYIN_CONCURRENCY = 12` 的 `Semaphore`），**不走 `Net.gated`**：那个全局 `Semaphore(6)` 是 FIFO 公平的，启动时目录刷新先排上几十个请求，用户的检索排在队尾，实测 45 秒连第一页都翻不完。
- 窗口并发后宿主实测：翻到第 11 页命中「师兄啊师兄」用时 **14 秒**（串行 26 秒）。
- 扫描期间 `onProgress` 每翻完一个窗口回调一次，界面显示「拼音「sxa」· 已翻到第 N 页」，不让用户对着 0 条干等。

排查提示：拼音表本身不用怀疑（真实 assets 表 20992 字符、`initials("奇妙萌可")=="qmmk"`，`RealPinyinTableTest` 用真实表断言）。「搜什么都 0 条」的真因一直是**索引覆盖太窄 + 扫描深度不够**，不是表或匹配逻辑坏了。

另：**模拟器不适合验证拼音检索**。AVD 经 QEMU NAT + 宿主 TUN，实测普通中文搜索里「非凡资源/魔都资源/360 资源/百度资源」全部超时、只有「电影天堂」能返回，而 ffzyapi 在宿主上 2.3 s/页正常。判断这类问题要用宿主 curl 对齐同一份数据。

### 播放列表广告过滤

采集站把中插广告做成同一份 m3u8 里的一段：#EXT-X-DISCONTINUITY 包住 4~5 个分片、约 18~22 秒，与正片同域。实测 4 个内置源各采样 8 份播放列表：**8/8 有 DISCONTINUITY 分组、0/8 换域名**，现有规则一共摘掉 207 秒。

两端实现不同：

- **桌面**：回环代理改写 m3u8 文本（packages/core/src/ad-filter.ts），因为所有分片本来就要过代理；
- **TV**：Media3 直连源站，没有代理层，于是替换播放列表解析器——AdFilteringPlaylistParserFactory 把整份文本读出来、交给 data/AdFilter.kt 摘掉广告分组，再交给官方 HlsPlaylistParser。注意 Media3 1.5 里这个接口返回的是 ParsingLoadable.Parser<HlsPlaylist>，主列表类型叫 HlsMultivariantPlaylist（不是 HlsMasterPlaylist），照旧名字写会编译不过。

判定必须靠**分段时长 + 相邻段长度**，不能靠 URL：三体第一季 的播放列表被切成 161 组、每组 5 片约 20 秒，只看「短分组」会把整部片删光，所以要求前后相邻组都 ≥120 秒。

**滤不掉的情况**：广告被压进正片分片里（贴片）、或源站自己的播放器插的广告。这两类换源才有效，README 的已知限制里写明。

### 暂停不算卡死

卡死看门狗（`STALL_MS`）只在**真正播放中**才有意义：

- `onWaiting` 先判 `video.paused` 直接返回——暂停状态下拖进度条、浏览器回收缓冲都会派发 `waiting`，按卡死处理就会「暂停 12 秒后自动换源」；
- `onPause` / `onEnded` 必须显式 `clearStall()`——这两个事件之后不会再有 `playing` 来复位定时器，不清就是定时炸弹。

同一类问题还有「换源并发」：看门狗、hls 致命错误、手动 `S` 三处都能触发 `failover`，各自挑一个候选、互相覆盖 `active/episodes`，还会同时建两个 Hls 实例。桌面端用一个 `failoverRef` 做单飞，TV 端则用「`attempted` 集合 + 先记账再请求」保证每个候选只试一次（否则详情拉不到的候选会被无限重试，播放页永远停在「正在切换片源」）。

### 一看完就得把进度清零

`onEnded` 写历史时不能传 `position = 0` 了事：写入路径有「位置 ≤ 0 视为无效」的守卫，那样这一集永远记不成「已看完」，首页进度条恒为 100%，「继续观看」永远从 0 开始。正确做法是走 `persistProgress(..., finished = true)`：位置写 0、集数推到下一集。

### 集号必须只有一份真相

用户报过「点继续观看第 15 集，结果播的是第 2 集」，根因是集号有三套互不相干的口径：

1. **历史记录里的 `episodeIndex`**——只对写入它的那个采集源成立。同一部剧在非凡/量子/魔都/360 的集数就不一样（实测《盲眼驭诡师》是 17/17/16/16），跨源续播的下标必然错位；
2. **`episodeLabel` 原本从 URL 里抠数字**——采集站地址形如 `https://vod1.maowushi.com/20261026/6jTWq7rf/index.m3u8`，抠出来的是日期和随机串，与数组下标毫无关系；
3. **详情页按钮文案**曾经读 `resume.episodeIndex`，而点击时执行的是 `startIndex: episodeIndex`（用户刚点的那一格）——两处脱钩，于是按钮写着「继续播放 · 第 16 集」、点下去却从第 2 集开始。

现在统一为：`clampEpisodeIndex(index, length)` 是唯一的下标兜底（`packages/core/src/format.ts`，TV 侧对应 `HistoryDedupe.clampEpisodeIndex`），`episodeLabel(index)` 只认下标，`normalizeHistoryEntry` 在读取时把老记录里越界的下标收回来（「看完最后一集」曾把下标写成 `episodeCount`，首页于是显示「第 17 / 16 集」）。**跨源续播靠夹紧，不靠对齐集号**——这是唯一在数据不可靠时仍然正确的做法。

### 「点了没反应」要能看见

首页「继续观看」的卡片曾经只是 `disabled`：取详情要串两次请求（`?ac=videolist&ids=` 失败再爬 `/index.php/vod/detail/id/{id}.html`），最长约 20 秒，期间卡片既不转圈也不改字，用户只会判定点击没生效。现在的做法是：

- 卡片给 `card loading` 类 + `.card-busy` 遮罩（转圈），徽章与 `title` 变成「正在打开…」；
- 进行中的 id 记在 `openingRef`（`Set`）里而不是 `disabled`，同一张重复点直接忽略，不同卡片互不影响；
- 完成时只从集合里删掉**自己那条**——同时点开两张卡时，先返回的那张不能把后一张的转圈一起抹掉。

### 直播列表里死链很常见，别让人干等

iptv 列表的特性：频道地址随时会挂，且很多挂掉的地址返回的是 **HTTP 200 + HTML 错误页**，不是 404。这种响应下 hls.js 解析失败后既不触发 `playing`，也不一定抛 `fatal`，界面就永远停在「正在连接直播流…」——实测 Collect-IPTV 的「云南卫视」就是这种情况（返回 `<!DOCTYPE html>`，等 45 秒也没动静）。

两端各补了两道闸：

- **换台死线**：起播后 20 秒仍无画面（`video.readyState < 2` / ExoPlayer 未到 `STATE_READY`）就直接显示「这个频道 20 秒内没有出画面，可能已下线或被地区限制」，用户看到提示就知道该按 `↓` 换台；
- **错误浮层要能自己消失**：`playing` / `STATE_READY` 时清空 `error`。hls.js 对直播流会把「某一分片 404」判成 fatal，外层 `startLoad()` 往往立刻恢复——如果不清，错误浮层会一直盖在正常画面上，用户看到「黑屏 + 加载失败」，实际后台在播。

另外 hls.js 的 fatal 错误先自救 2 次（`MAX_RECOVERY`，网络类走 `startLoad()`、媒体类走 `recoverMediaError()`）才把错误显示出来，因为直播流的「致命错误」绝大多数是临时抖动。

### 内置源清单要能升级

`defaults/sources.json` 里的 `version` 不只是文档信息：两端都把它持久化成 `defaultsVersion`，并记一份 `removedDefaultUrls`。

- 只靠 `defaultsSeeded` 布尔量是不够的——老用户早就 seeded 过一次，之后新增的内置源永远进不来；
- 升级路径与首次启动共用同一段逻辑：只补「本地没有的 url」，因此重复执行安全；
- **用户删掉过的内置源不会被加回来**：否则「我不想要这个站」会变成「每次升级都复活一次」。恢复默认源时才会把它从删除名单里移除。

### 内置源的可达性要看「用户在哪」

同一个源在不同出口 IP 下的结论可能完全相反，所以内置源清单不能只按一次实测来定：

| 源 | 东京 IP（AWS） | 湖南联通 |
| --- | --- | --- |
| 暴风资源 | 3/3 分片全 404，页面写「请使用中国大陆网络访问」 | **3/3 可播**（列表 1.2–1.9s，分片 1.0–1.8s） |
| 如意资源 | 3/3 可播 | **0/4，TLS 握手被重置**（DNS 正常、TCP 能连、`secureConnect` 前收到 RST） |
| 百度资源 | 3/3 可播 | 3/4（偶发 `请求超时`） |

排查结论值得记一笔：如意资源不是「源挂了」，`Resolve-DnsName` 正常、`Test-NetConnection 23.224.68.246 -Port 443` 成功、用 `servername: 'www.example.com'` 连能拿到 `CERT_HAS_EXPIRED`——说明 TCP 通、SNI 不同就不重置，是**按域名做的连接重置**（典型地区封锁特征）。所以它留在清单里但排在最后，用户在国内会看到「连接被重置」，海外用户正常。

暴风和百度因此被加入清单（`version` 3）。同时把「地区限制」和「源失效」在文案上区分开：前者是目标站明确拒绝，后者是拿不到地址。

## 数据安全

### 磁盘上的快照要能失败

`AppStore.decode` 解析失败时**绝不能**退化成 `AppData()` 继续跑：`update` 是「读改写」，一旦读出来是空对象，下一次任何写入（存进度、收藏）都会把源、历史、收藏整份原子清空。现在的策略是：

- 解析失败时把原始字符串备份到 `app-data-corrupt`，本次写入直接放弃（`update` 返回 false）；
- 界面用「最近一次成功解析的快照」顶着，不会瞬间变空；
- 收集 `store.data` 的协程遇到 IO 异常会退避重订阅，而不是 `catch { emit(AppData()) }` 之后整条流结束（那样 `_data` 会永久冻结）。

## 已知限制

- 直连会向采集站暴露用户 IP（上游用服务端规避）；
- Android TV 暂无 HLS 广告过滤、画质探测、EPG 展示；
- DLNA 接收端只实现控制类动作，未实现 GENA 事件订阅（部分手机依赖事件回调刷新进度，可能显示 0:00）；
- 投屏不支持受 DRM 保护的流；
- 桌面端 `http:fetch` 没有取消通道：切走搜索/分类时渲染层会立刻放弃等待，但主进程那边仍会把响应读完（省下的是交互等待，不是流量）；
- `packages/core/src/live.ts` 的 EPG 仍是「按需拉整份 XMLTV」，超大列表在 IPC 16MB 上限下会直接放弃展示节目单。
