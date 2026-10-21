package org.libretv.tv.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * 采集站响应 / M3U / 订阅的纯函数解析层。
 *
 * 与桌面端 packages/core（源自 LibreTV src/lib）保持同一语义：
 * 搜索列表、分集提取、详情兜底、M3U 解析、相关性过滤、成人过滤。
 * 放在纯 Kotlin 里，便于在 JVM 单测中验证（不依赖 Android）。
 */
object Parsers {

    private val M3U8_PATTERN = Regex("""\${'$'}https?://[^"'\s]+?\.m3u8""")
    private val ATTR_RE = Regex("""([a-zA-Z0-9_-]+)="([^"]*)"""")
    private val ATTR_STRIP_RE = Regex("""[a-zA-Z0-9_-]+="[^"]*"""")

    // —— 点播 ——

    fun parseSearchList(text: String, source: VodSource): List<SearchItem> {
        val root = LooseJson.parseToJsonElement(text).jsonObject
        val list = root["list"]
        if (list == null || list is kotlinx.serialization.json.JsonNull) return emptyList()
        val arr = list as? JsonArray ?: throw IllegalArgumentException("API返回的数据格式无效")
        return arr.mapNotNull { element ->
            val vod = element as? JsonObject ?: return@mapNotNull null
            val id = vod.str("vod_id") ?: return@mapNotNull null
            SearchItem(
                sourceKey = source.key,
                sourceName = source.name,
                vodId = id,
                name = vod.str("vod_name").orEmpty(),
                pic = vod.str("vod_pic"),
                typeName = vod.str("type_name"),
                year = vod.str("vod_year"),
                area = vod.str("vod_area"),
                remarks = vod.str("vod_remarks"),
                sourceUrl = source.url,
                isAdult = source.isAdult,
            )
        }
    }

    /**
     * 从 vod_play_url 提取分集：`线路1$$$线路2`，线路内 `集名$地址#集名$地址`。
     * 优先取含 m3u8 的线路（部分源第一条是网页中转页）。
     */
    fun extractEpisodes(playUrl: String): List<String> {
        if (playUrl.isBlank()) return emptyList()
        val groups = playUrl.split("$$$").map { group ->
            group.split("#").mapNotNull { ep ->
                val parts = ep.split("$")
                if (parts.size > 1) parts[1].takeIf { it.startsWith("http://") || it.startsWith("https://") } else null
            }
        }.filter { it.isNotEmpty() }
        if (groups.isEmpty()) return emptyList()
        return groups.firstOrNull { eps -> eps.any { it.contains(".m3u8") } } ?: groups.first()
    }

    fun extractM3u8FromText(text: String): List<String> =
        M3U8_PATTERN.findAll(text).map { it.value.removePrefix("$") }.toList()

    fun parseDetail(text: String): VodDetail {
        val root = LooseJson.parseToJsonElement(text).jsonObject
        val first = root["list"]?.let { it as? JsonArray }?.firstOrNull() as? JsonObject
            ?: throw IllegalStateException("获取到的详情内容无效")
        var episodes = extractEpisodes(first.str("vod_play_url").orEmpty())
        if (episodes.isEmpty()) episodes = extractM3u8FromText(first.str("vod_content").orEmpty())
        return VodDetail(
            episodes = episodes,
            title = first.str("vod_name"),
            cover = first.str("vod_pic"),
            desc = first.str("vod_content"),
            typeName = first.str("type_name"),
            year = first.str("vod_year"),
            area = first.str("vod_area"),
            remarks = first.str("vod_remarks"),
            actor = first.str("vod_actor"),
        )
    }

    /** 详情页 HTML 兜底：部分源列表接口不返回播放地址 */
    fun parseDetailPage(html: String): VodDetail {
        var matches = Regex("""\${'$'}(https?://[^"'\s]+?\.m3u8)""").findAll(html).map { it.value }.toList()
        if (matches.isEmpty()) {
            matches = Regex("""\${'$'}(https?://[^"'\s]+?/\d{8}/\d+_[a-f0-9]+/index\.m3u8)""").findAll(html).map { it.value }.toList()
        }
        val episodes = matches.map { link ->
            val raw = link.removePrefix("$")
            val paren = raw.indexOf('(')
            if (paren > 0) raw.substring(0, paren) else raw
        }.distinct()
        val title = Regex("<h1[^>]*>([^<]+)</h1>").find(html)?.groupValues?.getOrNull(1)?.trim()
        return VodDetail(episodes, title, null, null, null, null, null, null, null)
    }

    // —— 相关性 / 成人过滤 ——

    private val PUNCT = Regex("""[\s\p{P}\p{S}]+""")

    fun normalizeTitle(s: String): String = s.lowercase().replace(PUNCT, "")

    /** 忽略标点与大小写；多词查询要求每个词都命中 */
    fun isRelevant(name: String, keyword: String): Boolean {
        val normalizedName = normalizeTitle(name)
        val normalizedKeyword = normalizeTitle(keyword)
        if (normalizedKeyword.isEmpty()) return true
        if (normalizedName.contains(normalizedKeyword)) return true
        val tokens = keyword.trim().split(Regex("\\s+")).map(::normalizeTitle).filter { it.isNotEmpty() }
        return tokens.size > 1 && tokens.all { normalizedName.contains(it) }
    }

    /** 成人分类关键词（与桌面端 packages/core/src/cms.ts 的 ADULT_KEYWORDS 对齐） */
    private val ADULT_KEYWORDS = listOf(
        "伦理片", "福利", "倫理片", "福利片", "日本伦理", "日本福利", "日本福利片", "日本伦理片",
        "擦边短剧", "擦边", "韩国伦理", "里番动漫", "门事件", "萝莉少女", "制服诱惑", "国产传媒",
        "cosplay", "黑丝诱惑", "无码", "日本无码", "有码", "日本有码", "SWAG", "网红主播",
        "色情片", "同性片", "福利视频", "无码高清", "有码高清", "91视频", "自拍偷拍", "mini传媒",
    )

    /**
     * 成人**标题**关键词：兜住「分类正常、片名露骨」的漏网。
     * 依据同桌面端实测（「我的23岁之无码青春」在爱情片、「黑料局中局」在短剧）。
     * 刻意不含 `黑料`/`麻豆`/`星空`/`天美`/`果冻`/`蜜桃`，它们在真实数据里大量是正经内容。
     */
    private val ADULT_TITLE_KEYWORDS = listOf(
        "无码", "無碼", "有码", "里番", "裏番", "三级片", "三級片", "A片",
        "情色片", "色情片", "成人片", "限制级", "限制級", "自拍偷拍", "偷拍自拍",
        "国产自拍", "国产传媒", "传媒出品", "门事件", "門事件", "裸聊", "催情",
        "午夜剧场", "午夜神器", "伦理电影", "倫理電影",
        // 与 TS 侧对齐：A/B 实测中开启过滤后仍漏出的 13 条全部集中在「情色」根词上。
        // 刻意不加英文 sex / porn（会误杀 Sex and the City 这类西片）。
        "情色", "色情", "成人视频", "成人电影",
    )

    /** 分类名误伤排除：「福利院的阳光」这类正经内容不能被杀 */
    private val ADULT_TYPE_EXCEPTIONS = Regex("福利院|福利社|少年福利|儿童福利|社会福利")

    /** 频道成人类目关键词（直播此前完全没有过滤） */
    private val ADULT_LIVE_KEYWORDS = listOf(
        "成人", "18+", "18禁", "限制级", "色情", "情色", "伦理", "午夜", "深夜福利",
        "裸", "无码", "有码", "自慰", "约炮", "sex", "xxx", "porn", "adult", "erotic",
        "playboy", "brazzers",
    )

    /**
     * 是否成人内容。三个来源命中任一即屏蔽：
     * 1. 来源被标记为成人源；2. 分类名命中；3. 标题命中标题词表。
     */
    fun isAdult(typeName: String?, name: String? = null, sourceIsAdult: Boolean = false): Boolean {
        if (sourceIsAdult) return true
        if (typeName != null && !ADULT_TYPE_EXCEPTIONS.containsMatchIn(typeName)) {
            if (ADULT_KEYWORDS.any { typeName.contains(it, ignoreCase = true) }) return true
        }
        if (name != null && ADULT_TITLE_KEYWORDS.any { name.contains(it, ignoreCase = true) }) return true
        return false
    }

    fun isAdultChannel(name: String?, group: String?, tvgId: String?): Boolean {
        val haystack = "${group.orEmpty()} ${name.orEmpty()} ${tvgId.orEmpty()}"
        if (haystack.isBlank()) return false
        return ADULT_LIVE_KEYWORDS.any { haystack.contains(it, ignoreCase = true) }
    }

    fun filterRelevant(items: List<SearchItem>, keyword: String): List<SearchItem> =
        items.filter { isRelevant(it.name, keyword) }

    fun filterAdult(items: List<SearchItem>, enabled: Boolean): List<SearchItem> =
        if (!enabled) items else items.filter { !isAdult(it.typeName, it.name, it.isAdult) }

    /** 直播频道过滤：分组名、台名、tvg-id 任一命中即剔除 */
    fun filterAdultChannels(channels: List<LiveChannel>, enabled: Boolean): List<LiveChannel> =
        if (!enabled) channels
        else channels.filter { !isAdultChannel(it.name, it.group, it.tvgId) }

    /** 同名同年的聚合键（与桌面端 groupSearchResults 一致） */
    fun groupKey(item: SearchItem): String {
        val title = normalizeTitle(item.name)
        val year = item.year?.trim().orEmpty()
        return if (year.isNotEmpty()) "$title#$year" else title
    }

    fun group(items: List<SearchItem>): List<SearchGroup> {
        val map = LinkedHashMap<String, MutableList<SearchItem>>()
        for (item in items) {
            val key = groupKey(item)
            if (key.isEmpty()) continue
            map.getOrPut(key) { mutableListOf() }.add(item)
        }
        return map.map { (key, list) ->
            SearchGroup(
                key = key,
                name = list.first().name,
                items = list.sortedBy { it.sourceName },
            )
        }
    }

    // —— M3U / 直播 ——

    fun normalizeStreamUrl(raw: String, baseUrl: String? = null): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        val base = baseUrl?.trim()?.takeIf { it.isNotEmpty() }

        // java.net.URI 对含空格（以及控制字符）的 baseUrl 会抛 URISyntaxException，
        // 之前被 runCatching 吞掉，导致整个源「未解析到可用频道」。
        // 先做一次最小转义再解析，失败才退化为「只认绝对地址」。
        if (base != null) {
            val safeBase = base.replace(" ", "%20")
            val fromBase = runCatching { java.net.URI(safeBase).resolve(trimmed).toURL().toString() }.getOrNull()
            if (fromBase != null) return fromBase.takeIf { it.isHttpUrl() }
        }

        val direct = runCatching { java.net.URI(trimmed.replace(" ", "%20")).toURL().toString() }.getOrNull()
        return direct?.takeIf { it.isHttpUrl() }
    }

    private fun String.isHttpUrl(): Boolean =
        startsWith("http://", ignoreCase = true) || startsWith("https://", ignoreCase = true)

    fun parseM3u(content: String, baseUrl: String? = null): List<LiveChannel> {
        val channels = mutableListOf<LiveChannel>()
        if (content.isBlank()) return channels
        val seen = HashSet<String>()
        var attrs: Map<String, String> = emptyMap()
        var title = ""
        var extGroup = ""
        var pending = false

        for (raw in content.lineSequence()) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            if (line.startsWith("#EXTINF", ignoreCase = true)) {
                attrs = ATTR_RE.findAll(line).associate { it.groupValues[1].lowercase() to it.groupValues[2].trim() }
                val stripped = line.replace(ATTR_STRIP_RE, "").replace(Regex("^#EXTINF\\s*:\\s*", RegexOption.IGNORE_CASE), "")
                val comma = stripped.indexOf(',')
                title = (if (comma >= 0) stripped.substring(comma + 1) else stripped)
                    .trim()
                    .trim('"')
                extGroup = ""
                pending = true
                continue
            }
            if (line.startsWith("#EXTGRP:", ignoreCase = true)) {
                val g = line.substring(8).trim()
                if (pending && g.isNotEmpty() && attrs["group-title"].isNullOrEmpty()) extGroup = g
                continue
            }
            if (line.startsWith("#")) continue

            val url = normalizeStreamUrl(line, baseUrl)
            pending = false
            if (url == null || !seen.add(url)) continue
            val tvgId = attrs["tvg-id"]?.takeIf { it.isNotBlank() }
            val logo = attrs["tvg-logo"]?.let { normalizeStreamUrl(it, baseUrl) }
            channels += LiveChannel(
                id = tvgId ?: stableId(url),
                name = title.ifBlank { nameFromUrl(url) },
                url = url,
                logo = logo,
                group = attrs["group-title"]?.takeIf { it.isNotBlank() } ?: extGroup.ifBlank { null },
                tvgId = tvgId,
            )
        }
        return channels
    }

    fun groups(channels: List<LiveChannel>): List<String> {
        val out = LinkedHashSet<String>()
        channels.forEach { out.add(it.group ?: "未分组") }
        return out.toList()
    }

    fun parseM3uEpgUrl(content: String, baseUrl: String? = null): String? {
        val first = content.lineSequence().firstOrNull() ?: return null
        if (!first.trim().startsWith("#EXTM3U", ignoreCase = true)) return null
        val m = Regex("""(?:x-tvg-url|url-tvg)="([^"]+)"""", RegexOption.IGNORE_CASE).find(first) ?: return null
        return normalizeStreamUrl(m.groupValues[1].split(",")[0], baseUrl)
    }

    private fun nameFromUrl(url: String): String = runCatching {
        val uri = java.net.URI(url)
        val last = uri.path?.split("/")?.filter { it.isNotBlank() }?.lastOrNull()
        last?.substringBeforeLast(".")?.takeIf { it.isNotBlank() } ?: uri.host ?: "未命名频道"
    }.getOrDefault("未命名频道")

    fun stableId(input: String): String {
        var h = 5381u
        for (ch in input) h = (h shl 5) + h + ch.code.toUInt()
        return h.toString(36)
    }
}
