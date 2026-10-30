# 审计结论验证报告：88 条问题是否真实、是否已修复（2026-10-29 验证 / 2026-10-30 修复）

> 验证对象：`docs/audit-2026-10-29.md` 的 88 条结论（P1 8 / P2 41 / P3 39）。修复状态已回填（2026-10-30），逐条明细见 `docs/audit-2026-10-29.md` §10。
> 验证方式：对每条结论回到当前工作区源码，用「文件 + 行号 + 代码原文」逐条核对；对「零调用」类结论用全仓 grep 复核调用点。
> 证据标准：**静态证据**（当前代码路径可证）。本次未启动应用、未在真机/真环境做运行时复现，因此「必然失败」类结论是按代码路径推导，不是实测录像。

---

## 结论

| 问题 | 回答 |
| --- | --- |
| 这些问题真实存在吗？ | **88 条全部在当前代码中成立**：85 条与报告描述完全一致，2 条成立但需收窄表述（T-11、RPG-24），1 条为路径笔误（L9，不影响成立），见 §5 |
| 已经修复了吗？ | **验证当时一条都没修**（源码零改动：`git status --short` 只有 `?? docs/audit-2026-10-29.md`，`git diff --stat` 为空，HEAD 仍是 `b00c1b6`，无 stash）。**2026-10-30 已按本清单修复 86 条、部分完成 1 条（L11）、未修 1 条（M5）**，逐条状态见 `docs/audit-2026-10-29.md` §10，汇总见本文件 §7 |
| 有没有"其实已经修好"的误报？ | **没有**。88 条逐条回读，缺陷代码全部原样在位；上一轮 12 项修复的"只修一侧/部分回归"判断也在本轮再次确认 |

一句话版本：**审计出的问题全部真实存在；验证当天确实一个都没修，随后按清单修完了 86 条（含 20 处反证与新增回归测试）。**

---

## 1. 验证方法

1. **仓库状态**：`git status --short` → `?? docs/audit-2026-10-29.md`；`git diff --stat` → 空；`git log -1` → `b00c1b6`；`git branch -a` → 仅 `master`；`git stash list` → 空。=> 代码库自审计以来没有任何改动，因此"是否已修"的答案是结构性确定的，再逐条验证一遍是为了排除"审计本身误报"。
2. **逐条回读**：对 88 条每条在报告里给出的 `文件:行号` 处回读源码，确认缺陷代码仍在（不是靠印象或子代理转述）。
3. **零调用类专项**：对 `endNavFocusHold()`、`clearCatalogCache()`、`markCatalogChecked()` 这类"全仓零调用"的结论，用 grep 扫描全部调用方，只命中定义处。
4. **可证伪检查**：凡是"取消/中断/焦点/缓存"这类容易看错的结论，回读完整函数体（而不只看一行），确认调用顺序与状态机走向。

---

## 2. P1 高危（8 条）：全部真实存在 —— 验证时全部未修复，现已全部修复

