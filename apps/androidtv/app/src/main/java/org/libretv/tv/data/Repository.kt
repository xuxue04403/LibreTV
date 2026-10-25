package org.libretv.tv.data

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.net.URLEncoder
import kotlinx.serialization.json.jsonObject

/**
 * 业务仓库：把「抓取 + 解析」封装成挂起函数。
 * 桌面端由 packages/core 承担同一职责，两端行为保持一致。
 */
class Repository(private val net: Net = Net) {
    /**
     * 会话内见过的条目，作为拼音检索的本地索引。
     *
     * 拼音只能在本地比对（采集站不支持），所以「已经搜过/浏览过」的东西
     * 必须留在内存里：用户先翻过动漫分类再敲 `qmmk`，不该再去抓一遍网络。
     */
    private val seenItems = java.util.concurrent.ConcurrentHashMap<String, SearchItem>()

    /** 当前已见过的条目快照（拼音索引持久化用） */
    fun seenSnapshot(): List<SearchItem> = seenItems.values.toList()

    fun rememberItems(items: List<SearchItem>) {
        for (item in items) seenItems["${item.sourceKey}:${item.vodId}"] = item
    }

    /**
     * 落盘目录缓存（由 ViewModel 在初始化时注入 store 里读出来的快照）。
     *
     * 缓存放这里而不是 ViewModel：`browseCategory` 是决定「要不要打网络」的地方，
     * 判断必须和读取在同一处，否则容易出现「界面说有缓存、数据层还是照抓一遍」。
     */
    @Volatile
    private var catalog: CatalogSnapshot? = null

    /** 目录缓存变更后通知外面落盘 */
    var onCatalogChanged: ((CatalogSnapshot) -> Unit)? = null

    fun installCatalog(snapshot: CatalogSnapshot?) {
        catalog = snapshot
    }

    fun catalogSnapshot(): CatalogSnapshot = catalog ?: CatalogSnapshot(signature = "")

    /** 写入某个分类的缓存条目（内存 + 回调落盘） */
    fun cacheCatalogItems(key: CategoryKey, items: List<SearchItem>) {
        val current = catalog
        val signature = current?.signature ?: return
        val next = (current).withEntry(key, items)
        if (next === current) return
        catalog = next
        onCatalogChanged?.invoke(next)
    }

    /**
     * 只记「这个分类刚查过」，不动内容。
     *
     * 空结果分不清「本来就没有」和「这次网络抽风」，两种情况都不该清空已有内容；
     * 但不记时间的话，空分类永远不算新鲜，后台每小时都为它重打一轮请求。
     */
    fun markCatalogChecked(key: CategoryKey) {
        val current = catalog ?: return
        val next = current.markChecked(key)
        catalog = next
        onCatalogChanged?.invoke(next)
    }

    /** 缓存里这个分类的内容；已过期也返回（界面先用旧内容顶上，后台再刷） */
    fun cachedCategory(key: CategoryKey): List<SearchItem>? = catalog?.itemsOf(key)

    /** 全局搜索用的关键词缓存由 ViewModel 持有，这里只暴露「有没有可用的源签名」 */
    fun catalogSignature(): String? = catalog?.signature?.takeIf { it.isNotEmpty() }


