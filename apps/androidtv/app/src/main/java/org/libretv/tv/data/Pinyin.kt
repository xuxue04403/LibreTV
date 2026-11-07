package org.libretv.tv.data

/**
 * 汉字 → 拼音首字母（TV 端）。
 *
 * 对应桌面端 `packages/core/src/pinyin.ts`，两边共用同一份主表：
 * `tools/gen-pinyin-table.mjs` 生成 `assets/pinyin-table.txt`，
 * 由 [install] 在启动时读入。表为空时所有查询退化成「不命中」，
 * 也就是拼音检索不可用，但不影响普通搜索。
 *
 * 多音字另有一张 `assets/pinyin-alts.txt`（`字:备选首字母`），
 * 由 [installAlts] 读入：`重` 主表是 z（zhòng），但「重庆」读 chóng，
 * 只认主表时用户输 `cq` 永远搜不到；有了备选表，`cq` 才能命中。
 */
object Pinyin {
    /** 表覆盖的起始码位，与生成脚本保持一致 */
    private const val TABLE_START = 0x4E00

    @Volatile
    private var table: String = ""

    /** 多音字的备选首字母，值为不含主字母的小写字符串 */
    @Volatile
    private var alts: Map<Char, String> = emptyMap()

    /**
     * 片名首字母缓存。
     *
     * 拼音检索会拿同一个片名反复匹配（每页结果、每次按键、每个窗口回调），
     * 索引里又有几千条，逐字查表其实不贵，但没有缓存时每次都要重建 StringBuilder。
     * 用访问序 LRU，上限 4096 条，足够覆盖常用索引。
     */
    private val initialsCache = object : LinkedHashMap<String, String>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean =
            size > 4096
    }

    /** 启动时调用；重复调用安全 */
    fun install(raw: String) {
        if (raw.isNotEmpty()) {
            table = raw
            synchronized(initialsCache) { initialsCache.clear() }
        }
    }

    /** 启动时调用；文件缺失或为空时保持「无备选」，主表照常工作 */
    fun installAlts(raw: String) {
        if (raw.isEmpty()) return
        val parsed = HashMap<Char, String>(2048)
        for (line in raw.lineSequence()) {
            val trimmed = line.trim()
            if (trimmed.isEmpty()) continue
            val colon = trimmed.indexOf(':')
            if (colon != 1 || colon == trimmed.length - 1) continue
            val ch = trimmed[0]
            val suffix = trimmed.substring(colon + 1)
            if (suffix.all { it in 'a'..'z' }) parsed[ch] = suffix
        }
        if (parsed.isNotEmpty()) alts = parsed
    }

    val ready: Boolean get() = table.isNotEmpty()

    /** 仅供单元测试：清零表，验证「拼音不可用时优雅退化」 */
    @androidx.annotation.VisibleForTesting
    fun clearForTest() {
        table = ""
        alts = emptyMap()
        synchronized(initialsCache) { initialsCache.clear() }
    }

    private fun primaryOf(ch: Char): Char? {
        val index = ch.code - TABLE_START
        if (index < 0 || index >= table.length) return null
        val letter = table[index]
        return if (letter == '?') null else letter
    }

    /**
     * 一个字符可能贡献的所有首字母：汉字是「主字母 + 多音字备选」，
     * 字母/数字原样保留（小写），其余返回空串。
     */
    private fun lettersOf(ch: Char): String {
        if (ch in '0'..'9') return ch.toString()
        if (ch in 'a'..'z' || ch in 'A'..'Z') return ch.lowercaseChar().toString()
        val primary = primaryOf(ch) ?: return ""
        val extra = alts[ch] ?: return primary.toString()
        return if (extra.isEmpty()) primary.toString() else primary + extra
    }

    /** `奇妙萌可` → `qmmk`；规则与桌面端一致：汉字取主读音首字母，字母数字保留并小写，其余丢弃 */
    fun initials(text: String): String {
        if (table.isEmpty()) return ""
        synchronized(initialsCache) { initialsCache[text]?.let { return it } }
        val out = StringBuilder(text.length)
        for (ch in text) {
            when {
                ch.isDigit() -> out.append(ch)
                ch in 'a'..'z' || ch in 'A'..'Z' -> out.append(ch.lowercaseChar())
                else -> primaryOf(ch)?.let { out.append(it) }
            }
        }
        val result = out.toString()
        synchronized(initialsCache) { initialsCache[text] = result }
        return result
    }

    /** 是否像拼音首字母查询：字母/数字、至少两位、且至少有一个字母（纯数字交给普通搜索） */
    fun isQuery(query: String): Boolean {
        val q = query.trim()
        if (q.length < 2) return false
        var hasLetter = false
        for (ch in q) {
            when {
                ch in 'a'..'z' || ch in 'A'..'Z' -> hasLetter = true
                ch.isDigit() -> Unit
                else -> return false
            }
        }
        return hasLetter
    }

    /**
     * 片名是否匹配拼音首字母查询。
     *
     * 用非确定性自动机做「连续命中」：每个汉字可以贡献多个首字母（多音字），
     * 只要存在一种读法让 query 连续出现在首字母串里就算命中。
     *
     * 仍然不做跳字母匹配：`qmx` 在 `qmmkzsyxl` 里不相邻，不放行。
     * 标点/空白/未知字符直接跳过，不打断连续性（与 [initials] 丢字符的语义一致）。
     */
    fun matches(name: String, query: String): Boolean {
        val needle = normalize(query)
        if (needle.isEmpty() || table.isEmpty()) return false
        val m = needle.length
        // cur[j] 表示「已经连续匹配到 needle 的前 j 个字符」；cur[0] 恒为 true（可从任意位置起头）
        var cur = BooleanArray(m + 1)
        cur[0] = true
        for (ch in name) {
            val letters = lettersOf(ch)
            if (letters.isEmpty()) continue
            val next = BooleanArray(m + 1)
            next[0] = true
            for (j in 0 until m) {
                if (!cur[j]) continue
                if (letters.indexOf(needle[j]) >= 0) {
                    if (j + 1 == m) return true
                    next[j + 1] = true
                }
            }
            cur = next
        }
        return cur[m]
    }

    /**
     * 相关性分：精确 > 前缀 > 包含 > 只有多音字备选命中。
     *
     * 用于把「亮剑」排在「亮剑之xxx」前面，把「重庆」这类必须靠备选读音的排在最后。
     */
    fun score(name: String, query: String): Int {
        if (!matches(name, query)) return 0
        val needle = normalize(query)
        val canonical = initials(name)
        return when {
            canonical == needle -> 100
            canonical.startsWith(needle) -> 80
            canonical.contains(needle) -> 50
            else -> 40
        }
    }

    /** 全角字母/数字折成半角并小写，避免 IME 输入全角时搜不到 */
    private fun normalize(query: String): String {
        val out = StringBuilder(query.length)
        for (ch in query.trim()) {
            val code = ch.code
            when {
                code in 0xFF21..0xFF3A -> out.append((code - 0xFF21 + 'a'.code).toChar())
                code in 0xFF41..0xFF5A -> out.append((code - 0xFF41 + 'a'.code).toChar())
                code in 0xFF10..0xFF19 -> out.append((code - 0xFF10 + '0'.code).toChar())
                else -> out.append(ch.lowercaseChar())
            }
        }
        return out.toString()
    }
}
