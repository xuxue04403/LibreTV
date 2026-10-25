package org.libretv.tv.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** 统一网络层：所有采集站/直播源请求都从这里走，便于注入 UA 与超时 */
object Net {
    const val UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

    /**
     * 分类浏览的全局并发闸门。
     *
     * 一次分类浏览要打「源数 × 子分类数」个请求，启动预热再叠上来，
     * 峰值能到三十几个并发；采集站的容忍度很低，会直接 503 / 断开，
     * 表现就是「所有源都失败、这个分类一部片子都没有」。
     */
    private val catalogSemaphore = Semaphore(6)

    /** 单个源自己的闸门：一个源内部的请求不要扎堆，否则它最容易把本机 IP 限掉 */
    private val sourceSemaphores = ConcurrentHashMap<String, Semaphore>()

    private fun sourceSemaphore(url: String): Semaphore =
        sourceSemaphores.getOrPut(url) { Semaphore(3) }

    /** 走分类闸门执行一次请求 */
    suspend fun <T> gated(host: String, block: suspend () -> T): T =
        catalogSemaphore.withPermit { sourceSemaphore(host).withPermit { block() } }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .retryOnConnectionFailure(true)
        .build()

    /**
     * 播放器专用的 OkHttp 客户端。
     *
     * 和 [client] 分开：播放要多路并发拉分片、且片段大、需要复用连接；
     * 元数据请求走小连接池即可，混在一起会让播放卡在分类请求后面排队。
     */
    val playbackClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .retryOnConnectionFailure(true)
        .build()

    suspend fun getText(url: String, headers: Map<String, String> = emptyMap()): String =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder().url(url).header("User-Agent", UA).header("Accept", "*/*")
            headers.forEach { (k, v) -> builder.header(k, v) }
            client.newCall(builder.build()).execute().use { response ->
                if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
                response.body?.string() ?: ""
            }
        }

    /**
     * 读文本，同时把**最终地址**（跟随重定向之后）带回来。
     *
     * 预取分片时必须用最终地址当相对路径的基准：CDN 常把 m3u8 302 到另一个目录，
     * 用入口地址去拼相对分片会拼到错的路径上，结果是「预取静默抓一堆 404、
     * 播放本身却正常」，几乎不可能靠现象发现。
     */
    suspend fun getTextWithUrl(
        url: String,
        headers: Map<String, String> = emptyMap()
    ): Pair<String, String> = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(url).header("User-Agent", UA).header("Accept", "*/*")
        headers.forEach { (k, v) -> builder.header(k, v) }
        client.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body?.string() ?: ""
            body to response.request.url.toString()
        }
    }

    /**
     * 整块读取字节（预取分片用）。
     *
     * 和 [getText] 分开是因为分片是二进制，走 string 会先按 UTF-8 解码再编码回来，
     * 既浪费一次全量拷贝，也会损坏非 UTF-8 字节。
     */
    suspend fun getBytes(url: String): Pair<ByteArray, String> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Accept", "*/*")
            .header("Accept-Encoding", "identity")
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body ?: throw IOException("空响应")
            val type = response.header("Content-Type") ?: "video/mp2t"
            body.bytes() to type
        }
    }

    /** 流式读取（直播/EPG 用），调用方负责关闭 */
    suspend fun stream(url: String): InputStream = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).header("User-Agent", UA).build()
        val response = client.newCall(request).execute()
        if (!response.isSuccessful) {
            response.close()
            throw IOException("HTTP ${response.code}")
        }
        response.body?.byteStream() ?: throw IOException("空响应")
    }

    /**
     * 逐行流式读取并回调。
     *
     * 为什么不用 getText：iptv-org 的 index.m3u 有 2.46MB，服务器限速到 ~35KB/s，
     * 整串读完要 70 秒以上；解析本身只要十几毫秒。边读边解析，第一个频道约 1 秒
     * 就能上屏，用户不必盯着空列表等一分钟。
     *
     * @param onLine 每读到一行回调一次（已去掉行尾 \r）；返回 false 可提前终止。
     *   允许挂起：渐进解析要在攒够一批时切回主线程刷新列表，若回调是同步的就没法做
     * @param onBytes 已读字节数回调（用于进度显示）
     */
    suspend fun forEachLine(
        url: String,
        headers: Map<String, String> = emptyMap(),
        onBytes: (Long) -> Unit = {},
        onLine: suspend (String) -> Boolean,
    ): Long = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(url).header("User-Agent", UA).header("Accept", "*/*")
        headers.forEach { (k, v) -> builder.header(k, v) }
        client.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body ?: throw IOException("空响应")
            var total = 0L
            var lastReport = 0L
            body.byteStream().bufferedReader(Charsets.UTF_8).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    total += line.length + 1L
                    // 每 64KB 报一次，避免进度回调本身成为开销
                    if (total - lastReport >= 64 * 1024) {
                        lastReport = total
                        onBytes(total)
                    }
                    if (!onLine(line)) break
                }
            }
            onBytes(total)
            total
        }
    }

    /** 给 Coil 用的图片请求：带上 UA/Referer，绕部分图床防盗链 */
    fun imageRequest(url: String): Request =
        Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Referer", runCatching { java.net.URI(url).let { "${it.scheme}://${it.host}/" } }.getOrDefault(""))
            .build()

    val imageClient: OkHttpClient get() = client
}
