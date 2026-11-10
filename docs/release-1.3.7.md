# LibreTV 1.3.7 发布说明

> 交付日期：2026-11-10 · 基于 `LibreSpark/LibreTV` 客户端重写线的第八个公开版本。

## 本版内容（自 1.3.6 起）

这一版只做一件事：**把内置源从「海外能看」换成「国内能看」**（清单 `version` 6 → 7）。

| 提交 | 内容 |
| --- | --- |
| 本轮 | 内置源清单换血：点播 10 → 13、直播 5 → 7，全部按国内网络逐条实测重排；GitHub 托管的源统一换 `fastly.jsdelivr.net` / `testingcf.jsdelivr.net` 镜像 |
| 本轮 | 修复点播源换址不生效：`seedDefaults` 的换址替换以前只对直播源做了，点播源换域名会在列表里留下两条同 key 的条目（桌面端 `srcFresh`、TV 端 `freshVodByKey` 两端对称补齐） |
| 本轮 | `tools/audit/` 新增 9 个源体检脚本（分层体检、直播抽检、HLS 探测、覆盖度矩阵、候选采集等），下次换源可直接复用 |
| 本轮 | 文档：新增 `docs/source-audit-2026-11.md`，更新 `README.md` 与 `docs/architecture.md` 中的实测数据 |

## 为什么换源

1.3.6 及以前的清单是**在海外 IP 下测的**。关掉代理、换到国内网络复测后，同一个源的结果可能完全相反：

| | 旧清单（v6）国内实测 |
| --- | --- |
| 点播 | 6/10 全链路可用（魔都、红牛、如意三家被按域名重置） |
| 直播 | **0/5** —— 三个默认启用的源连整份清单都下不下来 |

原因很直接：`raw.githubusercontent.com`、`cdn.jsdelivr.net`、`github.com` 在国内一律在 TLS 握手阶段被重置，而 v6 的三个默认直播源全托管在这三个域名上。也就是说**当时的「开箱即用」在国内实际是全死的**。README 里那句「Collect-IPTV 94% 可播」也是海外数据，国内只有 40%。

## 源清单变化

**点播 10 → 13**（顺序即 `builtin_${index}`，新源只在末尾追加）：

| 变动 | 源 |
| --- | --- |
| 换址 | 魔都 `caiji.moduapi.cc` → `www.mdzyapi.com`；红牛 `www.hongniuzy2.com` → `www.hongniuzy3.com`；电影天堂 `http` → `https` |
| 新增 | 金鹰资源 `jyzyapi.com`、新浪资源 `api.xinlangapi.com/xinlangapi.php`、光速资源 `api.guangsuapi.com` |
| 保留原位 | 如意资源全部已知域名在国内 `ECONNRESET`，但占着 `builtin_7`，删掉会让后面 5 个源下标前移导致老用户历史/收藏串台；保留 + 靠健康检查连挂两次自动暂停兜底 |

**直播 5 → 7**（数组顺序即加载与去重优先级，按国内可播率降序）：

| 源 | 地址 | 默认 | 国内可播率 |
| --- | --- | --- | --- |
| vbskycn 国内 IPv4 | `fastly.jsdelivr.net/gh/vbskycn/iptv@master/tv/iptv4.m3u` | 开 | **73%~78%** |
| best-fan 国内全量 | `testingcf.jsdelivr.net/gh/best-fan/iptv-sources@main/cn_all_status.m3u8` | 开 | 57%~60% |
| zhi35 央视卫视港澳台 | `fastly.jsdelivr.net/gh/zhi35/iptv@master/iptv.m3u` | 开 | 55%~60% |
| Collect-IPTV 精选 | `fastly.jsdelivr.net/gh/zilong7728/Collect-IPTV@main/best_sorted.m3u` | 开 | 40%~43% |
| Guovin 央视卫视 | `testingcf.jsdelivr.net/gh/Guovin/iptv-api@gd/output/ipv4/result.m3u` | 关 | 18%~23% |
| iptv-org 全球频道 | `iptv-org.github.io/iptv/index.m3u` | 关 | 8%~30% |
| iptv-org 中国频道 | `iptv-org.github.io/iptv/countries/cn.m3u` | 关 | 10%~15% |

选源时做过覆盖度分析：用 24 个跨年代/国别片名对 18 个候选源做「源 × 片名」矩阵，绝大多数都是 24/24、两两 Jaccard 重合率遍地 100%，贪心选源第一轮就收敛——**这批采集站是高度同质的同一片库，多内置只会增加并发请求和重复结果**。所以这次只按「国内可达 + 全链路可播」挑，没追求数量。

## 验证

- 桌面：`npm run lint`、`npm run typecheck`、`npm test`（21 files / 358 tests）、`npm run build:desktop` 全部通过。
- TV：`.\gradlew.bat :app:compileDebugKotlin :app:testDebugUnitTest --tests "org.libretv.tv.data.DefaultsSelectionTest"` 通过。
- 构建产物内联校验：`index-*.js` 里新地址（`mdzyapi` / `hongniuzy3` / `guangsuapi` / `xinlangapi.php` / `jyzyapi` / `zhi35` / `best-fan` / `fastly.jsdelivr`）全部命中，旧地址（`caiji.moduapi.cc` / `hongniuzy2` / `cdn.jsdelivr.net/gh/zilong` / `raw.githubusercontent.com/vbskycn`）全部消失。
- 升级路径实测（esbuild 打包 `store.ts` 后在 node 里 mock `localStorage` 跑真实 `seedDefaults()`）：v6 老用户 → v7 得到 13 个点播源、无重复 key、无重复 url、旧地址残留 0 条；全新安装得到 13 + 7，默认启用 `builtin_live_2/3/4/5`。
- 新清单复测（2026-11-10，国内 IP）：点播 11/13 首集可播、11/13 末集也通；直播 4 个默认启用源实测 78% / 57% / 55% / 40%。

## 产物

- `apps/desktop/release/LibreTV-Setup-1.3.7-x64.exe`（NSIS 安装包）
- `apps/desktop/release/LibreTV-Portable-1.3.7-x64.exe`（便携版）
- `apps/androidtv/app/build/outputs/apk/release/app-release.apk`（release 签名）

## 已知限制

- **百度资源不稳定**：接口本身正常（54 分类、25 集），但取 m3u8 时连测三次只有一次成功，是它的片源 CDN 在抖。留在清单里（占 `builtin_9`），健康检查连挂两次会自动暂停。
- 直播收藏按 url 存（`LiveFavoriteEntry { url, … }`），本次 3 个直播源换了镜像域名，老用户那几条收藏会失效；点播侧有 `PlaybackCandidate` 自动换源，直播侧没有等价机制。
- 删除名单按 url 匹配，换过域名的内置源即使被用户删过也会以新地址复活（判为可接受：用户删的是「那个站」，站点换域名后重新出现不违背意图，设置里能再删一次）。
- 直播死链仍然常见（返回 HTML 错误页、被地区限制），播放页 15 秒内没有画面会明确提示，`↑`/`↓` 换台即可。

## 升级提示

- 桌面端与 TV 端版本号对齐到 `1.3.7`；TV `versionCode` 由 15 升到 16，可直接覆盖安装同签名旧版。
- 清单 `version` 6 → 7，老用户下次启动会自动补齐新增的 3 个点播源与 2 个直播源；已有源里换过域名的会用新地址原地替换，不会产生重复条目。
- `LIVE_SELECTION_VERSION` 保持 5，不再触发「一次性取消勾选」——本次调整的默认勾选只对新装用户生效，老用户的勾选状态不受影响。
