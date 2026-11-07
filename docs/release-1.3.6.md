# LibreTV 1.3.6 发布说明

> 交付日期：2026-11-07 · 基于 `LibreSpark/LibreTV` 客户端重写线的第七个公开版本。

## 本版内容（自 1.3.5 起）

| 提交 | 内容 |
| --- | --- |
| `1529ac0` | 桌面端首页推荐：Bangumi 每日放送 / 影视榜单六榜 / 豆瓣推荐，设置里可开关与切换数据源；最近搜索收进搜索框下拉 |
| `521e9db` | 倍速跨集保持（换集、换源、错误重建后不再回落 1×） |
| `405dd57` | 源健康度：连续失败 2 次自动暂停（30 分钟 → 24 小时 → 永久），搜索页可逐条恢复 |
| `db04d92` | 详情面板同片源测速排序 + 画质徽章（H.264 SPS 解析，主进程探测，失败原因可读） |
| `5541b5a` | 跳过片头/中段/片尾（Shift+I/O/S/E，自动跳过 + 撤销条 + 进度条色带）、音量增强（1.8× + 限幅）、订阅自动刷新（周期 1/3/7/14/30 天、失败 3 次暂停） |
| `4a5ee1e` | 检索相关性排序（精确/前缀/包含/分词）、单源结果上限 80、失败源单源重试；跳过标记面板 |
| `604a69e` | TV 播放页 0.25 步进倍速与上一集/下一集入口 |
| `8c4dbf2` | TV 拼音检索：多音字备选表（`cq` → 重庆）、相关度排序、本地命中先出结果、索引上限 12000 |

## 验证

- 桌面：`npm run lint`、`npm run typecheck`、`npx vitest run`（21 files / 358 tests）、`npm run build:desktop` 全部通过；打包后的 `LibreTV.exe` 冒烟截图正常（首页推荐、搜索、设置）。
- TV：`./gradlew :app:testDebugUnitTest`（22 类 / 168 tests）与 `:app:assembleRelease` 通过；APK `org.libretv.tv` / `versionCode 15` / `1.3.6`。
- 桌面冒烟覆盖：首页推荐、搜索下拉、详情测速与画质徽章、源健康度暂停条、跳过标记面板、订阅刷新列表、打包产物启动。

## 产物

- `apps/desktop/release/LibreTV-Setup-1.3.6-x64.exe`（NSIS 安装包）
- `apps/desktop/release/LibreTV-Portable-1.3.6-x64.exe`（便携版）
- `apps/androidtv/app/build/outputs/apk/release/app-release.apk`（release 签名）

## 已知限制

- TV 端未接推荐流、源健康度、音量增强；只做了倍速、跳集与拼音检索优化。
- 画质探测只解析 H.264（TS/MP4）；HEVC、SAMPLE-AES 加密返回「未知」，不阻塞播放。
- 推荐与画质缓存都在内存，重启失效；拼音索引落盘上限 12000 条。
- 桌面端逐集预取、TV 端无代理直连，两端播放链路仍按各自架构独立演进。

## 升级提示

- 桌面端与 TV 端版本号对齐到 `1.3.6`；TV `versionCode` 由 14 升到 15，可直接覆盖安装同签名旧版。
- 旧配置无需迁移：新增设置项（`homeRecommend`、`recommendSource`、`volumeBoost`、`autoSkip`）由 `normalizeSettings` 与 persist merge 自动补默认值。
