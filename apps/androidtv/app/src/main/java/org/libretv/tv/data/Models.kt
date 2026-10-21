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
