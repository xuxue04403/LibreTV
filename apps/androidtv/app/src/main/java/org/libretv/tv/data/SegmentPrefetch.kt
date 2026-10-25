package org.libretv.tv.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.util.concurrent.ConcurrentHashMap

/**
 * 分片预取（TV 端）。
 *
 * 点播起播要串两跳：先拿 m3u8，再等首个分片。网络抖动时第二跳能卡好几秒，
 * 用户看到的就是一小段黑屏。这里在**点击播放的瞬间**就开始抓接下来的分片，
 * ExoPlayer 真正来要时直接从内存拿到。
 *
 * 与桌面端 `proxy.ts` 的 `SegmentCache` 同一套思路：LRU + 总字节上限，
 * 只缓存小分片（大文件整份驻留内存会把电视盒子逼到 OOM）。
 */
object SegmentPrefetch {

    /** 默认预取几个分片（6 秒一片约 45 秒内容） */
    const val DEFAULT_COUNT = 8

    private val lru = SegmentLru()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 并发闸门：别为了预取把带宽全抢走，播放器自己也要拉流 */
    private val permits = Semaphore(3)

    /** 正在预取的地址，避免同一分片被重复抓两遍 */
    private val inflight = ConcurrentHashMap.newKeySet<String>()

    /** 取一个已预取的分片；命中会被 LRU 提到队尾（返回 字节 + Content-Type） */
    fun take(url: String): Pair<ByteArray, String>? = lru.get(url)

    fun cachedBytes(): Long = lru.bytes

    fun cachedCount(): Int = lru.size

    fun clear() = lru.clear()

    /**
     * 后台预取播放列表开头若干分片。
     *
     * 故意不阻塞调用方：预取是锦上添花，失败了正常播放也照常进行。
     * 已经缓存或在途的分片直接跳过。
     */
    fun start(playlistUrl: String, count: Int = DEFAULT_COUNT) {
        scope.launch {
            val text =
                runCatching { Net.getText(playlistUrl) }
                    .onFailure { android.util.Log.d("LibreTV", "预取播放列表失败 $playlistUrl: ${it.message}") }
                    .getOrNull() ?: return@launch
            val segments = segmentUrls(text, playlistUrl).take(count.coerceIn(1, 32))
            segments.forEach { segment ->
                scope.launch {
                    if (!inflight.add(segment)) return@launch
                    try {
                        if (take(segment) == null) {
                            permits.withPermit {
                                val (data, type) = Net.getBytes(segment)
                                lru.put(segment, data, type)
                            }
                        }
                    } catch (e: Exception) {
                        // 单个分片失败不影响其它分片
                        android.util.Log.d("LibreTV", "预取分片失败 $segment: ${e.message}")
                    } finally {
                        inflight.remove(segment)
                    }
                }
            }
        }
    }

    /** 从 m3u8 取分片绝对地址（跳过注释行与加密 key） */
    internal fun segmentUrls(playlist: String, baseUrl: String): List<String> =
        playlist.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .mapNotNull { Parsers.normalizeStreamUrl(it, baseUrl) }
            .toList()
}