| 编号 | 位置 | 验证证据（当前源码） | 结论 | 已修复 |
| --- | --- | --- | --- | --- |
| H1 | `apps/androidtv/app/src/main/java/org/libretv/tv/cast/DlnaServer.kt:144`、`:169-184` | `:144 val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))`；`:176 val buffer = CharArray(declared)`；`:179 val r = reader.read(buffer, read, declared - read)` —— 字节数当字符数，仍原样 | 真实存在 | ❌ 未修 |
| H2 | `apps/desktop/src/main/proxy.ts:650` | `:650 const liveMode = isLive || !text.includes('#EXT-X-ENDLIST');`；`:567 const cacheEligible = route === '/p' && !rangeHeader && !isLive;`；`:879 'Cache-Control': live ? 'no-store' : CACHE_SEGMENT` | 真实存在 | ❌ 未修 |
| H3 | `ui/CategoryScreen.kt:65-70`、`:121`；`ui/HomeScreen.kt:56`；`ui/SearchScreen.kt:56`；`AppViewModel.kt:485` | `CategoryScreen.kt:68 focusRestored = true`（无条件）；`:121 focusRequester = if (selected) firstFocus else null`；`HomeScreen.kt:56 if (vm.navFocusHold) return@LaunchedEffect`；grep `endNavFocusHold` 只命中 `AppViewModel.kt:485` 定义处 | 真实存在 | ❌ 未修 |
| H4 | `pages/Settings.tsx:471`；`packages/core/src/storage.ts:193`、`:214-216`；`lib/store.ts:371` | `Settings.tsx:471 const snapshot = parseSnapshot(file.content);` 后直接 `replaceAll`；`storage.ts:193 if (!raw \|\| typeof raw !== 'object') return null;`（只判是对象）；`:214 history: Array.isArray(obj.history) ? (obj.history as HistoryEntry[]) : []` —— 无元素级校验 | 真实存在 | ❌ 未修 |
| T-1 | `ui/PlayerScreen.kt:290-295`、`:306` | `:293 runCatching { errorFocus.requestFocus() }` 只在 `error != null` 时触发；`:306 if (drawerVisible \|\| error != null \|\| note != null)` 是唯一的按键放行条件 | 真实存在 | ❌ 未修 |
| T-2 | `ui/LiveScreen.kt:385-413`、`:430-443` | `:385 .onPreviewKeyEvent` 内 `:388-405` 对 `DirectionCenter/Enter/方向键` 全部 `true`，无 `error != null` 放行；`:430-443` 错误面板的三个 `TvButton` 就在被消费的作用域内 | 真实存在 | ❌ 未修 |
| RPL-01 | `pages/Watch.tsx:148-149`、`:165-169`、`:620-664` | 完整路径已回读：`:168 setError(null)` → 全部候选失败后回到 `:147`，`:148-149 if (untried.length === 0) { if (discoveredRef.current) return false; }` 直接返回，`failoverNote` 不清；`:620 loading && !error`、`:633 error &&` 两个面板都不渲染 | 真实存在 | ❌ 未修 |
| RPL-02 | `pages/Watch.tsx:175` | `:175 setIndex(pickEpisodeIndex(index, parsed.episodes.length));` —— `index` 是 `useCallback` 依赖（`:190`）捕进来的旧值，`await fetchDetail(...)`（`:171`）之后才用它 | 真实存在 | ❌ 未修 |

---

## 3. P2 中危（41 条）：全部真实存在 —— 验证时全部未修复，现修 40 条（`M5` 未修）

### 3.1 主进程与 core（16 条）

