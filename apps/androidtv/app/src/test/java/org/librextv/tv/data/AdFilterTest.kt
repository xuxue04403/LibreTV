package org.librextv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdFilterTest {
    private fun playlist(vararg groups: Pair<Int, Double>): String {
        val sb = StringBuilder("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n")
        groups.forEachIndexed { gi, (count, seconds) ->
            if (gi > 0) sb.append("#EXT-X-DISCONTINUITY\n")
            val each = seconds / count
            repeat(count) { i ->
                sb.append("#EXTINF:$each,\n")
                sb.append("https://vip.example.com/20241031/seg_${gi}_$i.ts\n")
            }
        }
        return sb.toString()
    }

    private fun segments(text: String): Int = text.lines().count { it.isNotBlank() && !it.startsWith("#") }

    @Test
    fun `夹在两段长正片之间的短分组会被摘掉`() {
        // 实测自「三体」：89 片/356s → 5 片/19.6s（广告）→ 330 片/1321s → 4 片/17.4s（广告）→ 132 片/529s
        val source = playlist(89 to 356.4, 5 to 19.6, 330 to 1321.2, 4 to 17.4, 132 to 529.7)
        val filtered = AdFilter.strip(source)
        assertEquals(89 + 330 + 132, segments(filtered))
        assertTrue(filtered.length < source.length)
    }

    @Test
    fun `整条流被切成二十秒小段时不会误删正片`() {
        // 实测自「三体第一季」：161 组、每组 5 片约 20 秒。相邻段都不足 120 秒，
        // 如果只看「短分组」就判定广告，会把整部片删光。
        val groups = Array(8) { 5 to 20.0 }
        val source = playlist(*groups)
        assertEquals(source, AdFilter.strip(source))
    }

    @Test
    fun `单组播放列表原样返回`() {
        val source = playlist(40 to 158.8)
        assertEquals(source, AdFilter.strip(source))
    }

    @Test
    fun `URL 带广告特征的分组整组摘掉`() {
        val source = buildString {
            append("#EXTM3U\n")
            repeat(3) {
                append("#EXTINF:10,\nhttps://cdn.example.com/real_$it.ts\n")
            }
            append("#EXT-X-DISCONTINUITY\n")
            append("#EXTINF:10,\nhttps://cdn.example.com/adjump/a.ts\n")
            append("#EXTINF:10,\nhttps://cdn.example.com/adjump/b.ts\n")
            append("#EXT-X-DISCONTINUITY\n")
            repeat(3) {
                append("#EXTINF:10,\nhttps://cdn.example.com/tail_$it.ts\n")
            }
        }
        assertEquals(6, segments(AdFilter.strip(source)))
    }

    @Test
    fun `片头广告与首位不连续标记都会被清掉`() {
        val source = buildString {
            append("#EXTM3U\n#EXT-X-DISCONTINUITY\n")
            append("#EXTINF:10,\nhttps://cdn.example.com/ad1.ts\n")
            append("#EXTINF:10,\nhttps://cdn.example.com/ad2.ts\n")
            append("#EXT-X-DISCONTINUITY\n")
            repeat(40) { append("#EXTINF:10,\nhttps://cdn.example.com/main_$it.ts\n") }
        }
        val filtered = AdFilter.strip(source)
        assertEquals(40, segments(filtered))
        assertFalse(filtered.lines().first().startsWith("#EXT-X-DISCONTINUITY"))
        assertFalse(filtered.contains("ad1.ts"))
    }

    @Test
    fun `非 m3u8 内容原样返回`() {
        assertEquals("{\"code\":1}", AdFilter.strip("{\"code\":1}"))
        assertEquals("", AdFilter.strip(""))
    }
}
