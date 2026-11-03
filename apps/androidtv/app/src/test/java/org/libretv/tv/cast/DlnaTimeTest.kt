package org.libretv.tv.cast

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * DLNA 时长格式。原先 `GetPositionInfo` 把 `TrackDuration` / `RelTime` 硬编码成
 * `00:00:00`，手机端的进度条永远不动 —— 这两个函数的边界就是那时候漏掉的。
 */
class DlnaTimeTest {
    @Test
    fun 毫秒格式化成标准时长() {
        assertEquals("0:00:00", DlnaTime.format(0))
        assertEquals("0:01:05", DlnaTime.format(65_000))
        assertEquals("1:02:03", DlnaTime.format(3_723_000))
        assertEquals("10:00:00", DlnaTime.format(36_000_000))
    }

    @Test
    fun 负数与不足一秒都按零处理() {
        assertEquals("0:00:00", DlnaTime.format(-5_000))
        assertEquals("0:00:00", DlnaTime.format(999))
    }

    @Test
    fun 解析标准时长() {
        assertEquals(0L, DlnaTime.parse("00:00:00"))
        assertEquals(65_000L, DlnaTime.parse("00:01:05"))
        assertEquals(3_723_000L, DlnaTime.parse("01:02:03"))
    }

    @Test
    fun 解析带小数的时长() {
        assertEquals(90_500L, DlnaTime.parse("00:01:30.500"))
    }

    @Test
    fun 解析分秒与纯秒数() {
        assertEquals(65_000L, DlnaTime.parse("01:05"))
        assertEquals(42_000L, DlnaTime.parse("42"))
    }

    @Test
    fun 非法输入返回负一() {
        assertEquals(-1L, DlnaTime.parse(null))
        assertEquals(-1L, DlnaTime.parse(""))
        assertEquals(-1L, DlnaTime.parse("abc"))
        assertEquals(-1L, DlnaTime.parse("00:00:00:00"))
        assertEquals(-1L, DlnaTime.parse("-00:00:05"))
    }

    @Test
    fun 格式化与解析可以互逆() {
        val samples = listOf(0L, 1_000L, 59_000L, 60_000L, 3_599_000L, 3_600_000L, 86_399_000L)
        for (ms in samples) {
            // format 丢掉了毫秒以下的精度，这里只比较整秒
            assertEquals(ms / 1000 * 1000, DlnaTime.parse(DlnaTime.format(ms)))
        }
    }
}
