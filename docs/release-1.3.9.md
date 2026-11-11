# 1.3.9 发布说明

本版是**纯改名版**：项目从 LibreTV 更名为 **LibreXTV**，功能与 1.3.8 完全一致，没有行为变更。

## 为什么要改名

LibreTV 这个名字属于上游项目（[LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV)）。本项目是基于它的**客户端重制**，四端（桌面 / Android TV / Android 手机 / 鸿蒙）共享同一份解析语义，但代码、交互与工程结构都是重写的。长期沿用上游名会让人误以为这是上游的官方客户端，也会让「问题该报给谁」变得含糊，所以这次统一改名。

上游的署名、许可证与 artwork 来源全部保留（见文末）。

## 改了什么

| 范围 | 旧 | 新 |
| --- | --- | --- |
| 项目名 / 品牌 | LibreTV | **LibreXTV** |
| Android 电视版包名 | `org.libretv.tv` | `org.librextv.tv` |
| Android 手机版包名 | `org.libretv.tv.phone` | `org.librextv.tv.phone` |
| 鸿蒙 bundleName | `org.libretv.harmony` | `org.librextv.harmony` |
| 桌面端 appId | `org.libretv.desktop` | `org.librextv.desktop` |
| 桌面端产物名 | `LibreTV-Setup-*.exe` | `LibreXTV-Setup-*.exe` |
| npm 包名 | `@libretv/core`、`@libretv/desktop`、`libretv-client` | `@librextv/core`、`@librextv/desktop`、`librextv-client` |
| 桌面端全局桥 | `window.libretv` | `window.librextv` |
| 桌面端 localStorage 前缀 | `libretv-*` | `librextv-*` |
| Android DataStore 名 | `libretv` | `librextv` |
| 鸿蒙 preferences 库名 | `libretv_store` | `librextv_store` |
| DLNA 设备名 | `LibreTV 电视` | `LibreXTV 电视` |

Java/Kotlin 包目录整体从 `org/libretv/` 迁到 `org/librextv/`（5 个 sourceSet：`main` / `tv` / `phone` / `test` / `testTv`），所有 `package` 与 `import` 同步。

**刻意没有改的**：

- **上游署名 `LibreSpark/LibreTV`**：README、`electron-builder.yml` 的 copyright、各源文件头部「移植自 LibreTV …」注释、DLNA 的 `manufacturerURL`、推荐接口的 UA 串、设置页的上游外链，都指向上游项目，改成新名字会变成错误陈述。
- **`reference/LibreTV` 目录名**：上游只读快照，保留原名便于追溯对应关系。
- **订阅格式标识 `LibreTV-SourceList` 与内部格式值 `'libretv'`**：这是导入/导出文件的互联协议，改了会与上游及其它工具不兼容。
- **`D:/IDE/LibreTV/...` 绝对路径**（`tools/e2e/*.mjs` 的截图输出）：工作目录实际仍叫这个名，改了反而指错。
- **历史发布说明与审计文档**（`docs/release-1.3.6/1.3.7/1.3.8.md`、`docs/audit-*`）：记录的是当时的事实，不回改。
- **Android 签名密钥库 `libretv-release.jks` 与 alias `libretv`**：改名会让已装设备无法覆盖升级，且该文件本就不入库。

## 升级影响（重要）

**包名变了，等于换了一个应用。** 已装旧版的设备不会覆盖升级，而是并存两个 App：

- 观看历史、收藏、直播收藏、自定义源、播放设置**不会**从旧版迁移过来
- 旧版可以留着慢慢对照，也可以直接卸载；卸载后再装新版，数据从空白开始

如果是从 1.3.8 之前的版本升级、又很在意这些数据：**桌面端**旧版「设置 → 导出配置与历史」可以先存一份 JSON，新版「设置 → 粘贴 JSON 导入」再读回来（导入前会自动备份当前配置）；**Android 与鸿蒙端没有导出功能**，只能从空白开始。

桌面端同理：`appId` 与 userData 目录名都变了，新版是干净的一份配置。

