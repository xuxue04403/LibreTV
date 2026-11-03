package org.libretv.tv

/**
 * 返回栈：记录「当前页面是从哪儿来的」，决定按返回键退回哪一页。
 *
 * 抽成纯状态机是因为这里连续出过两个只有真按遥控器才会暴露的错：
 *
 * 1. 从详情页起播时没有把返回目标改成详情页，它还是进详情之前那一页，
 *    于是播放页按一次返回会**连退两级**（首页 → 分类 → 详情 → 播放，返回直接回分类）。
 * 2. 修 1 之后，播放页的返回目标变成了详情页本身；如果详情页的返回也读同一个字段，
 *    再按一次返回就会「退回详情页」原地不动 —— 所以详情页的来源单独记一份
 *    （[detailOrigin]）。
 *
 * 两个字段都由这里维护，页面代码不许直接改，避免再次各改各的。
 */
class NavStack {
    /** 播放页要退回的页面（进播放页之前的那一页） */
    var backTarget: Screen = Screen.Home
        private set

    /** 详情页要退回的页面（进详情页之前的那一页：分类页 / 搜索页 / 首页） */
    var detailOrigin: Screen = Screen.Home
        private set

    /** 进入详情页：只有从「非详情页」进才更新来源，换源导致的重复进详情不覆盖 */
    fun enterDetail(from: Screen) {
        if (from !is Screen.Detail) {
            backTarget = from
            detailOrigin = from
        }
    }

    /** 从详情页起播：返回键应退回这个详情页 */
    fun playFromDetail(detail: Screen.Detail) {
        backTarget = detail
    }

    /** 从首页的「继续观看 / 收藏」或分类页直接起播：返回键回到那一页 */
    fun playFrom(from: Screen) {
        backTarget = from
    }

    /** 当前页面按返回键该去的地方 */
    fun target(current: Screen): Screen = when (current) {
        is Screen.Player -> when (val origin = backTarget) {
            is Screen.Detail, is Screen.Category -> origin
            // 换源/投屏这类从播放器进的播放器，退回首页，
            // 不要退回一个已经不在的播放页
            is Screen.Player, is Screen.CastPlayer, is Screen.LivePlayer -> Screen.Home
            else -> origin
        }

        is Screen.LivePlayer -> Screen.Live

        // 详情页只从分类页或搜索页进入；首页直接打开的（没有来源）回首页
        is Screen.Detail ->
            detailOrigin.takeIf { it is Screen.Category || it is Screen.Search } ?: Screen.Home

        is Screen.Category -> Screen.Home
        is Screen.Cast -> Screen.Home
        is Screen.CastPlayer -> Screen.Home
        else -> Screen.Home
    }
}
