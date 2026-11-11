package org.librextv.tv.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 首焦点策略（H3 / T-13 的回归护栏）。
 *
 * 这一组断言锁住两条互相矛盾的需求：
 * 1. 焦点在导航栏里移动就切页时，页面**不许**抢焦点（否则 ↓ 走不到下一个导航项）；
 * 2. 用户在导航项上按 OK 明确进入后，页面**必须**抢焦点（否则进页面没有任何落点）。
 *
 * 旧实现只有 `if (navFocusHold) return`，第 2 条永远不成立 —— 这些用例在旧实现上会红。
 */
class FocusPolicyTest {

    @Test
    fun `焦点由页面自己持有时不看确认信号，直接抢`() {
        assertTrue(FocusPolicy.shouldAutoFocus(navFocusHold = false, handledTick = 0, currentTick = 0))
        assertTrue(FocusPolicy.shouldAutoFocus(navFocusHold = false, handledTick = 3, currentTick = 3))
    }

    @Test
    fun `导航持有焦点且进入后没有确认时不抢`() {
        assertFalse(FocusPolicy.shouldAutoFocus(navFocusHold = true, handledTick = 0, currentTick = 0))
        assertFalse(FocusPolicy.shouldAutoFocus(navFocusHold = true, handledTick = 5, currentTick = 5))
    }

    @Test
    fun `导航持有焦点但进入后按了 OK 则抢`() {
        assertTrue(FocusPolicy.shouldAutoFocus(navFocusHold = true, handledTick = 0, currentTick = 1))
        assertTrue(FocusPolicy.shouldAutoFocus(navFocusHold = true, handledTick = 5, currentTick = 6))
    }

    @Test
    fun `同一页里已经响应过的确认不会让它反复抢焦点`() {
        // 关键回归点：tick 与 handledTick 相同（焦点靠移动进页面）时必须是 false，
        // 否则 tick 一旦非 0，之后每次进页面都会抢焦点、↓ 又走不到第二项。
        assertFalse(FocusPolicy.shouldAutoFocus(navFocusHold = true, handledTick = 7, currentTick = 7))
    }
}

/**
 * 「已响应序号」必须是页面自持的可变状态。
 *
 * 之前 `HomeScreen.kt` / `SearchScreen.kt` 写的是 `remember(tick) { tick }`：
 * `handledTick` 跟着 `currentTick` 一起变，两者永远相等，上面第 3 条分支成了死代码，
 * 表现为「在导航项上按 OK 进页面，页面仍然不抢焦点」。这组用例锁住那个错误写法。
 */
class AutoFocusStateTest {

    @Test
    fun `进入时记下的序号不会随确认信号一起漂移`() {
        val state = AutoFocusState(initialTick = 0)
        // 模拟用户随后在导航项上按 OK（AppViewModel.contentFocusTick 自增）
        assertTrue(state.consume(navFocusHold = true, currentTick = 1))
        // 消费之后同一页再判定就不该再抢
        state.handledTick = 1
        assertFalse(state.consume(navFocusHold = true, currentTick = 1))
    }

    @Test
    fun `进入本页之前的确认不算数`() {
        // 页面在 tick=4 时组合：说明确认发生在别的页面，本页不该抢
        val state = AutoFocusState(initialTick = 4)
        assertFalse(state.consume(navFocusHold = true, currentTick = 4))
    }

    @Test
    fun `页面自己持有焦点时始终抢，与序号无关`() {
        val state = AutoFocusState(initialTick = 4)
        assertTrue(state.consume(navFocusHold = false, currentTick = 4))
        assertTrue(state.consume(navFocusHold = false, currentTick = 9))
    }
}
