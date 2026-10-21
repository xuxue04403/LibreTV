package org.libretv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 候选链构建：失败转移的基础。
 *
 * 这些用例对应桌面端 packages/core/src/failover.test.ts，两端行为必须一致，
 * 否则同一个影片在电视和电脑上会切到不同的源。
 */
class PlaybackCandidateTest {

    private fun source(key: String, name: String = key, url: String = "http://$key.example.com/api.php/provide/vod") =
        VodSource(key = key, name = name, url = url)

    private fun item(
        sourceKey: String,
        vodId: String,
        name: String = "沙丘",
        sourceName: String = sourceKey,
        sourceUrl: String? = null,
    ) = SearchItem(
        sourceKey = sourceKey,
        sourceName = sourceName,
        vodId = vodId,
        name = name,
        sourceUrl = sourceUrl,
    )

    @Test
    fun `key combines source and vod id`() {
        val candidate = PlaybackCandidate(source("a"), "123")
        assertEquals("a:123", candidate.key)
    }

    @Test
    fun `build keeps source order and drops duplicates`() {
        val sources = listOf(source("a"), source("b"), source("c"))
        val items = listOf(
            item("a", "1"),
            item("b", "2"),
            item("a", "1"), // 重复
            item("c", "3"),
        )
        val chain = PlaybackCandidate.build(items, sources)
        assertEquals(listOf("a:1", "b:2", "c:3"), chain.map { it.key })
    }

    @Test
    fun `build moves active candidate to front`() {
        val sources = listOf(source("a"), source("b"), source("c"))
        val items = listOf(item("a", "1"), item("b", "2"), item("c", "3"))
        val chain = PlaybackCandidate.build(items, sources, active = "c" to "3")
        assertEquals("c:3", chain.first().key)
        // 其余顺序保持稳定
        assertEquals(listOf("c:3", "a:1", "b:2"), chain.map { it.key })
    }

    @Test
    fun `build honours limit`() {
        val sources = (1..12).map { source("s$it") }
        val items = (1..12).map { item("s$it", "$it") }
        assertEquals(PlaybackCandidate.MAX, PlaybackCandidate.build(items, sources).size)
        assertEquals(3, PlaybackCandidate.build(items, sources, limit = 3).size)
    }

    @Test
    fun `build skips items whose source disappeared but keeps fallback url`() {
        val sources = listOf(source("a"))
        val items = listOf(
            item("a", "1"),
            item("gone", "9", sourceUrl = "http://gone.example.com/api.php/provide/vod"),
            item("broken", "8", sourceUrl = null),
        )
        val chain = PlaybackCandidate.build(items, sources)
        // gone 有原始地址可以兜底；broken 连地址都没有，只能跳过
        assertEquals(listOf("a:1", "gone:9"), chain.map { it.key })
        assertEquals("http://gone.example.com/api.php/provide/vod", chain[1].source.url)
    }

    @Test
    fun `build ignores non http fallback url`() {
        val chain = PlaybackCandidate.build(
            listOf(item("gone", "9", sourceUrl = "csp_Gone")),
            emptyList(),
        )
        assertTrue(chain.isEmpty())
    }

    @Test
    fun `build with empty items yields empty chain`() {
        assertTrue(PlaybackCandidate.build(emptyList(), listOf(source("a"))).isEmpty())
    }

    @Test
    fun `of falls back to item source name when source name is empty`() {
        val sources = listOf(source("a", name = ""))
        val candidate = PlaybackCandidate.of(item("a", "1", sourceName = "聚合站A"), sources)
        assertEquals("聚合站A", candidate?.sourceName)
    }

    @Test
    fun `of returns null when source is unknown and url missing`() {
        assertNull(PlaybackCandidate.of(item("ghost", "1"), emptyList()))
    }

    @Test
    fun `of prefers registered source over item fallback`() {
        val sources = listOf(source("a", name = "正式名", url = "http://a.example.com/api"))
        val candidate = PlaybackCandidate.of(
            item("a", "1", sourceName = "旧名", sourceUrl = "http://old.example.com/api"),
            sources,
        )
        assertSame(sources[0], candidate?.source)
    }
}

/**
 * 集数对齐：换源后不能沿用旧源的集数下标。
 *
 * 同样的片子在两个采集站的线路数往往不同（一个 40 集、一个 24 集），
 * 直接沿用下标会越界或跳集。
 */
class EpisodeAlignTest {

    private fun align(preferred: Int, length: Int): Int =
        preferred.coerceIn(0, (length - 1).coerceAtLeast(0))

    @Test
    fun `keeps index when in range`() {
        assertEquals(5, align(5, 10))
    }

    @Test
    fun `clamps when new source has fewer episodes`() {
        assertEquals(23, align(30, 24))
    }

    @Test
    fun `clamps to zero when new source has single episode`() {
        assertEquals(0, align(7, 1))
    }

    @Test
    fun `handles empty episode list`() {
        assertEquals(0, align(3, 0))
    }
}
