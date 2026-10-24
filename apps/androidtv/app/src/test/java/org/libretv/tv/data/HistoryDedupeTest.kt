package org.libretv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 观看记录去重（与桌面端 `packages/core/src/storage.test.ts` 的同名用例对齐）。
 */
class HistoryDedupeTest {

    private fun entry(
        id: String,
        title: String,
        sourceKey: String = id.substringBefore(':'),
        updatedAt: Long = 0L,
        year: String? = null,
    ) = HistoryEntry(
        id = id,
        sourceKey = sourceKey,
        vodId = id.substringAfter(':'),
        title = title,
        year = year,
        sourceName = "$sourceKey 源",
        episodeIndex = 0,
        episodeCount = 1,
        updatedAt = updatedAt,
    )

    @Test
    fun `同一部片子跨源只保留新的一条`() {
        val old = listOf(entry("a:1", "流浪地球", updatedAt = 1))
        val merged = HistoryDedupe.upsert(old, entry("b:2", "流浪地球", updatedAt = 2))
        assertEquals(1, merged.size)
        assertEquals("b:2", merged[0].id)
    }

    @Test
    fun `片名的空格与标点不影响判重`() {
        val old = listOf(entry("a:1", "The Dark Knight  2008"))
        val merged = HistoryDedupe.upsert(old, entry("b:2", "thedarkknight2008"))
        assertEquals(1, merged.size)
        assertEquals("b:2", merged[0].id)
    }

    @Test
    fun `不同片子各自保留`() {
        val old = listOf(entry("a:1", "流浪地球"))
        val merged = HistoryDedupe.upsert(old, entry("b:2", "沙丘"))
        assertEquals(2, merged.size)
        assertEquals("b:2", merged[0].id)
    }

    @Test
    fun `去重保留首条且幂等`() {
        val list = listOf(
            entry("a:1", "流浪地球"),
            entry("b:2", "沙丘"),
            entry("c:3", "流浪地球"),
        )
        val deduped = HistoryDedupe.dedupe(list)
        assertEquals(listOf("a:1", "b:2"), deduped.map { it.id })
        assertEquals(deduped, HistoryDedupe.dedupe(deduped))
    }

    @Test
    fun `超过上限时截断`() {
        val old = (1..150).map { entry("a:$it", "片子 $it") }
        val merged = HistoryDedupe.upsert(old, entry("b:9", "新片"), limit = 100)
        assertEquals(100, merged.size)
        assertEquals("b:9", merged[0].id)
    }

    @Test
    fun `sameWork 忽略大小写与标点`() {
        assertTrue(HistoryDedupe.sameWork(entry("a:1", "流浪地球"), "流浪地球 ", null))
        assertTrue(HistoryDedupe.sameWork(entry("a:1", "Spider-Man"), "spiderman", null))
        assertFalse(HistoryDedupe.sameWork(entry("a:1", "流浪地球"), "流浪地球 2", null))
    }

    @Test
    fun `同名不同年的翻拍片不会被合并`() {
        val old = listOf(entry("a:1", "西游记", year = "1986"))
        val merged = HistoryDedupe.upsert(old, entry("b:2", "西游记", year = "2010"))
        assertEquals(2, merged.size)
        // 同一年、不同源，仍然是同一部片子
        val again = HistoryDedupe.upsert(merged, entry("c:3", "西游记", year = "2010"))
        assertEquals(2, again.size)
        assertEquals("c:3", again[0].id)
    }

    @Test
    fun `旧记录没有年份时按片名合并`() {
        val old = listOf(entry("a:1", "大夏守夜人"))
        val merged = HistoryDedupe.upsert(old, entry("b:2", "大夏守夜人", year = "2026"))
        assertEquals(1, merged.size)
        assertEquals("2026", merged[0].year)
    }
}