    /** 单源搜索：第一页拿 pagecount，再并行/顺序补齐后续页（默认最多 2 页，电视端不宜拖太久） */
    suspend fun search(
        source: VodSource,
        keyword: String,
        maxPages: Int = 2,
        timeoutMs: Long = 10_000,
    ): SourceOutcome {
        val started = System.currentTimeMillis()
        if (!source.url.startsWith("http")) {
            return SourceOutcome(source.key, source.name, false, error = "无效的源地址", ms = 0)
        }
        val base = source.url.trimEnd('/')
        val encoded = URLEncoder.encode(keyword, "UTF-8")

        val result = withTimeoutOrNull(timeoutMs) {
            runCatching {
                val firstText = net.getText("$base?ac=videolist&wd=$encoded&pg=1")
                val root = runCatching { LooseJson.parseToJsonElement(firstText).jsonObject }.getOrNull()
                val items = Parsers.parseSearchList(firstText, source).toMutableList()
                val pageCount = root?.str("pagecount")?.toIntOrNull() ?: 1
                val pages = minOf(maxPages, maxOf(1, pageCount))
                for (page in 2..pages) {
                    runCatching {
                        Parsers.parseSearchList(net.getText("$base?ac=videolist&wd=$encoded&pg=$page"), source)
                    }.getOrNull()?.let { items.addAll(it) }
                }
                items.distinctBy { it.vodId }.also { rememberItems(it) }
            }
        }

        val elapsed = System.currentTimeMillis() - started
        return when {
            result == null -> SourceOutcome(source.key, source.name, false, error = "请求超时", timedOut = true, ms = elapsed)
            result.isSuccess -> SourceOutcome(source.key, source.name, true, items = result.getOrThrow(), ms = elapsed)
            else -> SourceOutcome(
                source.key,
                source.name,
                false,
                error = result.exceptionOrNull()?.message ?: "失败",
                ms = elapsed,
            )
        }
    }

    /** 多源并行搜索：每个源结算即 send 一条，UI 边收边渲染 */
    fun searchAll(
        sources: List<VodSource>,
        keyword: String,
        adultFilter: Boolean,
        maxPages: Int = 2,
        timeoutMs: Long = 10_000,
    ): Flow<SourceOutcome> = channelFlow {
        sources.forEach { source ->
            launch {
                val outcome = search(source, keyword, maxPages, timeoutMs)
                send(filterOutcome(outcome, keyword, adultFilter))
            }
        }
    }

    private fun filterOutcome(outcome: SourceOutcome, keyword: String, adultFilter: Boolean): SourceOutcome {
        if (!outcome.ok) return outcome
        val filtered = Parsers.filterAdult(Parsers.filterRelevant(outcome.items, keyword), adultFilter)
        return outcome.copy(items = filtered)
    }

    suspend fun detail(source: VodSource, vodId: String): VodDetail {
        if (!vodId.matches(Regex("^[\\w-]+$"))) throw IOException("无效的视频ID")
        val base = source.url.trimEnd('/')
        val api = "$base?ac=videolist&ids=${URLEncoder.encode(vodId, "UTF-8")}"

        runCatching { net.getText(api) }.getOrNull()?.let { text ->
            runCatching { Parsers.parseDetail(text) }.getOrNull()
                ?.takeIf { it.episodes.isNotEmpty() }
                ?.let { return it }
        }

        val root = (source.detail ?: originOf(source.url))?.trimEnd('/') ?: throw IOException("获取详情失败")
        val html = net.getText("$root/index.php/vod/detail/id/$vodId.html")
        val pageDetail = Parsers.parseDetailPage(html)
        if (pageDetail.episodes.isEmpty()) throw IOException("未找到播放资源")
        return pageDetail
    }

    /**
     * 按片名反查其它可用源。
     *
     * 从「观看记录」「收藏」进入播放时手里只有一个源，一旦它挂了就无路可走。
     * 这里用片名再搜一轮，把其它源的同名影片补进候选链 —— 只在候选全部
     * 失败后才调用，不影响正常起播速度。与桌面端 discoverCandidates 一致。
     */
    suspend fun discoverCandidates(
        title: String,
        sources: List<VodSource>,
        exclude: Set<String> = emptySet(),
        maxPages: Int = 1,
        timeoutMs: Long = 8_000,
    ): List<PlaybackCandidate> {
        // 搜索词用原片名：采集站是 LIKE '%wd%'，归一化后的 thematrix 匹配不到 The Matrix。
        // 归一化只用于比对结果，不能拿来查询。
        val keyword = title.trim()
        if (keyword.isEmpty() || sources.isEmpty()) return emptyList()

        val outcomes: List<SourceOutcome> = coroutineScope {
            sources.map { source ->
                async { search(source, keyword, maxPages, timeoutMs) }
            }.awaitAll()
        }

        val wanted = keyword.lowercase()
        val items = outcomes
            .filter { it.ok }
            .flatMap { it.items }
            .filter { item ->
                if ("${item.sourceKey}:${item.vodId}" in exclude) return@filter false
                val name = Parsers.normalizeTitle(item.name).lowercase()
                name.isNotEmpty() && (name == wanted || name.contains(wanted) || wanted.contains(name))
            }
        return PlaybackCandidate.build(items, sources)
    }