| 编号 | 位置 | 验证证据 | 结论 | 已修复 |
| --- | --- | --- | --- | --- |
| M1 | `main/index.ts:239`、`:313` | 两处 `redirect: 'follow'` 原样；同文件 `proxy.ts:200` 才是 `redirect: 'manual'` | 真实存在 | ❌ |
| M2 | `main/index.ts:242` | `const buf = new Uint8Array(await res.arrayBuffer());` 在长度判断之前 | 真实存在 | ❌ |
| M3 | `main/index.ts:419` | `await stopCast(device);` 直接使用渲染层传入的 device，未走 `:403-410` 的同源校验 | 真实存在 | ❌ |
| M4 | `main/dlna.ts:83`、`:228` | `return parseDeviceDescription(await res.text(), location);`、`const text = await res.text();` 均无字节上限 | 真实存在 | ❌ |
| M5 | `main/proxy.ts:167` → `:200` | `:167 const records = await lookupCached(host)`（60s 缓存），`:200 fetch(current.href, …)` 交给 undici 重新解析 | 真实存在 | ❌ |
| M6 | `main/proxy.ts:163`、`:112`、`:114` | `:163 if (net.isIP(host))`；`:112 if (lower.startsWith('fe80') \|\| lower.startsWith('fc') \|\| lower.startsWith('fd')) return true;`；`::ffff:` 只认十进制 | 真实存在 | ❌ |
| M7 | `main/proxy.ts:200`、`:480` | `fetch(current.href, …)` 未剥 userinfo；`:480 sendText(res, 502, \`代理失败：${err.message}\`)` 会把含密码的 URL 打到界面 | 真实存在 | ❌ |
| M8 | `main/proxy.ts:874`、`:879` | `:874 'Content-Type': contentType`（来自上游原样）；`:879 'Cache-Control': live ? 'no-store' : CACHE_SEGMENT`，不判 `upstream.status` | 真实存在 | ❌ |
| M9 | `packages/core/src/failover.ts:248`；`tv/data/Repository.kt:191`、`:197` | `failover.ts:248 const wanted = keyword.toLowerCase();` vs `:254` 用 `normalizeTitle`；`Repository.kt:191 val wanted = keyword.lowercase()` vs `:197 Parsers.normalizeTitle(item.name).lowercase()` —— 两侧同一个缺陷 | 真实存在（跨端同源） | ❌ |
| M10 | `packages/core/src/categories.ts:408`、`:551` | `:408 const duplicated: SourceCollected[] = []`（重复源仍记 `ok: true`）；`:551 const answered = outcomes.some((outcome) => outcome.ok);` | 真实存在 | ❌ |
| M12 | `main/proxy.ts:923` | `if (total > MAX_STREAM_BYTES) return false;` 之后仍 `res.end()`，状态码不变 | 真实存在 | ❌ |
| M13 | `ui/DetailScreen.kt:58` | `LaunchedEffect(target.item.vodId) { runCatching { playFocus.requestFocus() } }` —— key 含 vodId，换源必重跑 | 真实存在 | ❌ |
| M14 | `ui/CastScreen.kt:146-200` | `fun CastScreen()` 全身只有 `Text`/`Box`/`SectionHeader`，无 `focusable()`/`TvButton`/`clickable` | 真实存在 | ❌ |
| M15 | `AppViewModel.kt:1439-1464` | `fun importSubscription(url: String)` 内无 `if (importing) return`；`SettingsScreen.kt:175 if (vm.importing) "导入中…"` 只改文案不禁用 | 真实存在 | ❌ |
| M16 | `ui/SettingsScreen.kt:90-95` | `TvButton("添加", onClick = { vm.addSource(...); vodName = ""; vodUrl = ""; vodDetail = "" })` —— 无论校验是否通过都清空 | 真实存在 | ❌ |
| M17 | `ui/CategoryScreen.kt:170` | `"请求全部失败" + if (state.failureReason.isNotBlank()) … else "" + "，通常是…"` —— `+` 优先级高于 `if` 表达式，后半句被 else 分支吞掉 | 真实存在 | ❌ |

### 3.2 电视端播放/直播（5 条）

| 编号 | 位置 | 验证证据 | 结论 | 已修复 |
| --- | --- | --- | --- | --- |
| T-3 | `ui/PlayerScreen.kt:261`、`:151-153` | `:261 vm.saveProgress(current, currentIndex, position, duration)` 每 4 个 tick 写一次，ENDED 后 `position == duration` 仍写 `finished=false`；`onDispose` 再用 `exo.currentPosition` 覆盖 | 真实存在 | ❌ |
| T-4 | `ui/PlayerScreen.kt:179` 与 `:190-199` | `:179 play(result.target.episodes[result.episodeIndex])` 与 `:199 play(url)`（`LaunchedEffect(current.source.key, current.vodId, index)`）都会跑 | 真实存在 | ❌ |
| T-5 | `ui/PlayerScreen.kt:306` | `if (drawerVisible \|\| error != null \|\| note != null)` —— note 期间走该分支，非 Down 键全 `true` | 真实存在 | ❌ |
| T-6 | `ui/PlayerScreen.kt:122` | `val exo = remember { Playback.build(context) }`，全文件无 `LifecycleEventEffect`；grep `ON_STOP` 在 TV 源码只命中 import | 真实存在 | ❌ |
| T-7 | `ui/LiveScreen.kt:305`、`:394-399` | `:305 val exo = remember(current.url) {`；`:394-399` 每次方向键都 `switchTo(...)`，无节流 | 真实存在 | ❌ |

