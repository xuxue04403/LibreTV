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
     *
     * @param adFilter 与播放时一致地切掉中插广告段。播放器挂的是
     *   [AdFilteringPlaylistParserFactory]，被它摘掉的那几组广告分片永远不会被请求；
     *   预取若照原样抓，等于白下几 MB、还挤占 [permits] 与缓存配额，把真正要看的
     *   前几片挤到后面去。
     */
    fun start(playlistUrl: String, count: Int = DEFAULT_COUNT, adFilter: Boolean = true) {
        scope.launch {
            // 必须拿**最终地址**当基准：m3u8 常被 302 到另一个 CDN 目录，
            // 用入口地址拼相对分片会全部拼错（404），且现象只有「预取毫无效果」。
            var url = playlistUrl
            var raw: String
            var finalUrl: String
            var depth = 0
            while (true) {
                val loaded =
                    runCatching { Net.getTextWithUrlGated(url) }
                        .onFailure { android.util.Log.d("LibreTV", "预取播放列表失败 $url: ${it.message}") }
                        .getOrNull() ?: return@launch
                raw = loaded.first
                finalUrl = loaded.second
                // master 播放列表里列的是**子播放列表**而不是分片。
                // 早先这里只打一行日志就照原样往下抓，于是每个「分片」其实是一个 m3u8，
                // 被当成媒体字节塞进 LRU：既白占内存配额，又让播放器真的来取分片时全部未命中。
                // 这里按桌面端的做法往下钻一层（取带宽居中的那档），换成真正的媒体列表。
                if (!raw.contains("#EXT-X-STREAM-INF", ignoreCase = true)) break
                if (depth >= MAX_MASTER_DEPTH) {
                    android.util.Log.d("LibreTV", "预取跳过：master 嵌套过深 $playlistUrl")
                    return@launch
                }
                val variants = segmentUrls(if (adFilter) AdFilter.strip(raw) else raw, finalUrl)
                val picked = variants.getOrNull(variants.size / 2) ?: variants.firstOrNull()
                if (picked == null) {
                    android.util.Log.d("LibreTV", "预取跳过：master 里没有变体 $playlistUrl")
                    return@launch
                }
                url = picked
                depth += 1
            }
            val body = if (adFilter) AdFilter.strip(raw) else raw
            val segments = segmentUrls(body, finalUrl).take(count.coerceIn(1, 32))
            if (segments.isEmpty()) {
                android.util.Log.d("LibreTV", "预取跳过：列表为空 $playlistUrl")
                return@launch
            }
            segments.forEach { segment ->
                scope.launch {
                    if (!inflight.add(segment)) return@launch
                    try {
                        if (take(segment) == null) {
                            permits.withPermit {
                                val (data, type) = Net.getBytesGated(segment)
                                // 拿到的仍是播放列表（多层 master / 变体返回 m3u8）：不要污染 LRU
                                if (!looksLikePlaylist(data)) lru.put(segment, data, type)
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

    /** 抓回来的东西是不是播放列表文本（而不是媒体分片） */
    internal fun looksLikePlaylist(data: ByteArray): Boolean {
        val head = String(data, 0, minOf(data.size, 64), Charsets.UTF_8)
        return head.trimStart('\uFEFF', ' ', '\r', '\n').startsWith("#EXTM3U")
    }

    private const val MAX_MASTER_DEPTH = 2
}
