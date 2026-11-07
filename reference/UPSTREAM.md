# 上游归档说明

本目录保存 LibreSpark/LibreTV 的只读快照，用于对照实现与移植解析逻辑。

- 上游仓库：https://github.com/LibreSpark/LibreTV
- 归档版本：`2.19.7`（commit `9d86ec2`）
- 许可证：AGPL-3.0-or-later
- 归档时间：2026-10-21

`.git` 目录已移除，避免与本仓库的版本历史混淆。

移植关系：

| 上游文件 | 本仓库对应实现 |
| --- | --- |
| `src/lib/cms-parser.ts` | `packages/core/src/cms.ts`、`apps/androidtv/.../data/Parsers.kt` |
| `src/lib/m3u-parser.ts` | `packages/core/src/m3u.ts`、`apps/androidtv/.../data/Parsers.kt` |
| `src/lib/m3u8.ts`（广告过滤部分） | `packages/core/src/ad-filter.ts` |
| `src/app/api/search/route.ts` | `packages/core/src/search.ts`、`apps/androidtv/.../data/Repository.kt` |
| `src/app/api/detail/route.ts` | `packages/core/src/detail.ts`、`apps/androidtv/.../data/Repository.kt` |
| `src/app/api/live/*`、`src/lib/xmltv.ts` | `packages/core/src/live.ts` |
| `src/lib/source-list.ts`、`tvbox-parser.ts` | `packages/core/src/subscriptions.ts`、`apps/androidtv/.../data/Subscriptions.kt` |
| `src/lib/bangumi.ts`、`douban.ts`、`douban-weekly.ts` | `packages/core/src/recommend.ts`（解析）+ `apps/desktop/src/main/recommend.ts`（抓取/缓存） |
| `src/lib/db.ts`、`store.ts` | `packages/core/src/storage.ts`、桌面端 zustand / TV 端 DataStore |
| `src/app/api/proxy`、`live/stream` | 桌面端回环媒体代理 `apps/desktop/src/main/proxy.ts`（Android 端不需要） |
| `src/app/api/auth`、`status` | 不再需要（本地客户端无服务端） |

上游 README 与文档链接保留在 `reference/LibreTV/README.md`，便于追溯原始设计意图。
