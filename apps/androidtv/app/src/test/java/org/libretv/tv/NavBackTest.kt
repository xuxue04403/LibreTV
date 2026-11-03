package org.libretv.tv

import org.junit.Assert.assertEquals
import org.junit.Test
import org.libretv.tv.data.CategoryKey
import org.libretv.tv.data.LiveChannel
import org.libretv.tv.data.SearchGroup
import org.libretv.tv.data.SearchItem
import org.libretv.tv.data.VodSource

/**
 * 返回键的退页判定。
 *
 * 这里守的是两个只有真按遥控器才会暴露的 bug：
 *
 * * 播放页按一次返回**连退两级**（因为起播时没把返回目标改成详情页）；
 * * 修完之后详情页按返回**原地不动**（因为两个页面共用同一个返回目标）。
 *
 * 所以测试不直接喂参，而是按真实操作顺序驱动 [NavStack]：
 * 进详情 → 起播 → 按返回 → 再按返回。
 */
class NavBackTest {
    private fun player() = Screen.Player(
        source = VodSource("s1", "源一", "https://example.com/api"),
        vodId = "42",
        title = "对家和我",
        cover = null,
        episodes = listOf("https://example.com/1.m3u8", "https://example.com/2.m3u8"),
        startIndex = 0,
        sourceName = "源一",
    )

    private fun item() = SearchItem(
        sourceKey = "s1",
        sourceName = "源一",
        vodId = "42",
        name = "对家和我",
        year = "2028",
    )

    private fun detail() = Screen.Detail(
        group = SearchGroup(key = "对家和我", name = "对家和我", items = listOf(item())),
        item = item(),
    )

    private fun movie() = Screen.Category(CategoryKey.MOVIE)

    @Test
    fun `分类页进详情再起播，第一次返回退到详情、第二次退到分类`() {
        val nav = NavStack()
        val d = detail()
        nav.enterDetail(movie())
        nav.playFromDetail(d)

        // 第一次返回：播放页 → 详情页（曾经直接跳回分类页，即「连退两级」）
        val first = nav.target(player())
        assertEquals(d, first)

        // 第二次返回：详情页 → 分类页（曾经退回到详情页自己，即「原地不动」）
        assertEquals(movie(), nav.target(first))
    }

    @Test
    fun `搜索页进详情再起播，原路退回搜索页`() {
        val nav = NavStack()
        val d = detail()
        nav.enterDetail(Screen.Search)
        nav.playFromDetail(d)

        val first = nav.target(player())
        assertEquals(d, first)
        assertEquals(Screen.Search, nav.target(first))
    }

    @Test
    fun `首页直接打开详情时详情页退回首页`() {
        val nav = NavStack()
        val d = detail()
        nav.enterDetail(Screen.Home)
        nav.playFromDetail(d)

        val first = nav.target(player())
        assertEquals(d, first)
        assertEquals(Screen.Home, nav.target(first))
    }

    @Test
    fun `从首页继续观看或收藏起播，返回直接回首页`() {
        val nav = NavStack()
        nav.playFrom(Screen.Home)
        assertEquals(Screen.Home, nav.target(player()))
    }

    @Test
    fun `从分类页直接起播，返回退回分类页`() {
        val nav = NavStack()
        val m = movie()
        nav.playFrom(m)
        assertEquals(m, nav.target(player()))
    }

    @Test
    fun `换源导致的重复进详情不会覆盖详情页的来源页`() {
        val nav = NavStack()
        nav.enterDetail(movie())
        // 换源时详情页会被重新设一次，来源页必须保持不变
        nav.enterDetail(detail())
        assertEquals(movie(), nav.target(detail()))
    }

    @Test
    fun `直播播放页退回直播列表`() {
        val nav = NavStack()
        val channel = LiveChannel(id = "c1", name = "CCTV1", url = "https://example.com/live.m3u8")
        assertEquals(Screen.Live, nav.target(Screen.LivePlayer(channel)))
    }

    @Test
    fun `投屏播放页与设置页退回首页`() {
        val nav = NavStack()
        assertEquals(Screen.Home, nav.target(Screen.CastPlayer("https://example.com/a.m3u8", "片子")))
        assertEquals(Screen.Home, nav.target(Screen.Cast))
        assertEquals(Screen.Home, nav.target(Screen.Home))
    }
}
