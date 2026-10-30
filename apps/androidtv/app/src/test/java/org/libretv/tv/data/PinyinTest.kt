package org.libretv.tv.data

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PinyinTest {
    /** 用一张极小的假表跑逻辑：真实表 20992 个码位，测试只需要几个字 */
    private fun table(vararg pairs: Pair<Char, Char>): String {
        val size = 0x9fff - 0x4e00 + 1
        val chars = CharArray(size) { '?' }
        for ((ch, letter) in pairs) chars[ch.code - 0x4e00] = letter
        return String(chars)
    }

    private val fake: String = table(
        '奇' to 'q',
        '妙' to 'm',
        '萌' to 'm',
        '可' to 'k',
        '之' to 'z',
        '闪' to 's',
        '耀' to 'y',
        '流' to 'l',
        '星' to 'x',
        '沙' to 's',
        '丘' to 'q',
    )

    @Before
    fun setUp() {
        Pinyin.install(fake)
    }

    /**
     * `Pinyin` 是进程级单例，测试里 clear 过就必须还原：
     * 否则同一个 JVM 里后跑的测试类（Repository / 搜索）会静默丢掉拼音能力。
     */
    @After
    fun tearDown() {
        Pinyin.install(fake)
    }

    @Test
    fun `片名转拼音首字母`() {
        assertEquals("qmmk", Pinyin.initials("奇妙萌可"))
        assertEquals("qmmkzsylx", Pinyin.initials("奇妙萌可之闪耀流星"))
    }

    @Test
    fun `标点空白数字英文都按规则处理`() {
        assertEquals("sq", Pinyin.initials(" 沙丘 "))
        // 表里没有「第/二/季」，它们退化成空串，只剩主标题的首字母
        assertEquals("qmmk", Pinyin.initials("奇妙萌可 第二季"))
        assertEquals("qmmk2", Pinyin.initials("奇妙萌可2"))
        assertEquals("cctv1", Pinyin.initials("CCTV-1"))
    }

    @Test
    fun `只有纯字母两位以上才算拼音查询`() {
        assertTrue(Pinyin.isQuery("qmmk"))
        assertTrue(Pinyin.isQuery("QMMK"))
        assertFalse(Pinyin.isQuery("q"))
        assertFalse(Pinyin.isQuery("沙丘"))
        assertFalse(Pinyin.isQuery("cctv1"))
    }

    @Test
    fun `连续命中才算匹配`() {
        assertTrue(Pinyin.matches("奇妙萌可", "qmmk"))
        assertTrue(Pinyin.matches("奇妙萌可之闪耀流星", "qmmk"))
        assertTrue(Pinyin.matches("奇妙萌可之闪耀流星", "mmk"))
        // 跳字母不算：qmx 在 qmmkzsyxl 里出现过但不相邻
        assertFalse(Pinyin.matches("奇妙萌可之闪耀流星", "qmx"))
        assertFalse(Pinyin.matches("沙丘", "qmmk"))
    }

    @Test
    fun `表未安装时不命中也不崩`() {
        Pinyin.clearForTest()
        assertFalse(Pinyin.ready)
        assertEquals("", Pinyin.initials("奇妙萌可"))
        assertFalse(Pinyin.matches("奇妙萌可", "qmmk"))
    }
}
