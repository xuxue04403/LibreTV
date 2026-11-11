# 双端学习管控与手机端规划（暂缓实施）

> 状态：**已评估、方案已定、暂不实施**（2026-11-08）。
> 触发原因：用户希望把 StudyOnTV 的“答题才能看”能力引入 LibreXTV，并新增 Android 手机版（含播放、直播、投屏、TV 管控）。
> 本文只记录方案与结论，仓库代码未做任何改动。

## 1. 结论摘要

- **可行，且许可允许**：StudyOnTV 为 *Source Available, Personal Use Only*，允许个人/家庭自用、修改、编译；禁止再分发、商用、借用品牌。LibreXTV 仅自用、不发布、仓库无 remote，因此可直接移植其“学习闸门”子系统（**前提是永不对外分发**）。
- **不整体搬迁**：只搬学习引擎、题库、SQLite、答题/管理 Web 页与局域网服务；丢弃跨应用管控（无障碍、悬浮窗、前台轮询、看门狗、自更新、Bugly/Pgyer/analytics）。
- **双端产品**：TV 与手机各自带本地学习引擎；手机额外作为 TV 的管控端；两端数据独立、不同步。
- **工期**：完整 9–11 周；MVP（TV 闸门 + 手机点播/控制/投屏）约 6–7 周。

## 2. 目标形态

| 能力 | TV 端 | 手机端 |
|---|---|---|
| 点播 / 直播 / 搜索 / 分类 | 保留现有 | 重写触屏 UI |
| 学习闸门（答题解锁） | 本地引擎，规则可由手机远程修改 | 本地引擎，规则本机设置（家长 PIN 保护） |
| 家长设置入口 | 本机 PIN（兜底） | 本机 PIN；另可管理多台 TV |
| 管控 TV | 提供局域网 API（被控端） | 发现 / 配对 / 改规则 / 看记录 / 解锁 |
| 投屏 | 接收端（已有 DLNA 基础，新增自有协议） | 发送端：选片 → 推到 TV 播放 |
| 数据 | 题库 / 规则 / 记录在 TV 本地 | 题库 / 规则 / 记录在手机本地；不复制 TV 数据 |

## 3. 许可与合规

- 自用范围：不发布源码/APK、不商用、不借用「题了个题 / StudyOnTV」名称与 logo。
- 移植代码集中放在独立包（建议 `org.librextv.tv.study` / 共享模块），便于未来若公开发布时整体移除。
- 保留第三方资源许可：KaTeX（MIT）、qrcode（保留 notice）、React 管理页（保留 `notices`）。
- 删除：`BuglyInit`、`CrashDetector`、`Pgyer`、`analytics.js`、自更新相关（`Updater`/`UpdateActivity`/`ApkInstaller`/`ApkProvider`）。

## 4. 架构

```
apps/android/
├─ app/
│  ├─ src/main/   共享：Repository / Parsers / AppStore / Net / Subscriptions /
│  │              PlaybackTuning / Pinyin / DLNA / 学习引擎 / SQLite / LanServer
│  ├─ src/tv/     TV UI（现有 Compose + FocusPolicy）
│  └─ src/phone/  手机 UI（新写：底部导航、竖屏、手势、PiP）
└─ flavors: tv (org.librextv.tv) / phone (org.librextv.phone)
```

- 学习引擎（`LearningEngine`/`LocalStore`/`GradingService`/`HolidayService`）在共享层，两端各自实例化。
- `LanServer` 两端都带：TV 绑 `0.0.0.0:8099`（供手机连接），手机只绑 `127.0.0.1`（本机 WebView 管理页用，不暴露局域网）。
- 手机控制 TV 复用同一套 `/api/*`：发现 → 配对 → 读状态 → 改规则/题库 → 解锁。
- 手机只展示 TV 返回的 `status`，规则计算始终在被控端，避免两端算法漂移。

## 5. 移植清单（来自 `.tmp-studyontv`，本地克隆已 gitignore）

保留并改包名：

- `app/native/app/src/main/java/com/studyontv/tv/LocalStore.kt`（SQLite：questions / kv / events / reviews / progress）
- `LearningEngine.kt`（时段、额度、组、加练池、状态）
- `HolidayService.kt` + `assets/holidays/2026.json`
- `AdminAuth.kt`、`IntegrationAuth.kt`
- `LanServer.kt`（`/api/*`、静态页、二维码页）
- `app/web/**`（index.html、tv.css、app.js、qrcode.min.js；删除 analytics.js）
- `InputSupport.kt`、`TvTextInputActivity.kt`、`AnswerInput.kt`
- `DeviceRuntime.kt`、`Prefs.kt`、`Diag.kt`、`TvUi.kt`、`WebShell.kt`、`RemoteKeys.kt`
- `GradingService.kt`（可选，默认关闭）

不搬：

- `GateService.kt`、`Watchdog.kt`、`WatchAccessibilityService.kt`、`GateOverlay.kt`、`BootReceiver.kt`、`UninstallGuard.kt`、`DeviceBridge.kt`
- `ApkInstaller/ApkProvider/Updater/UpdateActivity/Pgyer.kt`、`BuglyInit/CrashDetector`
- `MainActivity/OnboardingActivity/ParentActivity`（其自有壳）

## 6. 闸门接入点（TV）

