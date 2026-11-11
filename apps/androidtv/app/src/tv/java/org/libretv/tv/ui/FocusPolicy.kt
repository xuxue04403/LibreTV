package org.libretv.tv.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * 页面进入时「要不要自己抢首焦点」的判定。
 *
 * 背景：左侧导航是「焦点移上去就切页」的，所以目标页组合的那一刻
 * `AppViewModel.navFocusHold` 必然是 true。旧实现直接在
 * `LaunchedEffect(Unit)` 里 `if (navFocusHold) return`，结果**任何页面都拿不到首焦点**
 * ——进页面后遥控器上下键没有落点，只能先去导航栏再折回来。
 *
 * 正确的信号不是「有没有按 ↓ 离开导航」（分不出来），而是「用户有没有明确确认进入」
 * ——在导航项上按 OK 会 `requestContentFocus()` 让序号自增。这里用「已经响应过的序号」
 * 与「当前序号」比较，保证只有**进入之后**发生的确认才触发抢焦点：
 * 否则序号一旦变成 1，之后每次靠焦点移动进页面都会重新抢，↓ 又走不到第二项。
 */
object FocusPolicy {
    /**
     * @param navFocusHold 进入时导航是否正持有焦点
     * @param handledTick 本页**已经响应过**的确认序号
     * @param currentTick 当前的确认序号
     */
    fun shouldAutoFocus(navFocusHold: Boolean, handledTick: Int, currentTick: Int): Boolean =
        !navFocusHold || currentTick != handledTick
}

/**
 * 页面自持的「已响应确认序号」。
 *
 * 必须记成**页面自己的可变状态**（而不是 `remember(tick) { tick }`）：后者会让
 * `handledTick` 跟着 `currentTick` 一起变，两者永远相等，`FocusPolicy` 里
 * `currentTick != handledTick` 这条分支就成了死代码 —— 表现为「在导航项上按 OK 进页面，
 * 页面仍然不抢焦点」，正是 H3 要修的那个现象。
 *
 * 用完即消费（把 `handledTick` 推到 `currentTick`），所以同一页里再次把焦点移到导航栏
 * 不会让页面反复抢焦点。
 */
@Stable
class AutoFocusState(initialTick: Int) {
    var handledTick by mutableIntStateOf(initialTick)

    /**
     * 按当前状态判断要不要抢焦点，并在 [requestFocus] 成功后消费掉这次确认。
     * 传 `Boolean` 返回值便于页面用 `LaunchedEffect(shouldFocus)` 承接重试逻辑。
     */
    fun consume(navFocusHold: Boolean, currentTick: Int): Boolean =
        FocusPolicy.shouldAutoFocus(navFocusHold, handledTick, currentTick)
}

/** 页面组合时创建，`initialTick` 取当前序号：进入本页之前的确认不算数。 */
@Composable
fun rememberAutoFocusState(currentTick: Int): AutoFocusState =
    remember { AutoFocusState(currentTick) }
