package org.libretv.tv.data

/**
 * 分片缓存的本体（纯逻辑，不碰网络与 Android API，便于单测）。
 *
 * LRU + 总字节上限。电视盒子内存紧张，缓存必须**有明确上限**：
 * 只按条数限制是不够的，一条 8MB 的分片乘几十条就能把进程撑死。
 */
internal class SegmentLru(
    private val maxBytes: Long = 64L * 1024 * 1024,
    private val maxSegment: Int = 8 * 1024 * 1024,
) {

    private class Entry(val body: ByteArray, val contentType: String)

    /**
     * LinkedHashMap + accessOrder = true 就是现成的 LRU：
     * get 命中会把条目挪到队尾，队首因此永远是最久未用的。
     */
    private val cache = object : LinkedHashMap<String, Entry>(64, 0.75f, true) {
        // 淘汰逻辑自己写在 put 里：要在丢之前精确扣减字节数
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?): Boolean = false
    }

    var bytes: Long = 0
        private set

    val size: Int
        get() = synchronized(cache) { cache.size }

    /** 命中会把条目提到队尾；未命中返回 null */
    fun get(url: String): Pair<ByteArray, String>? = synchronized(cache) {
        val hit = cache[url] ?: return null
        hit.body to hit.contentType
    }

    /** 单条超过 maxSegment 的直接不收：大文件整份驻留内存会让盒子被系统杀掉 */
    fun put(url: String, body: ByteArray, contentType: String) {
        if (body.size > maxSegment) return
        synchronized(cache) {
            val old = cache.put(url, Entry(body, contentType))
            if (old != null) bytes -= old.body.size
            bytes += body.size
            val iterator = cache.entries.iterator()
            while (bytes > maxBytes && iterator.hasNext()) {
                val entry = iterator.next()
                bytes -= entry.value.body.size
                iterator.remove()
            }
        }
    }

    fun clear() {
        synchronized(cache) {
            cache.clear()
            bytes = 0
        }
    }
}
