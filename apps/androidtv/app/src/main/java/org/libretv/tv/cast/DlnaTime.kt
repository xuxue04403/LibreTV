package org.libretv.tv.cast

/**
 * DLNA AVTransport 的时长格式转换。
 *
 * 协议里的 `TrackDuration` / `RelTime` 是 `H:MM:SS[.fff]`，`Seek` 的 `Target`
 * 也是同一格式（有的控制点会给 `HH:MM:SS`，也有给纯秒数的）。这两件事以前
 * 被硬编码成 `00:00:00`，于是手机端的进度条永远是 0、拖动也不生效。
 *
 * 单独放一个纯函数对象是为了能写 JVM 单测（DlnaServer 本身依赖 Android）。
 */
object DlnaTime {
    /** 毫秒 → `H:MM:SS`。负数按 0 处理。 */
    fun format(ms: Long): String {
        val total = (ms / 1000).coerceAtLeast(0)
        val h = total / 3600
        val m = (total % 3600) / 60
        val s = total % 60
        return "$h:${pad(m)}:${pad(s)}"
    }

    /**
     * `H:MM:SS` / `MM:SS` / 纯秒数 → 毫秒。无法解析时返回 -1，调用方据此忽略该次 Seek。
     *
     * 不做「超出影片长度」的夹紧：那需要播放器状态，交给 CastRuntime.seek 之后
     * 由 ExoPlayer 自己 clamp。
     */
    fun parse(text: String?): Long {
        val raw = text?.trim().orEmpty()
        if (raw.isEmpty()) return -1
        val parts = raw.split(':')
        if (parts.size > 3) return -1
        var ms = 0L
        for (part in parts) {
            // 严格只认数字（允许小数秒）。之前用 toDoubleOrNull 判定负数，
            // 而 "-00".toDouble() 是 -0.0、既不小于 0 也过了解析，
            // 于是 "-00:00:05" 被算成 5 秒。
            if (!PART_RE.matches(part)) return -1
            val v = part.toDoubleOrNull() ?: return -1
            ms = ms * 60 + (v * 1000).toLong()
        }
        return ms
    }

    private val PART_RE = Regex("""\d+(\.\d+)?""")

    private fun pad(v: Long): String = if (v < 10) "0$v" else v.toString()
}
