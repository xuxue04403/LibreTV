package org.librextv.tv.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 分片预取缓存的边界行为。
 *
 * 这里要证明的两件事，任何一条错了都会让「预取」变成纯粹的负担：
 * 1) 缓存必须有硬上限——电视盒子内存小，无限增长会直接被系统杀掉；
 * 2) LRU 必须真的按「最近使用」淘汰——否则播放器顺序播放时会一直淘汰马上要用的分片。
 */
class SegmentLruTest {

    private fun body(size: Int, filler: Byte = 1): ByteArray = ByteArray(size) { filler }

    @Test
    fun `命中返回原始字节与类型`() {
        val lru = SegmentLru()
        lru.put("a", body(100, 7), "video/mp2t")
        val hit = lru.get("a")
        assertNotNull(hit)
        assertArrayEquals(body(100, 7), hit!!.first)
        assertEquals("video/mp2t", hit.second)
    }

    @Test
    fun `未命中返回 null`() {
        val lru = SegmentLru()
        assertNull(lru.get("nope"))
    }

    @Test
    fun `超过单条上限的分片不入缓存`() {
        val lru = SegmentLru(maxBytes = 1024, maxSegment = 100)
        lru.put("big", body(101), "video/mp2t")
        assertNull(lru.get("big"))
        assertEquals(0, lru.size)
        assertEquals(0L, lru.bytes)
    }

    @Test
    fun `超总上限时淘汰最久未用的`() {
        val lru = SegmentLru(maxBytes = 250, maxSegment = 200)
        lru.put("a", body(100), "video/mp2t")
        lru.put("b", body(100), "video/mp2t")
        // 访问 a 把它提到队尾，此时最久未用的是 b
        lru.get("a")
        lru.put("c", body(100), "video/mp2t")
        assertNotNull(lru.get("a"))
        assertNotNull(lru.get("c"))
        assertNull(lru.get("b"))
        assertEquals(200L, lru.bytes)
    }

    @Test
    fun `重复写入同一地址不会重复计字节`() {
        val lru = SegmentLru(maxBytes = 1024, maxSegment = 200)
        lru.put("a", body(100), "video/mp2t")
        lru.put("a", body(100), "video/mp2t")
        assertEquals(1, lru.size)
        assertEquals(100L, lru.bytes)
    }

    @Test
    fun `clear 清空并归零字节`() {
        val lru = SegmentLru()
        lru.put("a", body(100), "video/mp2t")
        lru.clear()
        assertEquals(0, lru.size)
        assertEquals(0L, lru.bytes)
        assertNull(lru.get("a"))
    }

    @Test
    fun `识别抓回来的内容是播放列表而不是分片`() {
        // master 里的「分片行」其实是子播放列表：预取不能把它当媒体字节塞进 LRU
        assertTrue(SegmentPrefetch.looksLikePlaylist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nc.m3u8".toByteArray()))
        // 带 BOM / 前导空白也要认出来
        assertTrue(SegmentPrefetch.looksLikePlaylist("\uFEFF  \n#EXTM3U\n".toByteArray()))
        // 真正的 TS 分片（0x47 同步字节打头）不是播放列表
        assertFalse(SegmentPrefetch.looksLikePlaylist(byteArrayOf(0x47, 0x40, 0x11, 0x10)))
        assertFalse(SegmentPrefetch.looksLikePlaylist(ByteArray(0)))
    }

    @Test
    fun `从播放列表取出分片绝对地址并跳过注释`() {
        val playlist = """
            #EXTM3U
            #EXT-X-TARGETDURATION:6
            #EXTINF:6,
            seg1.ts
            #EXTINF:6,
            20240101/seg2.ts
            #EXT-X-ENDLIST
        """.trimIndent()
        val urls = SegmentPrefetch.segmentUrls(playlist, "https://cdn.example.com/hls/index.m3u8")
        assertEquals(
            listOf("https://cdn.example.com/hls/seg1.ts", "https://cdn.example.com/hls/20240101/seg2.ts"),
            urls,
        )
    }
}
