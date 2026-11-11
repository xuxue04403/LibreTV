package org.librextv.tv.cast

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/**
 * 极简 HTTP/1.1 请求解析（只服务于 DLNA 控制端）。
 *
 * 为什么单独抽出来：
 * 1) 这里曾经用 `BufferedReader` 读头、再用 `read(char[], ...)` 按 `Content-Length`
 *    读体——而 `Content-Length` 是**字节数**。SOAP 体里带中文标题时（`<dc:title>`
 *    就是我们自己塞进去的），UTF-8 下 3 字节才 1 个字符，字符数永远凑不满声明的
 *    字节数，于是阻塞到 socket 超时、一个字节的响应都不回，投屏必然失败。
 * 2) 头与体必须从**同一个字节流**顺序读：`BufferedReader` 会预读并缓存，
 *    混用 reader 与 socket 原始流会把 body 的前若干字节吃掉。
 * 3) `DlnaServer` 依赖 Context/WifiManager，无法用纯 JVM 测试覆盖；
 *    把协议解析放在这里，就能用 `ByteArrayInputStream` 直接喂报文做单测。
 */
object DlnaHttp {

    /** 单行上限：请求行/头部都远小于这个值，超过即视为畸形请求 */
    private const val MAX_LINE_BYTES = 8 * 1024

    private const val CR = '\r'.code
    private const val LF = '\n'.code

    data class Request(
        val method: String,
        val path: String,
        val headers: Map<String, String>,
        val body: String,
    )

    /**
     * 读一个完整请求。
     *
     * @param maxBodyBytes 请求体上限（**字节**，不是字符）
     * @param maxHeaders   头部行数上限
     * @return 解析结果；连请求行都读不到（对端直接关连接）时返回 null
     * @throws IOException 请求体超限、头部过多、body 被截断
     */
    fun readRequest(input: InputStream, maxBodyBytes: Int, maxHeaders: Int): Request? {
        val requestLine = readLine(input) ?: return null
        val requestLineText = String(requestLine, Charsets.ISO_8859_1)

        val headers = LinkedHashMap<String, String>()
        var headerCount = 0
        while (true) {
            val raw = readLine(input) ?: break
            if (raw.isEmpty()) break
            headerCount += 1
            if (headerCount > maxHeaders) throw IOException("请求头过多")
            val text = String(raw, Charsets.ISO_8859_1)
            val idx = text.indexOf(':')
            if (idx > 0) {
                headers[text.substring(0, idx).trim().lowercase()] = text.substring(idx + 1).trim()
            }
        }

        val declared = headers["content-length"]?.toIntOrNull() ?: 0
        if (declared < 0) throw IOException("Content-Length 非法: $declared")
        if (declared > maxBodyBytes) throw IOException("请求体过大: $declared > $maxBodyBytes")
        // 按字节读 declared 个，再整体按 UTF-8 解码：字节数对齐，中文不会再卡住
        val bodyBytes = if (declared == 0) ByteArray(0) else readExactly(input, declared)
        val body = String(bodyBytes, Charsets.UTF_8)

        return Request(
            method = requestLineText.substringBefore(' '),
            path = requestLineText.substringAfter(' ').substringBefore(' '),
            headers = headers,
            body = body,
        )
    }

    /** 读一行（以 LF 结尾，容忍 CRLF），不返回行尾换行符；流结束且无内容时返回 null */
    private fun readLine(input: InputStream): ByteArray? {
        val out = ByteArrayOutputStream(128)
        while (true) {
            val b = input.read()
            if (b == -1) return if (out.size() == 0) null else out.toByteArray()
            if (b == LF) return out.toByteArray()
            // CRLF 里的 CR 不属于内容；裸 CR 也一并丢掉（DLNA 控制端不会发裸 CR）
            if (b == CR) continue
            out.write(b)
            if (out.size() > MAX_LINE_BYTES) throw IOException("请求行/头部过长")
        }
    }

    /** 读满 want 个字节，读不满说明对端提前关连接 */
    private fun readExactly(input: InputStream, want: Int): ByteArray {
        val buffer = ByteArray(want)
        var read = 0
        while (read < want) {
            val r = input.read(buffer, read, want - read)
            if (r <= 0) throw IOException("请求体被截断：期望 $want 字节，实际 $read 字节")
            read += r
        }
        return buffer
    }
}