### 3.3 桌面渲染层（9 条）

| 编号 | 位置 | 验证证据 | 结论 | 已修复 |
| --- | --- | --- | --- | --- |
| RPL-03 | `pages/Live.tsx:161` | `const playlist = await fetchLivePlaylist(source.url, http, {` —— 选项里无 `signal`，`runId` 只用于丢弃 setState | 真实存在 | ❌ |
| RPL-04 | `pages/Watch.tsx:316` | `video.removeAttribute('src');` + `video.load()` 先执行，退出保存读 `video.currentTime` 时已归零 | 真实存在 | ❌ |
| RPL-05 | `lib/store.ts:385` | `version: 1,`（无 migrate）+ `partialize` 含 history/sources；`Watch.tsx:329` 每 5s 触发一次全量序列化 | 真实存在 | ❌ |
| RPL-06 | `pages/Watch.tsx:263` | `hls?.recoverMediaError();` 紧随其后 `handleFatal(...)` 会 `setReloadToken` 重建实例 | 真实存在 | ❌ |
| RPL-07 | `pages/Watch.tsx:152` | `const extra = await discoverCandidates(target.title, sources, http, {` —— 选项只有 `exclude`/`timeoutMs`，无 `signal` | 真实存在 | ❌ |
| RPL-08 | `pages/Live.tsx:109` | `setChannels([]);` 在无缓存分支被无条件调用 | 真实存在 | ❌ |
| RPL-09 | `pages/Live.tsx:151` | `for (const list of buffers.values()) merged.push(...list);` 每 120ms 全量重建并 `setChannels` | 真实存在 | ❌ |
| RPL-10 | `pages/Live.tsx:500-520` | EPG 的 `useEffect` 依赖 `[channel.epg, channel.tvgId]`，无定时刷新 | 真实存在 | ❌ |
| RPL-11 | `lib/live-epg.ts:37` | `return { at: Date.now(), ok: true, byChannel: parseXmltv(text) };` —— 同步解析；调用方 `http.request` 未传 signal | 真实存在 | ❌ |

### 3.4 渲染层缓存与启动（7 条）

| 编号 | 位置 | 验证证据 | 结论 | 已修复 |
| --- | --- | --- | --- | --- |
| RPG-03 | `lib/catalog-cache.ts:94`、`:103` | `export function cachedSearch(word, adultFilter)` 的 key 无源集合签名；grep `clearCatalogCache` 只命中 `catalog-cache.ts:103` 定义处 | 真实存在 | ❌ |
| RPG-04 | `pages/Category.tsx:167`、`:177-181` | `if (myRun === runId.current && !(err instanceof DOMException && err.name === 'AbortError'))` —— bridge 抛 `new Error('请求已取消')`，`instanceof DOMException` 恒 false；cleanup 只 `abort()` | 真实存在 | ❌ |
| RPG-05 | `pages/Search.tsx:102-104`、`:128` | `:102 if (myRun !== runId.current) return;` 不判 `signal.aborted` → 卸载 abort 后仍会 `toast.err('所有源都没有返回结果…')` | 真实存在 | ❌ |
| RPG-06 | `lib/catalog-warmer.ts:47`、`:73` | `:47 const sources = store.sources.filter(...)` 开始时快照，收尾写缓存仍用该快照签名 | 真实存在 | ❌ |
| RPG-07 | `packages/core/src/catalog.ts:120` | 函数存在，但 grep `markCatalogChecked` 在 `apps/desktop/src` 零命中 | 真实存在 | ❌ |
| RPG-08 | `App.tsx:37` | `void initBridge().then(() => {` —— 全段无 `.catch` | 真实存在 | ❌ |
| RPG-11 | `pages/Settings.tsx:73` | `name: name.trim() \|\| new URL(api).hostname,` 在点击回调同步栈里，无 try/catch | 真实存在 | ❌ |

