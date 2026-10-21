package org.libretv.tv.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** 统一网络层：所有采集站/直播源请求都从这里走，便于注入 UA 与超时 */
object Net {
    const val UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

    private val client: OkHttpClient = OkHttpClient.Builder()
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

    /** 给 Coil 用的图片请求：带上 UA/Referer，绕部分图床防盗链 */
    fun imageRequest(url: String): Request =
        Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Referer", runCatching { java.net.URI(url).let { "${it.scheme}://${it.host}/" } }.getOrDefault(""))
            .build()

    val imageClient: OkHttpClient get() = client
}
