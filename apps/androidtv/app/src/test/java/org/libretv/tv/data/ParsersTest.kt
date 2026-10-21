package org.libretv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 纯 JVM 单测：验证 Kotlin 侧解析逻辑与桌面端 packages/core 的语义一致 */
class ParsersTest {

    private val source = VodSource("k1", "示例源", "https://example.com/api.php/provide/vod")

    @Test
    fun `解析标准搜索结果`() {
        val text = """
            {"code":1,"pagecount":1,"list":[
              {"vod_id":1,"vod_name":"流浪地球","vod_pic":"https://img/1.jpg","type_name":"科幻片","vod_year":"2019"}
            ]}
        """.trimIndent()
        val list = Parsers.parseSearchList(text, source)
        assertEquals(1, list.size)
        assertEquals("1", list[0].vodId)
        assertEquals("流浪地球", list[0].name)
        assertEquals("k1", list[0].sourceKey)
        assertEquals("科幻片", list[0].typeName)
    }

    @Test
    fun `list 为 null 时返回空列表`() {
        assertEquals(0, Parsers.parseSearchList("""{"list":null}""", source).size)
    }

    @Test
    fun `分集优先取含 m3u8 的线路`() {
        val playUrl =
            "第1集\$https://x.com/share/a.html#第2集\$https://x.com/share/b.html" +
                "\$\$\$第1集\$https://cdn.x.com/a/index.m3u8#第2集\$https://cdn.x.com/b/index.m3u8"
        val episodes = Parsers.extractEpisodes(playUrl)
        assertEquals(listOf("https://cdn.x.com/a/index.m3u8", "https://cdn.x.com/b/index.m3u8"), episodes)
    }

    @Test
    fun `无 m3u8 时回退第一条线路并过滤非 http`() {
        val episodes = Parsers.extractEpisodes("第1集\$ftp://x/a.mp4#第2集\$https://x.com/b.mp4")
        assertEquals(listOf("https://x.com/b.mp4"), episodes)
    }

    @Test
    fun `解析详情并兜底提取简介里的 m3u8`() {
        val detail = Parsers.parseDetail(
            """{"list":[{"vod_name":"三体","vod_content":"播放地址：${'$'}https://cdn/x/index.m3u8"}]}"""
        )
        assertEquals("三体", detail.title)
        assertEquals(listOf("https://cdn/x/index.m3u8"), detail.episodes)
    }

    @Test
    fun `M3U 解析分组与属性`() {
        val content = """
            #EXTM3U
            #EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV1" group-title="央视",CCTV-1 综合
            https://live.example.com/cctv1.m3u8
            #EXTINF:-1,湖南卫视
            #EXTGRP:地方台
            https://live.example.com/hunan.m3u8
        """.trimIndent()
        val channels = Parsers.parseM3u(content)
        assertEquals(2, channels.size)
        assertEquals("cctv1", channels[0].tvgId)
        assertEquals("央视", channels[0].group)
        assertEquals("地方台", channels[1].group)
        assertEquals(listOf("央视", "地方台"), Parsers.groups(channels))
    }

    @Test
    fun `M3U 过滤非 http 并去重`() {
        val content = """
            #EXTINF:-1,A
            rtp://239.0.0.1:1234
            #EXTINF:-1,B
            https://x/b.m3u8
            #EXTINF:-1,B2
            https://x/b.m3u8
        """.trimIndent()
        assertEquals(1, Parsers.parseM3u(content).size)
    }

    @Test
    fun `相关性过滤忽略标点且支持多词`() {
        assertTrue(Parsers.isRelevant("摔跤吧!爸爸", "摔跤吧！爸爸"))
        assertTrue(Parsers.isRelevant("庆余年 第二季", "庆余年"))
        assertFalse(Parsers.isRelevant("繁花", "庆余年"))
    }

    @Test
    fun `成人关键词过滤`() {
        val items = listOf(
            SearchItem("k", "s", "1", "a", typeName = "伦理片"),
            SearchItem("k", "s", "2", "b", typeName = "科幻片"),
        )
        val filtered = Parsers.filterAdult(items, true)
        assertEquals(1, filtered.size)
        assertEquals("b", filtered[0].name)
        assertEquals(2, Parsers.filterAdult(items, false).size)
    }

    @Test
    fun `同名同年聚合`() {
        val items = listOf(
            SearchItem("a", "甲源", "1", "三体", year = "2023"),
            SearchItem("b", "乙源", "2", "三体", year = "2023"),
            SearchItem("a", "甲源", "3", "繁花"),
        )
        val groups = Parsers.group(items)
        assertEquals(2, groups.size)
        assertEquals(2, groups[0].items.size)
    }

    @Test
    fun `订阅解析支持注释与尾随逗号并跳过 Spider`() {
        val text = """
            {
              // LibreTV-SourceList
              "sources": [{"name":"A","url":"https://a/api.php/provide/vod"},],
              "liveSources": [{"name":"L","url":"https://l/list.m3u"},]
            }
        """.trimIndent()
        val parsed = Subscriptions.parse(text, "https://sub.example.com/list.json")
        assertEquals(1, parsed.sources.size)
        assertEquals(1, parsed.liveSources.size)

        val tvbox = """
            {"sites":[
              {"name":"CMS","api":"https://cms/api.php/provide/vod","type":1},
              {"name":"Spider","api":"csp_AppYs","type":3}
            ],"lives":[]}
        """.trimIndent()
        val parsedTvbox = Subscriptions.parse(tvbox, null)
        assertEquals(1, parsedTvbox.sources.size)
        assertEquals(1, parsedTvbox.skipped)
    }
}
