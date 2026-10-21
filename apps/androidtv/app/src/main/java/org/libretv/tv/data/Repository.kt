package org.libretv.tv.data

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

    suspend fun liveChannels(source: LiveSource): List<LiveChannel> {
        val text = net.getText(source.url, mapOf("Accept" to "application/x-mpegURL, text/plain, */*"))
        val channels = Parsers.parseM3u(text, source.url)
        if (channels.isEmpty()) throw IOException("未解析到可用频道")
        return channels.map { it.copy(sourceKey = source.key, sourceName = source.name) }
    }

    suspend fun importSubscription(url: String): ParsedSubscription {
        val text = net.getText(url)
        return Subscriptions.parse(text, url)
    }

    private fun originOf(url: String): String? = runCatching {
        val uri = java.net.URI(url)
        "${uri.scheme}://${uri.host}"
    }.getOrNull()
}
