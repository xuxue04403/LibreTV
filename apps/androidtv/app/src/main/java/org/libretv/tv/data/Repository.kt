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
                items.distinctBy { it.vodId }
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

    suspend fun liveChannels(source: LiveSource, adultFilter: Boolean = true): List<LiveChannel> {
        val text = net.getText(source.url, mapOf("Accept" to "application/x-mpegURL, text/plain, */*"))
        val parsed = Parsers.parseM3u(text, source.url)
        if (parsed.isEmpty()) throw IOException("未解析到可用频道")
        // 直播此前完全没有成人过滤：用户自加的 M3U 成人类目会原样露出
        val channels = Parsers.filterAdultChannels(parsed, adultFilter)
        return channels.map { it.copy(sourceKey = source.key, sourceName = source.name) }
    }

    /** 分类表缓存（6 小时内复用，切分类不重复打上游）。分类页会并行抓多个源，必须并发安全 */
    private val categoryCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, List<SourceCategory>>>()

    private suspend fun categoriesOf(source: VodSource): List<SourceCategory> {
        val cached = categoryCache[source.url]
        if (cached != null && System.currentTimeMillis() - cached.first < 6 * 60 * 60 * 1000L) return cached.second
        val base = source.url.trimEnd('/')
        val categories = Categories.parse(net.getText("$base?ac=list&pg=1"))
        categoryCache[source.url] = System.currentTimeMillis() to categories
        return categories
    }

    /**
     * 按分类浏览：拉分类表 → 找叶子 type_id → 并行抓第一页。
     * 返回 (是否支持该分类, 条目, 说明)。
     *
     * adultFilter 默认开启：与搜索保持一致。「伦理片」名字带「片」会被归入电影桶，
     * 不过滤的话首页分类会直接露出成人内容。
     */
    suspend fun browseCategory(
        source: VodSource,
        key: CategoryKey,
        typeLimit: Int = 6,
        timeoutMs: Long = 14_000,
        adultFilter: Boolean = true,
    ): Triple<Boolean, List<SearchItem>, String?> {
        val started = System.currentTimeMillis()
        return try {
            val result = withTimeoutOrNull(timeoutMs) {
                val categories = categoriesOf(source)
                val ids = Categories.typeIds(categories, key, typeLimit)
                if (ids.isEmpty()) return@withTimeoutOrNull Triple(false, emptyList(), null)
                val base = source.url.trimEnd('/')
                // 子分类并行抓取：父分类不聚合子分类内容
                val lists = ids.map { typeId ->
                    async {
                        runCatching {
                            Parsers.parseSearchList(net.getText("$base?ac=videolist&t=$typeId&pg=1"), source)
                        }.getOrDefault(emptyList())
                    }
                }.awaitAll()
                val merged = Parsers.filterAdult(lists.flatten().distinctBy { it.vodId }, adultFilter)
                Triple(true, merged, null)
            }
            result ?: Triple(false, emptyList(), "请求超时（>${timeoutMs / 1000}s）")
        } catch (err: Exception) {
            Triple(false, emptyList(), err.message ?: "失败")
        }.also {
            // 便于日志排查：单源耗时
            System.currentTimeMillis() - started
        }
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
