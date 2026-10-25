package org.libretv.tv.data

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * 会先看一眼预取缓存的数据源。
 *
 * 预取（[SegmentPrefetch]）与播放器是两条独立的取数路径；若播放器仍走
 * 普通 HTTP 数据源，预取就只是白跑一遍网络，对起播毫无帮助。
 * 这一层在正式发起请求之前先查缓存：命中就直接把字节喂给 ExoPlayer，
 * 命中不了再原样交给底层数据源，行为与原来完全一致。
 *
 * 只对**从头开始的整段请求**走缓存。两个条件缺一不可：
 * `position == 0` 且 `length == LENGTH_UNSET`。缓存里存的是完整分片，
 * `#EXT-X-BYTERANGE` 这类源会从 0 开始但要一个有限长度，命中后整段喂出去
 * 会让调用方按错误的边界切字节 —— 帧边界错乱、解复用失败。
 */
@UnstableApi
class PrefetchAwareDataSource(private val upstream: DataSource) : BaseDataSource(true) {

    /** 包装一个数据源工厂，其余配置（UA/超时/跳转）保持原样 */
    class Factory(private val upstream: DataSource.Factory) : DataSource.Factory {
        override fun createDataSource(): DataSource = PrefetchAwareDataSource(upstream.createDataSource())
    }

    private var cacheStream: InputStream? = null
    private var fromCache = false
    /** 底下那个数据源是否真的被打开过：缓存命中路径从不调 upstream.open() */
    private var upstreamOpened = false
    private var ended = false
    private var currentUri: Uri? = null
    private var bytesRemaining = C.LENGTH_UNSET.toLong()

    override fun getUri(): Uri? = currentUri

    override fun open(dataSpec: DataSpec): Long {
        currentUri = dataSpec.uri
        transferInitializing(dataSpec)

        // 只有「整段从头」才可能命中缓存，见类注释
        val wholeFromStart = dataSpec.position == 0L && dataSpec.length == C.LENGTH_UNSET.toLong()
        val hit = if (wholeFromStart) SegmentPrefetch.take(dataSpec.uri.toString()) else null

        if (hit != null) {
            val body = hit.first
            cacheStream = ByteArrayInputStream(body)
            fromCache = true
            ended = false
            bytesRemaining = body.size.toLong()
            transferStarted(dataSpec)
            return bytesRemaining
        }

        // 没命中：交给底层数据源正常请求。抛异常时也要把 transferEnded 补上，
        // 否则监听方的统计会一直挂在「传输中」。
        try {
            val length = upstream.open(dataSpec)
            upstreamOpened = true
            fromCache = false
            ended = false
            bytesRemaining = length
            transferStarted(dataSpec)
            return length
        } catch (e: Exception) {
            transferEnded()
            throw e
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        // C.LENGTH_UNSET（-1）表示长度未知，要一直读到 EOF；只有确切为 0 才算读完
        if (bytesRemaining == 0L) return C.RESULT_END_OF_INPUT
        val read =
            if (fromCache) cacheStream?.read(buffer, offset, length) ?: -1
            else upstream.read(buffer, offset, length)
        if (read == -1) return C.RESULT_END_OF_INPUT
        if (bytesRemaining != C.LENGTH_UNSET.toLong()) bytesRemaining -= read
        bytesTransferred(read)
        return read
    }

    override fun getResponseHeaders(): Map<String, List<String>> =
        if (fromCache) emptyMap() else upstream.responseHeaders

    override fun close() {
        val stream = cacheStream
        if (stream != null) runCatching { stream.close() }
        cacheStream = null
        // 只关真正打开过的那个：缓存命中路径从没碰过 upstream
        if (upstreamOpened) {
            runCatching { upstream.close() }
            upstreamOpened = false
        }
        if (!ended) {
            ended = true
            transferEnded()
        }
        bytesRemaining = C.LENGTH_UNSET.toLong()
        fromCache = false
        currentUri = null
    }
}
