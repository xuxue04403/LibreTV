package org.librextv.tv.cast

import java.io.ByteArrayInputStream
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * DLNA 请求解析：曾经的必现缺陷是「把 Content-Length（字节）当字符数读」，
 * 导致含中文 `<dc:title>` 的 SetAVTransportURI 永远读不满、卡到 socket 超时，
 * 投屏 100% 失败。这里用真实报文锁住该行为。
 */
class DlnaHttpTest {

    private fun parse(raw: ByteArray) =
        DlnaHttp.readRequest(ByteArrayInputStream(raw), MAX_BODY_BYTES, MAX_HEADERS)

    private fun parse(raw: String) = parse(raw.toByteArray(Charsets.UTF_8))

    @Test
    fun `中文标题的 SOAP 报文能按字节读完并正确解码`() {
        val soap =
            """
            <?xml version="1.0"?>
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
              <s:Body>
                <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
                  <InstanceID>0</InstanceID>
                  <CurrentURI>http://192.168.1.10:9000/video.m3u8</CurrentURI>
                  <CurrentURIMetaData>&lt;dc:title&gt;名侦探柯南：黑铁的鱼影&lt;/dc:title&gt;</CurrentURIMetaData>
                </u:SetAVTransportURI>
              </s:Body>
            </s:Envelope>
            """.trimIndent()
        val bodyBytes = soap.toByteArray(Charsets.UTF_8)
        // 字节数远大于字符数（每个汉字 3 字节）：正是旧实现卡死的原因
        assertTrue(bodyBytes.size > soap.length)

        val request = parse(
            "POST /AVTransport/control HTTP/1.1\r\n" +
                "Host: 192.168.1.10:9000\r\n" +
                "Content-Length: ${bodyBytes.size}\r\n" +
                "SOAPACTION: \"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI\"\r\n" +
                "\r\n" + soap
        )

        assertEquals("POST", request?.method)
        assertEquals("/AVTransport/control", request?.path)
        assertEquals(bodyBytes.size.toString(), request?.headers?.get("content-length"))
        assertEquals(soap, request?.body)
        assertTrue(request!!.body.contains("名侦探柯南：黑铁的鱼影"))
    }

    @Test
    fun `纯 ASCII 报文保持原样`() {
        val soap = "<s:Envelope><x>plain</x></s:Envelope>"
        val bytes = soap.toByteArray(Charsets.UTF_8)
        val request = parse(
            "POST /RenderingControl/control HTTP/1.1\r\n" +
                "Content-Length: ${bytes.size}\r\n\r\n" + soap
        )
        assertEquals(soap, request?.body)
    }

    @Test
    fun `没有 Content-Length 时不读 body`() {
        val request = parse("GET /description.xml HTTP/1.1\r\nHost: tv\r\n\r\n")
        assertEquals("GET", request?.method)
        assertEquals("/description.xml", request?.path)
        assertEquals("", request?.body)
    }

    @Test
    fun `Content-Length 超过上限直接拒绝，不会尝试分配`() {
        val error = assertThrows(IOException::class.java) {
            parse("POST /AVTransport/control HTTP/1.1\r\nContent-Length: 999999999\r\n\r\n")
        }
        assertTrue(error.message!!.contains("请求体过大"))
    }

    @Test
    fun `body 被截断时报错而不是静默返回半截`() {
        val error = assertThrows(IOException::class.java) {
            parse("POST /AVTransport/control HTTP/1.1\r\nContent-Length: 100\r\n\r\nshort")
        }
        assertTrue(error.message!!.contains("截断"))
    }

    @Test
    fun `请求头过多直接拒绝`() {
        val headers = (1..(MAX_HEADERS + 1)).joinToString("") { "X-H$it: v\r\n" }
        val error = assertThrows(IOException::class.java) {
            parse("GET /description.xml HTTP/1.1\r\n$headers\r\n")
        }
        assertTrue(error.message!!.contains("请求头过多"))
    }

    @Test
    fun `对端直接关闭连接返回 null`() {
        assertEquals(null, parse(ByteArray(0)))
    }

    @Test
    fun `头部大小写不敏感`() {
        val request = parse("POST /x HTTP/1.1\r\nCONTENT-LENGTH: 2\r\n\r\nhi")
        assertEquals("hi", request?.body)
    }

    private companion object {
        const val MAX_BODY_BYTES = 64 * 1024
        const val MAX_HEADERS = 64
    }
}