### 3.5 电视端数据层（4 条）

| 编号 | 位置 | 验证证据 | 结论 | 已修复 |
| --- | --- | --- | --- | --- |
| D-1 | `tv/data/Net.kt:62-64` | `client.newCall(builder.build()).execute().use { response -> …; response.body?.string() ?: "" }` —— 整体读入内存，无上限 | 真实存在 | ❌ |
| D-2 | `tv/data/Repository.kt:53-59` | `val current = catalog` … `catalog = next` 之间无锁，`cacheCatalogItems` 是读-改-写 | 真实存在 | ❌ |
| D-6 | `tv/data/Net.kt:62` | `execute()` 是阻塞调用，`withTimeoutOrNull` 取消的是协程而不是 `Call` | 真实存在 | ❌ |
| D-7 | `tv/data/Repository.kt:187`、`:191` 对比 `:275`、`:326` | 搜索/详情/拼音路径直接 `net.getText`，`Net.gated` 只在 `categoriesOf`（:275）与 `browseCategory`（:326）用到 | 真实存在 | ❌ |

---

## 4. P3 低危（39 条）：38 条原样成立，1 条需修正表述 —— 现已 38 条修复、`L11` 部分完成

| 编号 | 位置 | 验证证据 | 结论 | 已修复 |
| --- | --- | --- | --- | --- |
| L1 | `packages/core/src/categories.ts:610` | `const cached = probeCache.get(cacheKey);`，key 构造仍用未排序的 `sources.map(...).join(',')` | 真实存在 | ❌ |
| L2 | `packages/core/src/categories.ts:395` | `const hit = browseCache.get(cacheKey);` 命中后 `return hit.result`（同一引用） | 真实存在 | ❌ |
| L3 | `packages/core/src/format.ts:26` | `return /^https?:\/\/.+/.test(url);` | 真实存在 | ❌ |
| L4 | `packages/core/src/storage.ts:153` | `export function toggleLiveFavorite(...)` 无上限判断 | 真实存在 | ❌ |
| L5 | `README.md:30` vs `packages/core/src/catalog.ts:35` | README「✅ 落盘 1 小时」；`SEARCH_CACHE_TTL_MS = 30 * 60 * 1000` | 真实存在（文档错） | ❌ |
| L6 | `PlaybackCandidateTest.kt:130` | `private fun align(preferred: Int, length: Int): Int =` 在测试里重写生产逻辑 | 真实存在 | ❌ |
| L7 | `app/build.gradle.kts:95` | 测试依赖仅 junit，无 ui-test/Robolectric | 真实存在 | ❌ |
| L8 | `PinyinTest.kt:46` | `// 表里没有「第/二/季」… assertEquals("qmmk", ...)` —— 断言整行被注释 | 真实存在 | ❌ |
| L9 | `app/src/test/java/org/libretv/tv/ui/theme/TvUiScaleTest.kt`（**原报告路径写成 `test/.../TvUiScaleTest.kt`，实际在 `ui/theme/` 下，已修正**） | 与上一行重复的断言，喂 dp | 真实存在（路径笔误） | ❌ |
| L10 | `DefaultsSelectionTest.kt:77` | `if (!file.exists()) return` | 真实存在 | ❌ |
| L11 | 工程 | 无 `.github/`；`apps/androidtv` 无 `gradlew` | 真实存在 | ❌ |
| L12 | `components/Toast.tsx:47`、`pages/Category.tsx:356` | `npm run lint` 仍报这 2 条 warning | 真实存在 | ❌ |
| T-8 | `ui/PlayerScreen.kt:418` | `TvButton("换源重试", … onClick = { … tryFailover("手动切换") })` 未清 `tried` | 真实存在 | ❌ |
| T-9 | `ui/PlayerScreen.kt:268` | `LaunchedEffect(controlsVisible, playing, drawerVisible)` —— 键不含按键序号，隐藏计时不重开 | 真实存在 | ❌ |
| T-10 | `ui/LiveScreen.kt:152` | `Chip("$name · $status", active = …)` 在普通 `Row` 里 | 真实存在 | ❌ |
| T-11 | `ui/App.kt:46-51`、`:131` | `LaunchedEffect(CastRuntime.pending)` + `CastPlayerScreen(target)` 里 `remember(target.url)`；`Screen.CastPlayer` 是 `data class CastPlayer(val url: String, val title: String)`（`AppViewModel.kt:79`）。**修正**：`pending` 每次投屏都从 null 置为非 null，LaunchedEffect 会重跑；只有「已停留在投屏页且 url+title 完全相同」时 `screen` 不变 → 不重建播放器。"重复投同一地址停在黑屏"收窄为"已在投屏页时重复投同一地址无法重启播放" | 部分成立（触发条件收窄） | ❌ |
| T-12 | `ui/DetailScreen.kt:60` | `Column(Modifier.fillMaxSize().padding(ScreenPadding))`，全函数无 `verticalScroll` | 真实存在 | ❌ |
| T-13 | `AppViewModel.kt:485` | `fun endNavFocusHold()` 全仓仅定义处命中 | 真实存在 | ❌ |
| RPL-12 | `pages/Watch.tsx:653` | `triedRef.current.add(candidateKey({ sourceKey: currentSource.key, vodId: target.vodId }));` 与 `:439` 口径不同 | 真实存在 | ❌ |
| RPL-13 | `pages/Watch.tsx:299` | `if (resume && resume.episodeIndex === index && resume.position > 15 && resume.position < video.duration - 15)` | 真实存在 | ❌ |
| RPL-14 | `lib/live-cache.ts:65` | `export function readLiveCache(key: string): CachedChannel[] \| undefined` 无逐项校验 | 真实存在 | ❌ |
| RPL-15 | `lib/live-cache.ts:52` | `localStorage.setItem(CACHE_KEY, JSON.stringify(map));` 同步全量 | 真实存在 | ❌ |
| RPL-16 | `pages/Home.tsx:63` | `const detail = await fetchDetail(source, record.vodId, http, { timeoutMs: 12_000 });` 无 signal | 真实存在 | ❌ |
| RPG-12 | `pages/Settings.tsx:261` | `removeLiveSource(s.key);` 直接执行，无 confirm | 真实存在 | ❌ |
| RPG-13 | `pages/Settings.tsx:290` | `toast.ok(\`已导入 ${addedVod} 个点播源、${addedLive} 个直播源${skipped}\`)` 全 0 也走 ok | 真实存在 | ❌ |
| RPG-14 | `pages/Settings.tsx:314` | `const result = await window.libretv.saveText(...)` 后只判 `result.ok` | 真实存在 | ❌ |
| RPG-15 | `pages/Category.tsx:334` | `function readCachedAvailability(signature: string)` 不校验 `at` | 真实存在 | ❌ |
| RPG-17 | `pages/Category.tsx:386` | `setProbed({ signature: sourceSignature, keys });` 只在 then 里落盘，卸载即 abort | 真实存在 | ❌ |
| RPG-18 | `components/Poster.tsx:14` | `const [failed, setFailed] = useState(false);` 无 `useEffect` 随 `src` 重置 | 真实存在 | ❌ |
| RPG-19 | `lib/catalog-warmer.ts:98` | `void warmOnce();` 在定时器里，不判可见性 | 真实存在 | ❌ |
| RPG-20 | `lib/store.ts:309` | `removeLiveSource: (key) =>` 不清 `liveFavorites` | 真实存在 | ❌ |
| RPG-22 | `main.tsx:9` | `<ErrorBoundary>` 只有一层根级 | 真实存在 | ❌ |
| RPG-23 | `components/DetailPanel.tsx:70-72`、`:131`、`:139` | `if (!source.url) { setError(...); return; }` 早退不清 `detail`；面板 `:209 (detail?.episodes ?? []).map(...)` 照常渲染旧选集，`:131 disabled={!detail \|\| detail.episodes.length === 0}` → 旧 `detail` 存在时按钮可用、`:139` 用旧 `episodes` 起播。**原标 `[待确认]`，本轮确认为真实存在** | 真实存在（已确认） | ❌ |
| RPG-24 | `pages/Category.tsx:152` | `setHasMore(result.outcomes.some((o) => o.supported && o.count > 0) && targetPage < 8);` 上限 8 页。**修正**：报告原写"连点 7 次后上千张卡"夸大——实际是 8 页 × 单页条目数（通常数百张），无虚拟化的结论不变 | 真实存在（影响下调） | ❌ |
| D-3 | `tv/data/AppStore.kt:155`、`:167` | 注释「超出按原顺序截断（新的在前）」+ `items.take(PINYIN_INDEX_LIMIT)`，而输入来自无序的 `seenSnapshot()` | 真实存在 | ❌ |
| D-4 | `tv/data/Net.kt:147` | `total += line.length + 1L`（字符数当字节） | 真实存在 | ❌ |
| D-5 | `tv/data/Net.kt:169` | `val imageClient: OkHttpClient get() = client` | 真实存在 | ❌ |
| D-8 | `tv/data/Repository.kt:97` | `runCatching {` 包住可取消挂起调用，`CancellationException` 被当失败 | 真实存在 | ❌ |
| D-9 | `tv/data/SegmentPrefetch.kt:64` | `// master 播放列表里列的是子播放列表，按分片去抓只会白下一个 m3u8` —— 注释说明现状，代码未跳过 | 真实存在 | ❌ |

