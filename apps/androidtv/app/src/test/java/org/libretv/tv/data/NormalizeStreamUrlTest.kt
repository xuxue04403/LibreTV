package org.libretv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 流地址归一化的边界用例（审计发现 baseUrl 含空格/中文时整源解析失败） */
class NormalizeStreamUrlTest {

    @Test
    fun `绝对地址原样保留`() {
        assertEquals("https://a.com/live.m3u8", Parsers.normalizeStreamUrl("https://a.com/live.m3u8"))
        assertEquals("http://a.com/x.ts", Parsers.normalizeStreamUrl("  http://a.com/x.ts  "))
    }

    @Test
    fun `相对地址按 baseUrl 解析`() {
        assertEquals(
            "https://a.com/hls/seg.ts",
            Parsers.normalizeStreamUrl("seg.ts", "https://a.com/hls/index.m3u8"),
        )
        assertEquals(
            "https://a.com/other/x.ts",
            Parsers.normalizeStreamUrl("/other/x.ts", "https://a.com/hls/index.m3u8"),
        )
    }

    @Test
    fun `baseUrl 含空格或中文时仍能解析相对地址`() {
        // 严格 URI 解析会抛异常；修复前这里返回 null，整个源被判为无可用频道
        val withSpace = Parsers.normalizeStreamUrl("seg.ts", "https://a.com/my dir/index.m3u8")
        assertEquals("https://a.com/my%20dir/seg.ts", withSpace)

        val withChinese = Parsers.normalizeStreamUrl("seg.ts", "https://a.com/直播/index.m3u8")
        assertEquals("https://a.com/直播/seg.ts", withChinese)
    }

    @Test
    fun `非 http 协议被拒绝`() {
        assertNull(Parsers.normalizeStreamUrl("rtmp://a.com/live"))
        assertNull(Parsers.normalizeStreamUrl("file:///etc/passwd"))
        assertNull(Parsers.normalizeStreamUrl(""))
    }

    @Test
    fun `baseUrl 为空且地址为相对路径时返回 null`() {
        assertNull(Parsers.normalizeStreamUrl("seg.ts", null))
        assertNull(Parsers.normalizeStreamUrl("seg.ts", ""))
    }
}
