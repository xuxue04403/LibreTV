package org.librextv.tv.data

import kotlinx.serialization.Serializable

/**
 * 检索结果的落盘缓存。
 *
 * 电视端输一次关键词要按十几个键，用户经常搜同一个片名两三次（没找到、
 * 隔天再搜、给家里人再搜一遍）。每次都打 4 个源 × 最多 3 页，体感很慢。
 * 这里把「关键词 → 条目」按 1 小时落盘，命中就直接出结果、不碰网络。
 */
@Serializable
data class SearchCacheEntry(val at: Long, val items: List<CachedItem>)

@Serializable
data class SearchCacheSnapshot(val entries: Map<String, SearchCacheEntry> = emptyMap()) {
    companion object {
        const val TTL_MS = 60 * 60 * 1000L

        /** 只留最近这么多个关键词，避免无限增长 */
        const val MAX_KEYWORDS = 20

        /** 单个关键词最多缓存这么多条 */
        const val MAX_ITEMS = 300

        fun keyOf(word: String, adultFilter: Boolean): String =
            word.trim().lowercase() + "|" + (if (adultFilter) 1 else 0)
    }

    /** 命中且未过期则返回条目，过期返回 null（由调用方决定是否顺手清掉） */
    fun itemsOf(word: String, adultFilter: Boolean, now: Long = System.currentTimeMillis()): List<SearchItem>? {
        val entry = entries[keyOf(word, adultFilter)] ?: return null
        if (now - entry.at > TTL_MS) return null
        if (entry.items.isEmpty()) return null
        return entry.items.map { it.toItem() }
    }

    /**
     * 写入一条并裁掉最旧的。
     *
     * 超长时按时间戳升序丢最老的，保证「刚搜的」一定还在。
     */
    fun withEntry(
        word: String,
        adultFilter: Boolean,
        items: List<SearchItem>,
        now: Long = System.currentTimeMillis(),
    ): SearchCacheSnapshot {
        if (items.isEmpty()) return this
        val entry = SearchCacheEntry(at = now, items = items.take(MAX_ITEMS).map { CachedItem.from(it) })
        val merged = entries + (keyOf(word, adultFilter) to entry)
        if (merged.size <= MAX_KEYWORDS) return copy(entries = merged)
        val kept = merged.entries
            .sortedByDescending { it.value.at }
            .take(MAX_KEYWORDS)
            .associate { it.key to it.value }
        return copy(entries = kept)
    }
}