---

## 5. 需要修正的表述（3 条，不影响"是否成立"）

| 编号 | 原表述 | 修正后 |
| --- | --- | --- |
| T-11 | "手机重复投同一地址时投屏页停在黑屏" | 仅当**已停留在投屏页**且 url+title 完全相同时，`screen` 数据类相等 → 不重建播放器，"重投"无法重启失败/黑屏的播放 |
| RPG-24 | "连点 7 次后上千张卡进 DOM" | 页数上限 8 页（`targetPage < 8`），实际是 8 页 × 单页条目数，量级数百；"无虚拟化 + 合并不设条目上限"的结论不变 |
| L9 | `test/.../TvUiScaleTest.kt` | 实际路径 `app/src/test/java/org/libretv/tv/ui/theme/TvUiScaleTest.kt` |

另：RPG-23 原在报告中标为 `[待确认]`，本轮回读 `DetailPanel.tsx:70-72` 与 `:131/:139` 的渲染逻辑后**确认为真实存在**。

---

## 6. 八条 P1 的可复现路径（按代码路径推导）

| 编号 | 复现步骤 | 预期现象 |
| --- | --- | --- |
| H1 | 桌面端播放一部中文片名影片 → 点投屏 → 选电视 | 电视端 `DlnaServer` 读 body 卡到 5s 超时，桌面侧 `dlna.ts` soap 失败；换成纯英文片名则成功 |
| H2 | 用一个 master 形态的多码率源（含 `#EXT-X-STREAM-INF`）起播 | 每个分片请求都带 `&live=1`，`/prefetch` 与 SegmentCache 命中率≈0；同一视频用单码率源则正常命中 |
| H3 | 电视端启动 → 焦点移到「短剧/体育/纪录片」等靠后分类 → 按 OK | 页面打开后无焦点框，方向键落点异常；从导航栏按 OK 进首页/搜索同样无焦点 |
| H4 | 桌面端设置 → 导入配置 → 选一个 `{}` 或任意 .json | 源/历史/收藏全部清空，弹绿色「已导入 0 个源、0 条历史」，内置源不恢复 |
| T-1 | 电视端点播 → 触发播放失败（拔网/坏源）→ 等自动换源成功或按「重试」 | 错误面板消失后遥控器除返回键全失效，只能退出重进 |
| T-2 | 电视端直播 → 播放失败（面板出现）→ 按方向键/OK | 面板三个按钮永远选不中，按 OK 反而触发播放/暂停 |
| RPL-01 | 桌面端播放 → 让所有源都失败（如断网后连按 S 换源） | 播放器区域全黑，只剩「正在切换到…」的 chip 或什么都没有，无重试/换源按钮，只能 Esc |
| RPL-02 | 桌面端播放 → 触发自动换源 → 在「正在切换到…」期间用下一集/选集跳集 | 换源成功后集数被改回换源前的旧集数 |

