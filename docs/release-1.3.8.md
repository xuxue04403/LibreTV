# 1.3.8 发布说明

本版新增 **Android 手机版** 与 **鸿蒙原生版（HarmonyOS NEXT）**，并顺带修正了内置源清单版本号在升级链路上的一处遗漏。

## 本版内容

| 变更 | 说明 |
| --- | --- |
| **新增 Android 手机版** | 与电视版同一套代码、独立 product flavor（`phone`），包名 `org.libretv.tv.phone`，可与电视版同机共存；竖屏触摸 UI、底部导航 |
| **新增鸿蒙原生版** | `apps/harmonyos`，ArkTS + ArkUI + `AVPlayer`，包名 `org.libretv.harmony`；**HarmonyOS 5 / NEXT 不再兼容 APK，必须有这一版** |
| 电视版改为 flavor 构建 | 源码拆成 `src/main`（共用）+ `src/tv`（界面/清单/Activity），产物名变为 `app-tv-*.apk`；包名与签名不变，**可覆盖升级旧版电视端** |
| 鸿蒙构建脚本 | `tools/harmony/gen-sign-material.cjs`（生成本地签名材料）+ `tools/harmony/build.ps1`（一键构建 HAP） |
| 文档 | `docs/build.md` 增加手机版 flavor 说明与鸿蒙端完整工具链、签名、安装、常见问题 |

## 四个端的分工

| 形态 | 包名 | 产物 | 适用设备 |
| --- | --- | --- | --- |
| 桌面端 | — | `LibreTV-Setup-1.3.8-x64.exe` 等 | Windows / macOS / Linux |
| Android TV | `org.libretv.tv` | `app-tv-release.apk`（2.7 MB） | 电视盒子、智能电视 |
| Android 手机 | `org.libretv.tv.phone` | `app-phone-release.apk`（2.7 MB） | Android 手机/平板 + **HarmonyOS 4.x 及更早的华为手机**（基于 AOSP，可直接装 APK） |
| 鸿蒙原生 | `org.libretv.harmony` | `entry-default-signed.hap`（780 KB） | **HarmonyOS 5 / NEXT**（纯血鸿蒙） |

## 手机版做了什么

不是把电视版简单拉伸，交互全部按触摸重做：

- **底部四栏导航**（首页 / 搜索 / 直播 / 设置），返回键沿用电视版的 `NavStack` 语义，进详情、进播放器后返回位置一致
- **首页**：继续观看（带进度条与集数）、分类入口、各分类横向片单、我的收藏、直播收藏、本机数据概览
- **搜索**：软键盘回车即搜，双列结果网格，各源结算情况用 Chip 横滑展示（哪个源超时、哪个源返回几条）
- **详情**：海报 + 简介 + 确实能用的同片其它源 + 四列选集网格，有历史时按钮直接是「继续播放 · 第 N 集」
- **播放器**：点击唤出/隐藏控件、可拖进度条（拖动结束会把目标位置夹到片尾前 1 秒，避免误触自动连播）、倍速、选集浮层；播放失败或卡顿 15 秒自动换源并提示「已切换到「某某源」」
- **直播**：分组与台名双重筛选、双列频道网格、收藏；播放页整屏复用**同一个** `ExoPlayer` 切台——每台新建实例会耗尽 MediaCodec 池
- **设置**：源管理（增删/启停/内置标记）、订阅导入、四个播放开关、清空历史、投屏接收状态

共用部分（`data/` 采集解析、`AppViewModel`、DLNA 接收端、主题与配色）与电视版完全一致，所以两边的换源、续播、拼音检索、成人过滤行为没有任何差异。

## 鸿蒙版做了什么

`apps/harmonyos` 是独立重写的原生工程，代码不复用，但逻辑逐条移植：

- `ets/data/`：HTTP（`@ohos.net.http`）、Apple CMS 搜索与详情解析、相关性与同名聚合、成人过滤、M3U 解析、内置源合并与本地存储（`preferences`）
- `ets/pages/`：首页 / 搜索 / 详情 / 直播 / 设置 / 播放 / 直播播放七个页面，配色与另外三端一致
- 播放器用 `AVPlayer` + `XComponent`（Surface 输出），同样有卡顿看门狗与自动换源
- 状态用单例 `appModel` + `AppStorage` 的 `vmVersion` 版本号驱动重绘

