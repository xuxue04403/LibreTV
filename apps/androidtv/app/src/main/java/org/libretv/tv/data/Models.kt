package org.libretv.tv.data

import kotlinx.serialization.Serializable

/** 点播源：Apple CMS 采集站 */
@Serializable
data class VodSource(
    val key: String,
    val name: String,
    val url: String,
    val detail: String? = null,
    val isAdult: Boolean = false,
    /** 是否为内置默认源（内置源可在设置里一键恢复） */
    val builtin: Boolean = false,
)

/** 直播源：M3U 订阅 */
@Serializable
data class LiveSource(
    val key: String,
    val name: String,
    val url: String,
    val epg: String? = null,
    val builtin: Boolean = false,
)

data class SearchItem(
    val sourceKey: String,
    val sourceName: String,
    val vodId: String,
    val name: String,
    val pic: String? = null,
    val typeName: String? = null,
    val year: String? = null,
    val area: String? = null,
    val remarks: String? = null,
    val sourceUrl: String? = null,
    /** 订阅里标记为成人源的条目：此前解析后就丢弃了，导致该标记形同虚设 */
    val isAdult: Boolean = false,
)

/** 同名影片跨源聚合卡片 */
data class SearchGroup(
    val key: String,
    val name: String,
    val items: List<SearchItem>,
)

/**
 * 一个可尝试的播放源（失败转移用）。
 *
 * 与桌面端 packages/core 的 PlaybackCandidate 一一对应：同一个影片在
 * 不同采集站的 vodId 不同，所以必须成对保存源与 id。
 */
data class PlaybackCandidate(
    val source: VodSource,
    val vodId: String,
    val sourceName: String = source.name,
) {
    val key: String get() = "${source.key}:$vodId"

    companion object {
        /** 单条候选链的最大长度：覆盖常见聚合结果，又不至于把失败检测拖太久 */
        const val MAX = 8

        fun of(item: SearchItem, sources: List<VodSource>): PlaybackCandidate? {
            val source = sources.firstOrNull { it.key == item.sourceKey }
                ?: item.sourceUrl?.takeIf { it.startsWith("http") }?.let {
                    VodSource(item.sourceKey, item.sourceName, it, isAdult = item.isAdult)
                }
                ?: return null
            return PlaybackCandidate(source, item.vodId, item.sourceName.ifEmpty { source.name })
        }

        /**
         * 把同片源搜索结果整理成候选链，当前正在播放的源排第一。
         *
         * 去重、跳过拿不到详情的源；顺序沿用搜索结果（已按源名排序），保证两端一致。
         */
        fun build(
            items: List<SearchItem>,
            sources: List<VodSource>,
            active: Pair<String, String>? = null,
            limit: Int = MAX,
        ): List<PlaybackCandidate> {
            val seen = HashSet<String>()
            val out = ArrayList<PlaybackCandidate>()
            for (item in items) {
                val candidate = of(item, sources) ?: continue
                if (!seen.add(candidate.key)) continue
                out += candidate
            }
            if (active != null) {
                val index = out.indexOfFirst { it.source.key == active.first && it.vodId == active.second }
                if (index > 0) out.add(0, out.removeAt(index))
            }
            return if (out.size > limit) out.subList(0, limit).toList() else out
        }
    }
}

data class SourceOutcome(
    val sourceKey: String,
    val sourceName: String,
    val ok: Boolean,
    val items: List<SearchItem> = emptyList(),
    val error: String? = null,
    val timedOut: Boolean = false,
    val ms: Long = 0,
)

data class VodDetail(
    val episodes: List<String>,
    val title: String?,
    val cover: String?,
    val desc: String?,
    val typeName: String?,
    val year: String?,
    val area: String?,
    val remarks: String?,
    val actor: String?,
)

data class LiveChannel(
    val id: String,
    val name: String,
    val url: String,
    val logo: String? = null,
    val group: String? = null,
    val tvgId: String? = null,
    val sourceKey: String = "",
    val sourceName: String = "",
)

@Serializable
data class HistoryEntry(
    val id: String,
    val sourceKey: String,
    val vodId: String,
    val title: String,
    val cover: String? = null,
    val sourceName: String,
    val episodeIndex: Int,
    val episodeCount: Int,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val updatedAt: Long = 0L,
)

@Serializable
data class FavoriteEntry(
    val id: String,
    val sourceKey: String,
    val vodId: String,
    val title: String,
    val cover: String? = null,
    val createdAt: Long = 0L,
)

@Serializable
data class LiveFavoriteEntry(
    val url: String,
    val name: String,
    val logo: String? = null,
    val createdAt: Long = 0L,
)

@Serializable
data class AppSettings(
    val adultFilter: Boolean = true,
    val autoplayNext: Boolean = true,
    val resumePlayback: Boolean = true,
)

@Serializable
data class AppData(
    val sources: List<VodSource> = emptyList(),
    val selected: List<String> = emptyList(),
    val liveSources: List<LiveSource> = emptyList(),
    val liveSelected: List<String> = emptyList(),
    val history: List<HistoryEntry> = emptyList(),
    val favorites: List<FavoriteEntry> = emptyList(),
    val liveFavorites: List<LiveFavoriteEntry> = emptyList(),
    val settings: AppSettings = AppSettings(),
    /** 是否已完成首次启动的默认源导入 */
    val seeded: Boolean = false,
) {
    fun activeSources(): List<VodSource> = sources.filter { it.key in selected }
    fun activeLiveSources(): List<LiveSource> = liveSources.filter { it.key in liveSelected }
}

data class ParsedSubscription(
    val name: String?,
    val sources: List<VodSource>,
    val liveSources: List<LiveSource>,
    val skipped: Int,
    val format: String,
)