---

## 7. 修复状态汇总

### 7.1 验证当时（2026-10-29）

| 状态 | 条数 | 说明 |
| --- | --- | --- |
| 真实存在 + 未修复 | 88 | 全部 |
| 真实存在 + 已修复 | 0 | 仓库自审计以来零提交、零改动 |
| 不成立（误报） | 0 | 8 条此前已排除的候选（`CastDialog` 的 URL 解析与 invoke 拒绝等）未进入 88 条清单 |
| 表述需修正 | 3 | T-11 触发条件收窄、RPG-24 影响下调、L9 路径笔误（见 §5） |

### 7.2 修复之后（2026-10-30）

| 状态 | 条数 | 明细 |
| --- | --- | --- |
| 已修复 + 有回归护栏 | 86 | P1 8/8、P2 40/41、P3 38/39、上轮修复不完整 6/6。每条改动都在对应用例或反证脚本下验证过（20 处做了「改回旧实现 → 用例必须变红 → 恢复」） |
| 部分完成 | 1 | `L11`：已补 `.github/workflows/ci.yml`（桌面端 + 电视端两 job）与 `gradle wrapper`；只剩 macOS/Windows 打包的代码签名与公证（需开发者证书） |
| 未修 | 1 | `M5`（DNS rebinding TOCTOU）：需引入 `undici` 自建 `Agent` 在连接期做地址校验，属结构性改动，已在 `docs/audit-2026-10-29.md` §10.5 给出具体方案 |
| 不成立（误报） | 0 | 与验证时一致 |

