package org.libretv.tv.data

import kotlinx.serialization.Serializable

/**
 * 分类目录的落盘缓存。
 *
 * 用户反馈「每次切换分类、每次检索都像在重新加载播放源」——原因是
 * [Repository] 的 `browseCache` 只在内存里，进程一退就没了，而且只有 5 分钟。
 * 这里把「每个分类的第一页」按「源集合签名」整体存进 DataStore：
 * 切分类先读它（零网络），后台再按小时刷新。
 *
 * 字段取短名：8 个分类各 200 条时，紧凑字段大约 100KB 量级。
 */
@Serializable
data class CachedItem(
    val n: String,
    val sk: String,
    val sn: String,
    val v: String,
    val p: String? = null,
    val t: String? = null,
    val y: String? = null,
    val a: String? = null,
    val r: String? = null,
    val u: String? = null,
    /** 源级成人标记：丢掉它会让「被过滤掉的源」在还原后重新出现 */
    val g: Boolean = false,
) {
    fun toItem() = SearchItem(
        sourceKey = sk,
        sourceName = sn,
        vodId = v,
        name = n,
        pic = p,
        typeName = t,
        year = y,
        area = a,
        remarks = r,
        sourceUrl = u,
        isAdult = g,
    )

    companion object {
        fun from(item: SearchItem) = CachedItem(
            n = item.name,
            sk = item.sourceKey,
            sn = item.sourceName,
            v = item.vodId,
            p = item.pic,
            t = item.typeName,
            y = item.year,
            a = item.area,
            r = item.remarks,
            u = item.sourceUrl,
            g = item.isAdult,
        )
    }
}

/** 一个分类的缓存：写入时刻 + 条目 */
@Serializable
data class CatalogEntry(
    val at: Long,
    val items: List<CachedItem>,
)

/**
 * 整份目录快照。
 *
 * `signature` 把「启用了哪些源 + 成人过滤开关」编进去：源一改，旧缓存
 * 里的条目可能来自已被停用的站，直接丢弃比混着用更安全。
 */
@Serializable
data class CatalogSnapshot(
    val signature: String,
    val entries: Map<String, CatalogEntry> = emptyMap(),
) {
    companion object {
        /** 单分类最多缓存这么多条：首页 row 只用前 15 条，分类页首屏也就一两屏 */
        const val MAX_ITEMS_PER_CATEGORY = 240

        /** 缓存有效期：超过就认为「该刷新了」，但界面仍先用旧内容顶上 */
        const val TTL_MS = 6 * 60 * 60 * 1000L

        /** 后台刷新的周期（用户要求：每小时一次） */
        const val REFRESH_INTERVAL_MS = 60 * 60 * 1000L

        fun signatureOf(sources: List<VodSource>, adultFilter: Boolean): String =
            sources.map { it.url }.sorted().joinToString(",") +
                "|" + (if (adultFilter) 1 else 0)
    }

    fun itemsOf(key: CategoryKey): List<SearchItem>? =
        entries[key.name]?.items?.takeIf { it.isNotEmpty() }?.map { it.toItem() }

    /**
     * 是否「最近刷过一次」。
     *
     * 用 [REFRESH_INTERVAL_MS]（1 小时）而不是 [TTL_MS]（6 小时）判：后台刷新的
     * 目的就是「每小时更新一次缓存」，拿 6 小时的 TTL 去判会让每小时醒来 6 次、
     * 5 次直接空转，用户要求的「每小时自动拉取」实际变成 6 小时一次。
     */
    fun isFresh(key: CategoryKey, now: Long = System.currentTimeMillis()): Boolean {
        val entry = entries[key.name] ?: return false
        return now - entry.at < REFRESH_INTERVAL_MS
    }

    fun withEntry(key: CategoryKey, items: List<SearchItem>, now: Long = System.currentTimeMillis()): CatalogSnapshot {
        if (items.isEmpty()) return this
        val entry = CatalogEntry(
            at = now,
            items = items.take(MAX_ITEMS_PER_CATEGORY).map { CachedItem.from(it) },
        )
        return copy(entries = entries + (key.name to entry))
    }

    /**
     * 只记「刚查过」，不动已有内容。
     *
     * 一趟刷新拿回空结果有两种可能：分类本来就空，或者这次网络抽风。两种情况下
     * 都不该清空已显示的内容，但**都必须记下时间**——否则空分类永远不算新鲜，
     * 后台每小时都为它重打一轮请求（4 源 × 8 分类 = 32 个），用户看到的还是同一片空白。
     */
    fun markChecked(key: CategoryKey, now: Long = System.currentTimeMillis()): CatalogSnapshot {
        val existing = entries[key.name]
        val entry = CatalogEntry(at = now, items = existing?.items ?: emptyList())
        return copy(entries = entries + (key.name to entry))
    }
}