## 验证

- `npm run typecheck` ✓、`npm run lint` ✓（无告警）
- `npm test` **21 个测试文件 / 358 个用例全通过**（其中 `packages/core` 290 项、桌面主进程 68 项）
- `cd apps/androidtv && ./gradlew :app:assembleTvRelease :app:assemblePhoneRelease :app:testTvDebugUnitTest :app:testPhoneDebugUnitTest` ✓ —— 电视版 **22 个 testsuite / 168 个用例**、手机版 **19 个 testsuite / 156 个用例**，全部 0 失败
- APK 实测包信息：电视版 `org.librextv.tv` / 手机版 `org.librextv.tv.phone`，均 `versionCode 18` / `versionName 1.3.9`，标签分别为「LibreXTV」「LibreXTV 手机版」
- `npm run dist:desktop` ✓，exe 的 `FileVersion` / `ProductVersion` 均为 `1.3.9`，`ProductName` 为 `LibreXTV`
- `pwsh -File tools/harmony/build.ps1 -Mode release` ✓，产出 `entry-default-signed.hap` 348,253 字节；`hap-sign-tool verify-app` 返回 `verify: Verify success`（profile 的 `bundle-name` 已是 `org.librextv.harmony`）

改名后用 `git grep` 复核过一遍：全仓旧名只剩上表「刻意没有改的」那些，没有遗漏的标识符。

## 产物

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `LibreXTV-Setup-1.3.9-x64.exe` | 76.9 MB | 桌面端安装包 |
| `LibreXTV-Portable-1.3.9-x64.exe` | 76.7 MB | 桌面端免安装版 |
| `LibreXTV-TV-1.3.9.apk` | 2.7 MB | Android 电视版 |
| `LibreXTV-Phone-1.3.9.apk` | 2.7 MB | Android 手机版 |
| `LibreXTV-Harmony-1.3.9.hap` | 340 KB | 鸿蒙原生版（release，本地自签） |

鸿蒙 HAP 的 debug 构建约 780 KB，release 构建因为 ArkTS 压缩与符号剥离会小到 340 KB。

本地产物路径（都不入库）：

- 桌面端：`apps/desktop/release/LibreXTV-Setup-1.3.9-x64.exe`、`LibreXTV-Portable-1.3.9-x64.exe`
- Android：`apps/androidtv/app/build/outputs/apk/tv/release/app-tv-release.apk`、`.../phone/release/app-phone-release.apk`
- 鸿蒙：`apps/harmonyos/entry/build/default/outputs/default/entry-default-signed.hap`
- 发布用的统一命名副本：`.artifacts/1.3.9/`（`LibreXTV-TV-1.3.9.apk`、`LibreXTV-Phone-1.3.9.apk`、`LibreXTV-Harmony-1.3.9.hap`）

HAP 只有 340 KB 是正常的：里面是 `ets/modules.abc`（289 KB 的方舟字节码，已含全部 ArkTS 逻辑与中文文案）、`resources`（图标 + 内置源清单）、`module.json` 与签名块，没有大体积的资源或原生库。

## 已知限制

- **鸿蒙 HAP 用的是本地自签证书**：只能装在已登录开发者账号并开启 USB 调试的设备上。要分发给他人，需在 AppGallery Connect 用正式证书重新签发 profile 后重跑 `tools/harmony/build.ps1`。
- **改名导致的数据不迁移**：见上文「升级影响」。
- **鸿蒙版首页仍没有分类推荐位**：`AppModel.homeRows()` 返回空数组，首页只展示继续观看、收藏与直播入口（与 1.3.8 相同）。
- 内置源清单仍是 2026-11 在中国移动宽带下实测的 version 7，本版没有改动源。

## 许可证与致谢

AGPL-3.0-or-later。上游 LibreTV 同许可，本仓库作为衍生作品同样以 AGPL 发布。应用图标沿用上游 artwork（`public/icons/icon-512.png`，AGPL-3.0-or-later）。
