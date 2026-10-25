package org.libretv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun item(name: String, vodId: String = "1", sourceKey: String = "a") = SearchItem(
    sourceKey = sourceKey,
    sourceName = sourceKey,
    vodId = vodId,
    name = name,
    pic = "https://img/$vodId.jpg",
    typeName = "电影",
    year = "2026",
)

class CatalogSnapshotTest {
    private val sources = listOf(
        VodSource("a", "A", "https://a.example.com/api.php/provide/vod"),
        VodSource("b", "B", "https://b.example.com/api.php/provide/vod"),
    )

    @Test
    fun `写入后能读回同样的条目`() {
        val snap = CatalogSnapshot(signature = "sig")
            .withEntry(CategoryKey.MOVIE, listOf(item("沙丘", "1"), item("沙丘2", "2")))
        val back = snap.itemsOf(CategoryKey.MOVIE)
        assertNotNull(back)
        assertEquals(listOf("沙丘", "沙丘2"), back!!.map { it.name })
        assertEquals("https://img/1.jpg", back.first().pic)
    }

    @Test
    fun `没有写过的分类返回 null 而不是空列表`() {
        val snap = CatalogSnapshot(signature = "sig")
        // 空列表会被界面当成「这个分类没内容」，必须用 null 区分「没缓存过」
        assertNull(snap.itemsOf(CategoryKey.TV))
    }

    @Test
    fun `空列表不覆盖已有缓存`() {
        val snap = CatalogSnapshot(signature = "sig")
            .withEntry(CategoryKey.MOVIE, listOf(item("沙丘", "1")))
        val again = snap.withEntry(CategoryKey.MOVIE, emptyList())
        // 刷新失败时若用空列表覆盖，用户切回来就变成空白页
        assertEquals(1, again.itemsOf(CategoryKey.MOVIE)?.size)
    }

    @Test
    fun `单分类条目数被截断到上限`() {
        val many = (1..400).map { item("片$it", "$it") }
        val snap = CatalogSnapshot(signature = "sig").withEntry(CategoryKey.MOVIE, many)
        assertEquals(CatalogSnapshot.MAX_ITEMS_PER_CATEGORY, snap.itemsOf(CategoryKey.MOVIE)?.size)
    }

    @Test
    fun `超过刷新周期就判为待刷新（而不是等满 TTL）`() {
        val now = 1_000_000L
        val snap = CatalogSnapshot(signature = "sig")
            .withEntry(CategoryKey.MOVIE, listOf(item("沙丘", "1")), now = now)
        assertTrue(snap.isFresh(CategoryKey.MOVIE, now + 1000))
        // 判据是「距上次刷新是否满 1 小时」，不是 6 小时 TTL：
        // 拿 TTL 去判会让每小时的定时刷新 5 次空转，实际变成 6 小时一次
        assertFalse(snap.isFresh(CategoryKey.MOVIE, now + CatalogSnapshot.REFRESH_INTERVAL_MS + 1))
        // 不新鲜只意味着「该刷新了」，内容要留着先用
        assertNotNull(snap.itemsOf(CategoryKey.MOVIE))
    }

    @Test
    fun `markChecked 只记时间，不清掉已有内容`() {
        val now = 1_000_000L
        val snap = CatalogSnapshot(signature = "sig")
            .withEntry(CategoryKey.MOVIE, listOf(item("沙丘", "1")), now = now)
        val later = now + CatalogSnapshot.REFRESH_INTERVAL_MS + 1
        val checked = snap.markChecked(CategoryKey.MOVIE, now = later)
        // 内容还在，但已经算「刚查过」
        assertEquals(1, checked.itemsOf(CategoryKey.MOVIE)?.size)
        assertTrue(checked.isFresh(CategoryKey.MOVIE, later + 1000))
    }

