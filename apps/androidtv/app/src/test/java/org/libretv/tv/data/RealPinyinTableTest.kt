package org.libretv.tv.data

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 用**真实的** assets/pinyin-table.txt 验证首字母表可用。
 *
 * 其余 Pinyin 测试都用内存里的小表，表本身接错（码位偏移、BOM、截断）不会被发现——
 * 而「拼音搜不出任何东西」正是这类错误的唯一症状。这里直接读仓库里的真实表。
 */
class RealPinyinTableTest {

    private val candidates = listOf(
        java.io.File("src/main/assets/pinyin-table.txt"),
        java.io.File("app/src/main/assets/pinyin-table.txt"),
        java.io.File("apps/androidtv/app/src/main/assets/pinyin-table.txt"),
    )

    private val altCandidates = listOf(
        java.io.File("src/main/assets/pinyin-alts.txt"),
        java.io.File("app/src/main/assets/pinyin-alts.txt"),
        java.io.File("apps/androidtv/app/src/main/assets/pinyin-alts.txt"),
    )

    private fun find(candidates: List<File>, name: String): File =
        candidates.firstOrNull { it.isFile }
            ?: org.junit.Assert.fail(
                "找不到 $name，已尝试：" + candidates.joinToString("、") { it.absolutePath }
            ) as File

    @After
    fun tearDown() {
        // Pinyin 是进程级单例，别把真实表留给后面的测试类
        Pinyin.clearForTest()
    }

    @Test
    fun `真实拼音表能给出正确首字母`() {
        val file = find(candidates, "pinyin-table.txt")
        val raw = file.readText()
        // 表覆盖 0x4E00..0x9FFF，正好 20992 个字符；少一个都会让码位整体错位
        assertEquals(20992, raw.length)

        Pinyin.install(raw)
        assertTrue(Pinyin.ready)

        assertEquals("qmmk", Pinyin.initials("奇妙萌可"))
        // 副标题也参与：第/二/季 分别是 d/e/j，不要写成只取主标题
        assertEquals("qmmkdej", Pinyin.initials("奇妙萌可 第二季"))
        assertEquals("dldl", Pinyin.initials("斗罗大陆"))
        assertEquals("ldh", Pinyin.initials("刘德华"))
        assertEquals("lj", Pinyin.initials("亮剑"))
        assertTrue(Pinyin.matches("奇妙萌可 第二季", "qmmk"))
        assertTrue(Pinyin.matches("亮剑", "lj"))
        assertTrue(Pinyin.matches("狂飙", "kb"))
    }

    @Test
    fun `真实多音字备选表让重庆能被 cq 命中`() {
        Pinyin.install(find(candidates, "pinyin-table.txt").readText())
        val alts = find(altCandidates, "pinyin-alts.txt").readText()
        // 备选表每行 `字:字母`，至少得有一千多个多音字，否则生成脚本多半只跑了一半
        assertTrue("备选表太小：${alts.length} 字节", alts.length > 5_000)
        Pinyin.installAlts(alts)

        assertEquals("zq", Pinyin.initials("重庆"))
        assertTrue(Pinyin.matches("重庆", "cq"))
        assertTrue(Pinyin.matches("重庆", "zq"))
        // 备选命中排在主读音之后
        assertEquals(40, Pinyin.score("重庆", "cq"))
        // 音乐：乐 主读音 l，备选 y，yy 只能靠备选命中
        assertTrue(Pinyin.matches("音乐", "yy"))
        assertEquals(40, Pinyin.score("音乐", "yy"))
    }
}