    /**
     * 依次尝试候选链，返回第一个能拿到播放地址的结果。
     *
     * onSkip 用来把「某个源失败」反馈到界面；回调异常不影响整体流程。
     */
    suspend fun firstPlayable(candidates: List<PlaybackCandidate>): Pair<PlaybackCandidate, VodDetail>? {
        for (candidate in candidates) {
            val detail = runCatching { detail(candidate.source, candidate.vodId) }.getOrNull()
            if (detail != null && detail.episodes.isNotEmpty()) return candidate to detail
        }
        return null
    }

    suspend fun liveChannels(source: LiveSource, adultFilter: Boolean = true): List<LiveChannel> {
        val text = net.getText(source.url, mapOf("Accept" to "application/x-mpegURL, text/plain, */*"))
        val parsed = Parsers.parseM3u(text, source.url)
        if (parsed.isEmpty()) throw IOException("未解析到可用频道")
        // 直播此前完全没有成人过滤：用户自加的 M3U 成人类目会原样露出
        val channels = Parsers.filterAdultChannels(parsed, adultFilter)
        return channels.map { it.copy(sourceKey = source.key, sourceName = source.name) }
    }

    /**
     * 渐进式拉取直播源：边下边解析，每凑一批就回调。
     *
     * 为什么不用 liveChannels：index.m3u 有 2.46MB、服务器限速到 ~35KB/s，
     * 整串读完要 70 秒，而解析只要十几毫秒。边下边显示能把「看到第一个频道」
     * 从 70 秒压到 1 秒左右。
     *
     * @param onBatch 每批已过滤的新频道（调用方自行合并去重）
     * @return 全部频道；中途异常由调用方 runCatching 处理
     */
    suspend fun liveChannelsStream(
        source: LiveSource,
        adultFilter: Boolean = true,
        batchSize: Int = 120,
        onBytes: (Long) -> Unit = {},
        onBatch: suspend (List<LiveChannel>) -> Unit,
    ): List<LiveChannel> {
        val parser = Parsers.M3uLineParser(source.url)
        val all = ArrayList<LiveChannel>()
        var batch = ArrayList<LiveChannel>(batchSize)

        net.forEachLine(
            source.url,
            headers = mapOf("Accept" to "application/x-mpegURL, text/plain, */*"),
            onBytes = onBytes,
        ) { line ->
            val channel = parser.push(line) ?: return@forEachLine true
            if (!adultFilter || !Parsers.isAdultChannel(channel.name, channel.group, channel.tvgId)) {
                val decorated = channel.copy(sourceKey = source.key, sourceName = source.name)
                all += decorated
                batch += decorated
                if (batch.size >= batchSize) {
                    onBatch(batch)
                    batch = ArrayList(batchSize)
                }
            }
            true
        }
        if (batch.isNotEmpty()) onBatch(batch)
        if (all.isEmpty()) throw IOException("未解析到可用频道")
        return all
    }

    /** 分类表缓存（6 小时内复用，切分类不重复打上游）。分类页会并行抓多个源，必须并发安全 */
    private val categoryCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, List<SourceCategory>>>()

