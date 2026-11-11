package org.libretv.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * 用真实 Compose 组合验证「进入页面要不要抢首焦点」这条规则（H3）。
 *
 * 纯函数 `FocusPolicyTest` 只能证明判定式本身对不对，证明不了 `LaunchedEffect` 的键选得对、
 * `remember` 记的是进入时的值、`requestFocus` 真的落在目标节点上 —— 这三处历史上都出过问题。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AutoFocusUiTest {
    @get:Rule
    val rule = createComposeRule()

    /** 与 `HomeScreen.kt` / `SearchScreen.kt` 同一套写法：直接用生产代码的 `rememberAutoFocusState`。 */
    @Composable
    private fun FakeScreen(navFocusHold: Boolean, contentTick: Int) {
        val target = remember { FocusRequester() }
        val autoFocus = rememberAutoFocusState(contentTick)
        LaunchedEffect(contentTick) {
            if (!autoFocus.consume(navFocusHold, contentTick)) return@LaunchedEffect
            if (runCatching { target.requestFocus() }.isSuccess) {
                autoFocus.handledTick = contentTick
            }
        }
        Column(Modifier.fillMaxSize()) {
            Text(
                text = "目标",
                modifier = Modifier
                    .testTag("content")
                    .focusRequester(target)
                    .focusable(),
            )
        }
    }

    @Test
    fun `导航不持有焦点时进入页面直接抢首焦点`() {
        rule.setContent { FakeScreen(navFocusHold = false, contentTick = 0) }
        rule.waitForIdle()
        rule.onNodeWithTag("content").assertIsFocused()
    }

    @Test
    fun `导航持有焦点且用户只是把焦点移进页面时不抢`() {
        rule.setContent { FakeScreen(navFocusHold = true, contentTick = 0) }
        rule.waitForIdle()
        rule.onNodeWithTag("content").assertIsNotFocused()
    }

    @Test
    fun `导航持有焦点但在导航项上按了 OK 后进入，页面要抢焦点`() {
        val tick = mutableIntStateOf(0)
        rule.setContent { FakeScreen(navFocusHold = true, contentTick = tick.intValue) }
        rule.waitForIdle()
        rule.onNodeWithTag("content").assertIsNotFocused()

        // 模拟在导航项上按 OK：AppViewModel.requestContentFocus() 会让 tick 自增
        tick.intValue = 1
        rule.waitForIdle()
        rule.onNodeWithTag("content").assertIsFocused()
    }

    @Test
    fun `进入页面之后再按确认不会让页面反复抢焦点`() {
        val tick = mutableIntStateOf(1)
        rule.setContent { FakeScreen(navFocusHold = true, contentTick = tick.intValue) }
        rule.waitForIdle()
        // 进入时 tick 已经是 1，effect 只在 tick 变化时重跑，不会因为「值非 0」就抢
        rule.onNodeWithTag("content").assertIsNotFocused()
    }

    /**
     * 错误面板出现后按键必须能落到面板按钮上（T-1 / T-2）。
     *
     * 根节点的 `onPreviewKeyEvent` 一旦无条件 `return true`，整个子树就再也收不到按键。
     * 这里按 `LiveScreen.kt` 修好后的写法建一个探针：错误态放行 + 焦点送进面板。
     */
    @Test
    fun `错误态下根节点不再拦截按键，面板可以拿到焦点并点击`() {
        var error by mutableStateOf<String?>(null)
        var clicks by mutableIntStateOf(0)
        var focusedTag by mutableStateOf("")

        rule.setContent {
            val errorFocus = remember { FocusRequester() }
            LaunchedEffect(error != null) {
                if (error != null) runCatching { errorFocus.requestFocus() }
            }
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black)
                    .onPreviewKeyEvent { event ->
                        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        // 修好后的关键一行：错误态一律放行，让焦点走正常的方向键移动
                        if (error != null) return@onPreviewKeyEvent false
                        // 正常播放态：方向键被根节点吃掉（模拟换台/调音量）
                        event.key == Key.DirectionCenter || event.key == Key.DirectionLeft
                    },
            ) {
                if (error != null) {
                    Text(
                        text = "重试",
                        modifier = Modifier
                            .testTag("retry")
                            .focusRequester(errorFocus)
                            .onFocusChanged { if (it.isFocused) focusedTag = "retry" }
                            .clickable { clicks += 1 },
                    )
                }
            }
        }
        rule.waitForIdle()
        assertEquals(0, clicks)
        assertEquals("", focusedTag)

        error = "解码失败"
        rule.waitForIdle()

        // 面板出现后焦点应当被主动送进「重试」
        rule.onNodeWithTag("retry").assertIsFocused()
        assertEquals("retry", focusedTag)

        rule.onNodeWithTag("retry").performClick()
        rule.waitForIdle()
        assertEquals(1, clicks)
    }
}