## 工具链（本版实打实踩出来的）

华为云公开镜像上的 `command-line-tools` **只有 Linux 版启动脚本、且不含 SDK**，所以这条路走不通。可用的组合是：

1. SDK 从 `os/7.0-Release/ohos-sdk-windows_linux-public.tar.gz`（3.2 GB）里取 Windows 五个组件，**拍平成 `<SDK_HOME>/HarmonyOS-NEXT2/openharmony/<组件>`**，并把其中三个以目录联接映射到 `hms/`（`hms/toolchains` 需真实复制并删掉 `id_defined.json`）
2. hvigor 6.26.2 从 `command-line-tools` 里**手工复制**到 `apps/harmonyos/node_modules/@ohos/`——npm 源上这两个包都是 404
3. 三处 SDK 补丁：`process_visual.js` 与 `external_component_map.js` 的 `externalconfig.json` 空值守卫、`hos-sdk-info.js` 的 `getLibimageTranscoderShared()` 返回空串（该 dll 在本 SDK 包中不存在）

签名链路的关键坑：**profile 里的 `distribution-certificate` 必须是 URL-safe base64**（`+`→`-`、`/`→`_`），否则 `sign-app` 报 `Illegal base64 character 2f`；另外密码必须 ≥32 字符，否则 hvigor 报 `00303116`。这两点都已固化进 `tools/harmony/gen-sign-material.cjs`。

## 验证

- `npm run typecheck` ✓、`npm run lint` ✓
- `npm test` **21 个测试文件 / 358 个用例全通过**
- `cd apps/androidtv && ./gradlew :app:assembleTvRelease :app:assemblePhoneRelease :app:testTvDebugUnitTest :app:testPhoneDebugUnitTest` ✓ —— 电视版 **22 个 testsuite / 168 个用例**、手机版 **19 个 testsuite / 156 个用例**，全部 0 失败（手机版少掉的 12 项正是 `testTv/` 下的焦点与遥控器测试）
- `pwsh -File tools/harmony/build.ps1` ✓，产出 `entry-default-signed.hap` 797,767 字节；`hap-sign-tool verify-app` 返回 `verify: Verify success`
- APK 实测包信息：电视版 `org.libretv.tv` / 手机版 `org.libretv.tv.phone`，均 `versionCode 17` / `versionName 1.3.8`

## 产物

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `LibreTV-Setup-1.3.8-x64.exe` | — | 桌面端安装包 |
| `LibreTV-Portable-1.3.8-x64.exe` | — | 桌面端免安装版 |
| `LibreTV-TV-1.3.8.apk` | 2.7 MB | Android 电视版 |
| `LibreTV-Phone-1.3.8.apk` | 2.7 MB | Android 手机版 |
| `LibreTV-Harmony-1.3.8.hap` | 780 KB | 鸿蒙原生版（本地自签，见下） |

## 已知限制

- **鸿蒙 HAP 用的是本地自签证书**：只能装在已登录开发者账号并开启 USB 调试的设备上。要分发给他人，需在 AppGallery Connect 用正式证书重新签发 profile 后重跑 `tools/harmony/build.ps1`。
- **手机版与电视版共享同一份内置源清单**（`defaults/sources.json`），源的可播率数据是 2026-11 在中国移动宽带下实测的，会随源站变动而衰减；死源由 health.ts 连挂两次自动暂停兜底。
- **鸿蒙版首页没有分类推荐位**：`AppModel.homeRows()` 目前返回空数组，首页只展示继续观看、收藏与直播入口。分类浏览需要额外调 `?ac=list` 接口，留待后续版本。
- 电视版产物名从 `app-release.apk` 变为 `app-tv-release.apk`，历史文档与脚本里若写死了旧路径需要同步。

## 升级提示

- 桌面端直接覆盖安装即可。
- 电视端包名未变（`org.libretv.tv`），可覆盖升级。
- 手机版是新包名（`org.libretv.tv.phone`），与电视版互不干扰，源配置各自独立。
- 鸿蒙版是全新应用，首次启动会导入内置源清单。