    private suspend fun categoriesOf(source: VodSource): List<SourceCategory> {
        val cached = categoryCache[source.url]
        if (cached != null && System.currentTimeMillis() - cached.first < 6 * 60 * 60 * 1000L) return cached.second
        val base = source.url.trimEnd('/')
        val categories = Categories.parse(Net.gated(source.url) { net.getText("$base?ac=list&pg=1") })
        categoryCache[source.url] = System.currentTimeMillis() to categories
        return categories
    }

    /**
     * 按分类浏览：拉分类表 → 找叶子 type_id → 并行抓第一页。
     * 返回 (是否支持该分类, 条目, 说明)。
     *
     * adultFilter 默认开启：与搜索保持一致。「伦理片」名字带「片」会被归入电影桶，
     * 不过滤的话首页分类会直接露出成人内容。
     *
     * [useCache] 为 true 时优先返回落盘缓存（进程重启后依然有效），
     * 只有缓存缺失才打网络。后台刷新走 `useCache = false`。
     */
    suspend fun browseCategory(
        source: VodSource,
        key: CategoryKey,
        // 4 而不是 6：实测 typeLimit=6 要 6577ms / 459 部，=4 只要 3847ms / 300 部，
        // 少抓两个子分类省下近 3 秒，而首屏本来也看不完 460 部。
        typeLimit: Int = 4,
        timeoutMs: Long = 14_000,
        adultFilter: Boolean = true,
        useCache: Boolean = true,
    ): Triple<Boolean, List<SearchItem>, String?> {
        val started = System.currentTimeMillis()
        // 切回上一个分类时如果重新打一遍各源，体感就是「每次切分类都在重新加载播放源」。
        // 缓存 5 分钟：分类内的第一批内容在这个时间尺度上几乎不会变。
        val cacheKey = "${source.key}|$key|$typeLimit|${if (adultFilter) 1 else 0}"
        if (useCache) {
            browseCache[cacheKey]?.let { (at, cached) ->
                if (System.currentTimeMillis() - at < BROWSE_TTL_MS) return cached
            }
        }
        return try {
            val result = withTimeoutOrNull(timeoutMs) {
                val categories = categoriesOf(source)
                val ids = Categories.typeIds(categories, key, typeLimit)
                if (ids.isEmpty()) {
                    // 「源答了，但它没有这个分类」既不是成功也不是失败：算失败会让
                    // 界面上多出一个「N 个源失败」，用户以为网络出问题；算成功又会
                    // 把 supportedSources 抬高。用标记值单独表达，与桌面端
                    // categories.ts 的 ok:true + supported:false 对齐。
                    return@withTimeoutOrNull Triple(false, emptyList(), UNSUPPORTED_NOTE)
                }
                val base = source.url.trimEnd('/')
                // 子分类并行抓取：父分类不聚合子分类内容
                val lists = ids.map { typeId ->
                    async {
                        runCatching {
                            Parsers.parseSearchList(
                                Net.gated(source.url) { net.getText("$base?ac=videolist&t=$typeId&pg=1") },
                                source,
                            )
                        }.getOrDefault(emptyList())
                    }
                }.awaitAll()
                val merged = Parsers.filterAdult(lists.flatten().distinctBy { it.vodId }, adultFilter)
                rememberItems(merged)
                Triple(true, merged, null)
            }
            result ?: Triple(false, emptyList(), "请求超时（>${timeoutMs / 1000}s）")
        } catch (err: Exception) {
            Triple(false, emptyList(), err.message ?: "失败")
        }.also { final ->
            // 只缓存有结论的结果：失败的源下次还要重试，否则会一直显示「失败」
            if (final.first) browseCache[cacheKey] = System.currentTimeMillis() to final
            // 便于日志排查：单源耗时
            System.currentTimeMillis() - started
        }
    }