| 位置 | 改动 |
|---|---|
| `LibreXtvApp.kt` | 初始化学习子系统（SQLite、规则、`LanServer`），仅“学习模式”开启时启动 |
| `MainActivity` / `ui/App.kt` | 新增 `GateActivity`（`exported=false`，全屏 WebView 加载 `#/quiz` 或 `#/lock`） |
| `ui/PlayerScreen.kt` | 起播前查 status；播放中 1s ticker 扣时；锁定则暂停并跳闸门，解锁返回续播 |
| `ui/SettingsScreen.kt` | 「学习模式」入口：开关、PIN、配对码/二维码、管理页地址 |
| 权限 | 不新增；不申请无障碍/悬浮窗/使用统计/设备管理员 |

补充：

- TV 加**可选前台服务**（常驻通知“学习管控运行中”），保证手机随时可连；设置里可关。
- 老电视 WebView 黑屏兜底（`LAYER_TYPE_SOFTWARE`）保留。
- 播放器同进程暂停即可，不需要 `MediaPause` 的音频焦点/静音兜底。

## 7. 手机端 UI 范围

| 页面 | 形态 |
|---|---|
| 首页 | 底部导航（首页/搜索/直播/我的）；继续观看横滑、推荐双列、收藏入口 |
| 搜索 | 键盘输入、历史下拉、结果双列、上拉加载 |
| 分类 | 顶部 Tab + 双列网格、下拉刷新 |
| 详情 | 全屏页；选集横滑；源切换底部弹窗；投屏按钮 |
| 播放 | 横屏全屏；手势（左右进度、上下音量/亮度）、双击暂停、锁屏、PiP、MediaSession |
| 直播 | 分组频道列表 + 横屏播放 |
| 我的/设置 | 播放设置、学习管控（本机）、设备管理（TV 列表）、关于 |
| 学习 | 答题页（Compose）；家长区 PIN 后进入规则、题库入口、记录 |
| 管控 TV | 设备卡片（在线/剩余时长/今日已答）、一键解锁/锁定、规则编辑、内嵌 Web 管理页 |

手机题库/批改等重表单使用内嵌 Web 管理页，不原生重写。

## 8. 投屏（先自有协议，DLNA 二期）

1. 手机 NSD/SSDP 发现 TV，配对保存 token。
2. `POST /api/cast`：`{sourceKey, vodId, episodeIndex, title, position?}`。
3. TV 用本地 Repository 解析该源该集，ExoPlayer 起播（带源配置与请求头，兼容 HLS/Referer/防盗链）。
4. 手机显示遥控器：播放/暂停/进度/音量/下一集（可选）。
5. 通用 DLNA 推 URL 给非 LibreXTV 电视放二期。

## 9. 鉴权与配对

- TV 设置页显示 6 位配对码 + 二维码（`http://ip:8099`）。
- 手机 `POST /api/pair` 换取长期 token；TV 存 SHA-256，手机存 EncryptedSharedPreferences。
- 管理 API 需 Bearer token；限流；连续失败锁定。
- 手机本机管理页仅监听回环地址，家长区仍需 PIN。

## 10. 里程碑

| 阶段 | 内容 | 工期 |
|---|---|---|
| P0 | 模块改造：抽 `src/main` 共享层，`tv` flavor 保持现有构建与测试全绿 | 4–5 天 |
| P1 | TV 闸门：学习引擎/LocalStore/LanServer/Web 答题页 + 播放器联动 + 设置入口 | 8–12 天 |
| P2 | 手机壳 + 点播/搜索/分类/详情/播放 MVP（触屏、横屏、手势） | 2–2.5 周 |
| P3 | 手机直播 + PiP/MediaSession | 1 周 |
| P4 | 手机本机学习闸门 + 家长 PIN + 内嵌管理页 | 1 周 |
| P5 | 管控 TV：发现/配对/状态/规则/记录/解锁 | 1.5 周 |
| P6 | 投屏发送端 + TV 接收 API + 遥控 | 1 周 |
| P7 | 打磨、真机/模拟器测试、文档、打包 | 1 周 |
| 合计 | | 约 9–11 周 |

MVP 切割：P0 + P1 + P2 + P5 + P6 ≈ 6–7 周。

## 11. 风险

- 两套 UI 的长期维护：共享层必须“无设备假设”，TV 焦点逻辑不得下沉。
- TV 常驻服务：否则 TV 退出 App 后手机连不上。
- 投屏兼容：自有协议只对 LibreXTV TV 有效；外部电视 DLNA 是二期。
- 双份学习数据：UI 要明确当前编辑的是哪台设备。
- 测试成本：手机手势/横竖屏/PiP 需单独 Compose 测试，不能只靠 TV 的 Robolectric 焦点测试。
- 未来若公开发布：必须先移除所有 StudyOnTV 来源文件。

## 12. 已确定的默认决策

1. minSdk 统一 **26**（Android 8）；不再覆盖老设备。
2. 手机题库/批改用内嵌 Web 管理页。
3. 投屏先做自有协议，DLNA 通用投屏二期。
4. TV 端加可选前台服务。
5. 两个独立 APK，同签名：`org.librextv.tv` / `org.librextv.phone`。

## 13. 启动时的第一步（P0 checklist）

1. 建分支 `feat/android-dual`（或在 master 上短周期提交）。
2. 把 `apps/androidtv` 的数据层抽到 `src/main`，TV UI 移到 `src/tv`，新建 `src/phone` 占位。
3. 配置 `productFlavors { tv; phone }`，两个 applicationId，各自的 manifest/图标/启动 Activity。
4. 保持现有 TV 编译、`testDebugUnitTest`（168 tests）全绿；产物仍可 `assembleRelease`。
5. 再进入 P1（学习闸门移植）。
