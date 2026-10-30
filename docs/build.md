# 构建、打包与联调

## 环境要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 20（实测 26） | 桌面端构建、单元测试 |
| npm | ≥ 10 | workspace 依赖管理 |
| JDK | 17–21（实测 21） | Android 构建 |
| Android SDK | platform 35 + build-tools 35 + platform-tools | 编译 APK |
| Gradle | 无需安装 | 仓库自带 wrapper（8.13）会自动下载；也可直接用 Android Studio |
| ffmpeg（可选） | 任意版本 | 生成联调用的 HLS 测试视频 |

## 桌面端

### 安装与开发

```bash
npm install
npm run dev:desktop        # electron-vite dev：主进程/渲染层热更新
```

首次跑 Electron 时 npm 可能因为 `allowScripts` 拦截安装脚本，需要执行一次：

```bash
npm install-scripts approve electron
npm install-scripts approve esbuild
# 若 electron 二进制仍未下载，手动解压缓存包：
node node_modules/electron/install.js
```

其实现代 Electron 的二进制缓存在 `%LOCALAPPDATA%\electron\Cache`，若 `install.js` 只解出部分文件（网络中断导致），可直接解压：

```powershell
Expand-Archive "$env:LOCALAPPDATA\electron\Cache\electron-v33.4.11-win32-x64.zip" -DestinationPath node_modules/electron/dist -Force
Set-Content node_modules/electron/path.txt 'electron.exe' -NoNewline
```

### 构建与打包

```bash
npm run build:desktop     # 产物：apps/desktop/out/{main,preload,renderer}
npm run dist:desktop      # electron-builder → apps/desktop/release
```

打包目标在 `apps/desktop/electron-builder.yml`：

- Windows：NSIS 安装包 + portable
- macOS：dmg + zip
- Linux：AppImage + deb

只验证构建、不下载打包器的做法：

```bash
cd apps/desktop && npx electron-builder --dir
```

### 冒烟与截图（无需人工点击）

主进程内置了冒烟开关，CI 或本地都可以用它验证「启动 → 渲染 → 抓图」：

```powershell
$env:LTV_SMOKE='D:\tmp\home.png'
$env:LTV_SMOKE_SEED='{"state":{...},"version":1}'   # 可选：预置 localStorage
$env:LTV_SMOKE_JS='document.querySelectorAll(".rail-btn")[3]?.click()'  # 可选：截图前执行
$env:LTV_ALLOW_PRIVATE_MEDIA='1'                    # 联调本机媒体源时需要
apps\desktop\node_modules\electron\dist\electron.exe apps\desktop --user-data-dir=D:\tmp\profile
```

> 如果当前 shell 设置了 `ELECTRON_RUN_AS_NODE=1`（某些 Electron 宿主环境会设置），必须先清掉，否则 `electron.exe` 会以 Node 模式运行并报 `ipcMain undefined`。

## Android TV

### 编译

```bash
cd apps/androidtv
export ANDROID_HOME=/path/to/android-sdk     # Windows: $env:ANDROID_HOME='D:\...'
./gradlew assembleDebug                          # 需要 JDK 17+；Windows 用 gradlew.bat
```

产物：`app/build/outputs/apk/debug/app-debug.apk`（约 15 MB，debug 包名带 `.debug` 后缀）。

用 Android Studio 打开 `apps/androidtv` 也可直接运行，建议创建一个 Android TV 模拟器（API 30+，1080p）。

### 安装到电视

```bash
adb connect 192.168.1.20:5555      # 电视需开启「开发者选项 → 网络调试」
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n org.libretv.tv.debug/org.libretv.tv.MainActivity
```

也可以把 APK 拷到 U 盘，用电视上的文件管理器安装（需允许「未知来源」）。

### 单元测试

```bash
cd apps/androidtv
./gradlew testDebugUnitTest
```

覆盖 146 项：搜索列表解析、分集提取、详情兜底、M3U 属性与分组、相关性/成人过滤、同名聚合、订阅宽容解析、DLNA 请求解析（按字节读 + 上限）、拼音、观看记录去重、分片缓存、默认源选择，以及用 Robolectric 在 JVM 上跑真实 Compose 组合的首焦点/遥控器按键（`ui/AutoFocusUiTest.kt`）。

### 常见问题

**Gradle 报 TLS 握手失败**（`Remote host terminated the handshake`）：

- 本仓库已在 `settings.gradle.kts` 里优先使用阿里云镜像、并在 `gradle.properties` 固定 `https.protocols=TLSv1.2`；
- 若仍失败，可设置代理：`systemProp.https.proxyHost` / `systemProp.https.proxyPort`。

**组播权限**：DLNA 依赖 `CHANGE_WIFI_MULTICAST_STATE` 并在运行时持有 `MulticastLock`；部分电视系统（如部分国产 ROM）会限制组播，表现为手机搜不到「LibreTV 电视」。

**模拟器与真机的差异**：模拟器默认 NAT 网络下 SSDP 组播常不可用，投屏请在真机验证。

## 端到端联调

仓库自带两个 mock 服务，用于在没有真实片源/电视的情况下验证全链路。

### 1. 假采集站 + 真实 HLS 视频

```bash
# 生成 12 秒测试视频（需要 ffmpeg）
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=frequency=440 \
  -t 12 -c:v libx264 -preset veryfast -c:a aac -f hls -hls_time 4 \
  -hls_playlist_type vod -hls_segment_filename .artifacts/hls/seg%03d.ts \
  .artifacts/hls/index.m3u8

# 启动假采集站（含搜索/详情/直播 M3U/EPG，全部指向本地 HLS）
MEDIA_DIR=.artifacts/hls node tools/mock-cms/server.mjs 8099
```

然后在应用里添加点播源 `http://127.0.0.1:8099/api.php/provide/vod`，搜索「流浪地球」即可走通搜索 → 详情 → 播放。

> 桌面端媒体代理默认拒绝内网地址，联调时设置 `LTV_ALLOW_PRIVATE_MEDIA=1`。

### 2. 假 DLNA 渲染器

```bash
node tools/mock-dlna/server.mjs        # 打印 description URL
node tools/mock-dlna/test.mjs          # 自动跑 SSDP → 描述 → SOAP 全链路断言
```

`npm run test:dlna` 即执行后者。

### 3. 手动验证投屏

1. 启动 `tools/mock-dlna/server.mjs`；
2. 桌面端播放页点击右上角「投屏」；
3. 设备列表应出现「Mock TV 客厅」，点击后假渲染器的 `/requests` 会记录 `SetAVTransportURI` 与 `Play`。

## 目录约定

| 路径 | 说明 |
| --- | --- |
| `defaults/sources.json` | 内置默认源，两端共用；改这里即可同时影响 PC/TV |
| `packages/core/src/**` | 共享逻辑与单测（`vitest`） |
| `apps/desktop/src/main` | 主进程：窗口、IPC、回环代理、DLNA 发送端 |
| `apps/desktop/src/preload` | contextBridge 白名单 |
| `apps/desktop/src/renderer` | React 界面、播放器、页面 |
| `apps/androidtv/app/src/main/java/org/libretv/tv` | TV 应用（data / ui / cast） |
| `tools/mock-cms`、`tools/mock-dlna` | 联调用假服务 |
| `reference/LibreTV` | 上游只读快照 |
