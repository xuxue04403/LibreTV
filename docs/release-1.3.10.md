# 1.3.10 发布说明

本版修两个手机版上的实际问题，其余三端只有版本号变化。

## 修了什么

| 问题 | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 手机版是横屏 | 在竖屏手机上装好后，界面按横屏铺开，大片留白 | `src/phone/AndroidManifest.xml` 里 `android:screenOrientation="unspecified"`，Activity 跟随设备物理方向 | 清单改锁 `portrait`；新增 `KeepScreenOrientation` 在进播放页（点播 / 直播 / 投屏）时切 `landscape`，退出时 `onDispose` 复位竖屏 |
| 简介里露出 HTML 实体 | 详情页显示 `&amp;nbsp;` 之类的乱码 | 源站简介里夹着 `&nbsp;` 等实体，客户端只剥了 `<...>` 标签 | 电视版与手机版都补上实体解码（`&nbsp;` / `&amp;` / `&quot;` / `&#39;` / `&lt;` / `&gt;`）并压缩空白 |

播放页不跟随重力旋转是有意的：用户可能躺着看，`sensorLandscape` 会让画面来回翻转，所以固定 `landscape`。

## 验证

在 Android 模拟器（`phone35`，Pixel 6 规格，1080×2400，density 420）上实测：

- 启动即为竖屏，`uiautomator` 根节点 `rotation="0"`、bounds `[0,0][1080,2400]`；
- 首页、搜索、直播、设置四栏全部正常，分类「电影」拉到 300+ 部真实片源；
- 点播放后 `rotation="1"`、bounds `[2400,1080]`，进度条走到 `01:05 / 1:52:11`，切源到「暴风资源」成功；
- 返回键退出播放页后立即回到 `rotation="0"` 竖屏，详情页显示「看到第 1 集」；
- 简介中 `nbsp` 出现次数为 0。

自动化测试：`packages/core` + 桌面端 21 文件 / 358 用例全过；Android 电视版 22 套 / 168 用例、手机版 19 套 / 156 用例全过；`typecheck`、`lint` 无告警。

## 四端版本

| 端 | 版本 | 产物 |
| --- | --- | --- |
| 桌面端（Electron） | 1.3.9 → **1.3.10** | `apps/desktop/release/LibreXTV-Setup-1.3.10-x64.exe` |
| Android 电视版 | versionCode 18 → **19** | `apps/androidtv/release/LibreXTV-TV-1.3.10.apk` |
| Android 手机版 | versionCode 18 → **19** | `apps/androidtv/release/LibreXTV-Phone-1.3.10.apk` |
| 鸿蒙手机版 | versionCode 3 → **4** | `apps/harmonyos/release/LibreXTV-Harmony-1.3.10.hap` |

## 已知限制

- 鸿蒙 HAP 仍用 OpenHarmony 测试根证书自签，**HarmonyOS 5/NEXT 真机不认这个链**，`hdc install` 会报 `not trusted app source`。要用华为 AGC 签发的调试证书重签：备好 `.cer` / `.p7b` / `.p12` + 别名与密码后跑 `pwsh -File tools/harmony/use-huawei-signing.ps1`。
- 鸿蒙并没有「点击 HAP 安装」的系统入口，`.hap` 只能通过 `hdc install` 或 DevEco Studio 安装，用文件管理器点开会被交给飞书之类的通用文件处理应用。
- 直播源可播率受网络与源站影响，本轮实测从台湾地区网络访问时多数频道连不上，属源侧波动，客户端 15 秒无画面会提示并可换台。