    /**
     * 从落盘缓存里还原某个分类（跨源合并后的条目）。
     *
     * 返回 null 表示缓存里没有这个分类，调用方应当走网络。
     */
    fun cachedCategoryItems(key: CategoryKey): List<SearchItem>? = cachedCategory(key)


    /** 分类浏览结果缓存：切回上一个分类应当立刻出内容 */
    private val browseCache =
        java.util.concurrent.ConcurrentHashMap<String, Pair<Long, Triple<Boolean, List<SearchItem>, String?>>>()

    private companion object {
        const val BROWSE_TTL_MS = 5 * 60 * 1000L

        /** 「源没有这个分类」的标记：既不计数成功，也不计入失败数 */
        const val UNSUPPORTED_NOTE = "__unsupported__"
    }

    /** 这个源是否只是「没有该分类」，而不是请求失败 */
    fun isUnsupported(note: String?): Boolean = note == UNSUPPORTED_NOTE

    /**
     * 拼音首字母检索。
     *
     * 采集站的 `wd` 只支持中文 LIKE，拼音必然只能在本地做，所以先建索引：
     * 1. 本次会话已经见过的条目（搜索/分类浏览留下的），命中即出，零网络；
     * 2. 再扫每个源的「最新列表」（`?ac=videolist&pg=n`，不带 wd/t 就是全站最新），
     *    抓到不满一页就停，避免白跑。
     *
     * 每源默认 4 页（80 条），4 个源并发，电视上大约 2~4 秒。
     */
    suspend fun pinyinSearch(
        sources: List<VodSource>,
        query: String,
        adultFilter: Boolean,
        pagesPerSource: Int = 4,
        timeoutMs: Long = 9_000,
    ): List<SearchItem> {
        if (!Pinyin.ready || !Pinyin.isQuery(query)) return emptyList()
        val cached = seenItems.values.filter { Pinyin.matches(it.name, query) }

        val fresh = coroutineScope {
            sources.map { source ->
                async {
                    withTimeoutOrNull(timeoutMs) {
                        runCatching {
                            val base = source.url.trimEnd('/')
                            val collected = mutableListOf<SearchItem>()
                            for (page in 1..pagesPerSource) {
                                val text = net.getText("$base?ac=videolist&pg=$page")
                                val parsed = Parsers.parseSearchList(text, source)
                                collected += parsed
                                if (parsed.size < 20) break
                            }
                            collected
                        }.getOrDefault(emptyList())
                    } ?: emptyList()
                }
            }.awaitAll().flatten()
        }
        rememberItems(fresh)

        return (fresh + cached)
            .filter { Pinyin.matches(it.name, query) }
            .let { Parsers.filterAdult(it, adultFilter) }
            .distinctBy { "${it.sourceKey}:${it.vodId}" }
    }

    suspend fun importSubscription(url: String): ParsedSubscription {
        val text = net.getText(url)
        return Subscriptions.parse(text, url)
    }

    /**
     * 探测哪些分类真的有内容（首页只显示有内容的分类入口）。
     *
     * 每个分类只抓 1 页、每源最多 1 个子分类，开销可控；分类表本身有 6 小时缓存，
     * 二次进入首页几乎零开销。结果按 [CategoryKey.home] 的行程序返回。
     */
    suspend fun probeCategories(
        sources: List<VodSource>,
        adultFilter: Boolean = true,
        typeLimit: Int = 1,
        timeoutMs: Long = 12_000,
    ): Map<CategoryKey, Int> = coroutineScope {
        CategoryKey.home.map { key ->
            async {
                var hits = 0
                for (source in sources) {
                    val (ok, list, _) = browseCategory(source, key, typeLimit, timeoutMs, adultFilter)
                    if (ok && list.isNotEmpty()) hits++
                }
                key to hits
            }
        }.awaitAll().toMap()
    }

    private fun originOf(url: String): String? = runCatching {
        val uri = java.net.URI(url)
        "${uri.scheme}://${uri.host}"
    }.getOrNull()
}