回归基线（2026-10-30 实测）：`npm run typecheck` 通过；`npm run lint` **0 error / 0 warning**（验证时的 2 条已清零）；`npm test` **266 通过 / 14 文件**（验证时 250）；`./gradlew :app:testDebugUnitTest` **146 通过 / 19 文件 / 0 失败**（验证时 123 / 13）。

修复过程中新发现并已修的问题 4 条（含 H3 首版修复的二次缺陷 —— 由新增的 Compose UI 测试当场抓出），见 `docs/audit-2026-10-29.md` §10.6。

补充说明：验证阶段是**静态复核**。除 H1 外，其余条目要 100% 确证仍需按 §6 在真环境跑一遍；但"代码路径存在"这一层已经逐条落到行号，不存在"审计凭空推断"的风险。

### 7.3 当时的建议与实际执行

验证报告当时列了 4 条优先建议，实际执行情况：

1. **H1 先补单测再改** —— 已按此执行：先写 `cast/DlnaHttpTest.kt` 8 例，反证时把解析器改回按字符读，2 例立刻变红。这条建议是对的，它把"字符/字节混淆"从推理变成了可执行的失败用例。
2. **H2 用现成的 `isMasterPlaylist`** —— 已按此执行，改动只有 `liveMode` 一行加一个条件，加 1 个用例锁住。
3. **H4 + RPG-03/RPG-11 一起做** —— 已按此执行：`parseSnapshot` 校验 + 导入确认/备份/撤销 + 搜索缓存签名一起落地，一次把"导入配置"这条路补齐。
4. **电视端焦点三条一起改，并补 Compose UI 测试** —— 这条建议**救了 H3**：H3 首版修复（`remember(tick) { tick }`）逻辑上等于没修，是新增的 `AutoFocusUiTest` 第一次运行就报 `AssertionError` 才暴露的。审计当时说的"没有 UI 测试是这些缺陷反复漏掉的根因"，在修复阶段被自己验证了一遍。