    @Test
    fun `markChecked 让空分类也进入新鲜状态`() {
        val now = 1_000_000L
        val snap = CatalogSnapshot(signature = "sig").markChecked(CategoryKey.KIDS, now = now)
        // 空分类若不记时间，后台每小时都重打一轮请求，用户看到的还是同一片空白
        assertTrue(snap.isFresh(CategoryKey.KIDS, now + 1000))
        assertNull(snap.itemsOf(CategoryKey.KIDS))
    }

    @Test
    fun `从未缓存的分类不新鲜`() {
        assertFalse(CatalogSnapshot(signature = "sig").isFresh(CategoryKey.ANIME))
    }

    @Test
    fun `签名随源地址集合与成人过滤变化`() {
        val base = CatalogSnapshot.signatureOf(sources, true)
        // 源顺序不影响签名：DataStore 里 on/off 顺序不该造成缓存作废
        assertEquals(base, CatalogSnapshot.signatureOf(sources.reversed(), true))
        assertTrue(base != CatalogSnapshot.signatureOf(sources, false))
        assertTrue(base != CatalogSnapshot.signatureOf(sources.take(1), true))
    }

    @Test
    fun `条目往返序列化不丢字段`() {
        val original = item("沙丘", "9").copy(remarks = "HD", area = "美国", sourceUrl = "https://a.example.com")
        val round = CachedItem.from(original).toItem()
        assertEquals(original, round)
    }
}

class SearchCacheSnapshotTest {
    @Test
    fun `命中同一个关键词`() {
        val snap = SearchCacheSnapshot().withEntry("沙丘", true, listOf(item("沙丘")))
        assertEquals(1, snap.itemsOf("沙丘", true)?.size)
    }

    @Test
    fun `关键词忽略大小写与首尾空格`() {
        val snap = SearchCacheSnapshot().withEntry("Dune", true, listOf(item("Dune")))
        assertNotNull(snap.itemsOf("  dune ", true))
    }

    @Test
    fun `成人过滤开关不同不共用缓存`() {
        val snap = SearchCacheSnapshot().withEntry("沙丘", true, listOf(item("沙丘")))
        // 关掉过滤时应该能搜到更多结果，直接复用过滤后的缓存会少内容
        assertNull(snap.itemsOf("沙丘", false))
    }

    @Test
    fun `超过 TTL 不再命中`() {
        val now = 5_000_000L
        val snap = SearchCacheSnapshot().withEntry("沙丘", true, listOf(item("沙丘")), now = now)
        assertNotNull(snap.itemsOf("沙丘", true, now + 1000))
        assertNull(snap.itemsOf("沙丘", true, now + SearchCacheSnapshot.TTL_MS + 1))
    }

    @Test
    fun `空结果不写缓存`() {
        val snap = SearchCacheSnapshot().withEntry("沙丘", true, emptyList())
        assertTrue(snap.entries.isEmpty())
    }

    @Test
    fun `关键词数量超过上限时丢最旧的`() {
        var snap = SearchCacheSnapshot()
        repeat(SearchCacheSnapshot.MAX_KEYWORDS + 5) { i ->
            snap = snap.withEntry("关键词$i", true, listOf(item("片$i")), now = 1_000L + i)
        }
        assertEquals(SearchCacheSnapshot.MAX_KEYWORDS, snap.entries.size)
        // 用写入时间附近的 now 查询：默认参数是真实时钟，早就过了 TTL 会一律返回 null
        val now = 1_000L + SearchCacheSnapshot.MAX_KEYWORDS + 4
        // 最新的一定还在，最旧的被裁掉
        assertNotNull(snap.itemsOf("关键词${SearchCacheSnapshot.MAX_KEYWORDS + 4}", true, now))
        assertNull(snap.itemsOf("关键词0", true, now))
    }

    @Test
    fun `单个关键词条目数被截断到上限`() {
        val many = (1..500).map { item("片$it", "$it") }
        val snap = SearchCacheSnapshot().withEntry("沙丘", true, many)
        assertEquals(SearchCacheSnapshot.MAX_ITEMS, snap.itemsOf("沙丘", true)?.size)
    }
}
