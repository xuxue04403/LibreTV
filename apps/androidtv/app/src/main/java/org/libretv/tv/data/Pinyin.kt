package org.libretv.tv.data

/**
 * 汉字 → 拼音首字母（TV 端）。
 *
 * 对应桌面端 `packages/core/src/pinyin.ts`，两边共用同一份表：
 * `tools/gen-pinyin-table.mjs` 生成 `assets/pinyin-table.txt`，
 * 由 [install] 在启动时读入。表为空时所有查询退化成「不命中」，
 * 也就是拼音检索不可用，但不影响普通搜索。
 */
object Pinyin {
    /** 表覆盖的起始码位，与生成脚本保持一致 */
    private const val TABLE_START = 0x4E00

    @Volatile
    private var table: String = ""

    /** 启动时调用；重复调用安全 */
    fun install(raw: String) {
        if (raw.isNotEmpty()) table = raw
    }

    val ready: Boolean get() = table.isNotEmpty()

    /** 仅供单元测试：清零表，验证「拼音不可用时优雅退化」 */
    @androidx.annotation.VisibleForTesting
    fun clearForTest() {
        table = ""
    }

    private fun initialOf(ch: Char): String {
        val index = ch.code - TABLE_START
        if (index < 0 || index >= table.length) return ""
        val letter = table[index]
        return if (letter == '?') "" else letter.toString()
    }

    /** `奇妙萌可` → `qmmk`；规则与桌面端一致：汉字取首字母，字母数字保留并小写，其余丢弃 */
    fun initials(text: String): String {
        if (table.isEmpty()) return ""
        val out = StringBuilder(text.length)
        for (ch in text) {
            when {
                ch.isDigit() -> out.append(ch)
                ch in 'a'..'z' || ch in 'A'..'Z' -> out.append(ch.lowercaseChar())
                else -> out.append(initialOf(ch))
            }
        }
        return out.toString()
    }

    /** 是否像拼音首字母查询：纯字母、至少两位（一位太容易误伤正常英文搜索） */
    fun isQuery(query: String): Boolean {
        val q = query.trim()
        return q.length >= 2 && q.all { it in 'a'..'z' || it in 'A'..'Z' }
    }

    /**
     * 片名是否匹配拼音首字母查询。
     *
     * 只认「连续命中」：`qmmk` 命中 `奇妙萌可`，也命中 `超能qmmk小队`。
     * 不做跳字母匹配，否则 `qmx` 也会在 `qmmkzsyxl` 里被判命中，噪声太大。
     */
    fun matches(name: String, query: String): Boolean {
        val needle = query.trim().lowercase()
        if (needle.isEmpty() || table.isEmpty()) return false
        val initials = initials(name)
        return initials.isNotEmpty() && initials.contains(needle)
    }
}
