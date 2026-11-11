package org.librextv.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 守住 Media3 `DefaultLoadControl` 的硬约束。
 *
 * 这些参数违反后只在**运行时 build()** 抛 `IllegalArgumentException`，编译器与 lint 都不报，
 * 而且发生在 Compose 帧回调里 —— 用户看到的就是「按播放整个 App 闪退」。
 * 这一组断言是那次线上崩溃的回归测试。
 */
class PlaybackTuningTest {

    @Test
    fun `当前参数不违反任何约束`() {
        assertEquals(emptyList<String>(), PlaybackTuning.violations())
    }

    @Test
    fun `历史故障参数会被判为违规`() {
        // 线上那组值：minBuffer = 1500、afterRebuffer = 3000
        val bad = PlaybackTuning.violations(
            minBufferMs = 1_500,
            maxBufferMs = 30_000,
            bufferForPlaybackMs = 1_200,
            bufferForPlaybackAfterRebufferMs = 3_000,
            backBufferMs = 20_000,
        )
        assertEquals(1, bad.size)
        assertTrue(bad.single(), bad.single().contains("minBufferMs(1500)"))
    }

    @Test
    fun `能一次报出全部违规项而不是只报第一条`() {
        val bad = PlaybackTuning.violations(
            minBufferMs = 1_000,
            maxBufferMs = 500,
            bufferForPlaybackMs = 2_000,
            bufferForPlaybackAfterRebufferMs = 3_000,
            backBufferMs = -1,
        )
        // maxBuffer < minBuffer、minBuffer < 起播门槛、minBuffer < 再缓冲门槛、backBuffer < 0
        assertEquals(4, bad.size)
    }

    @Test
    fun `负数缓冲全部违规`() {
        val bad = PlaybackTuning.violations(
            minBufferMs = -1,
            maxBufferMs = -1,
            bufferForPlaybackMs = -1,
            bufferForPlaybackAfterRebufferMs = -1,
            backBufferMs = -1,
        )
        assertTrue(bad.any { it.startsWith("bufferForPlaybackMs") })
        assertTrue(bad.any { it.startsWith("bufferForPlaybackAfterRebufferMs") })
        assertTrue(bad.any { it.startsWith("backBufferMs") })
    }

    @Test
    fun `起播门槛低于再缓冲门槛`() {
        // 首播比「卡顿后恢复」更容易满足，这是 ExoPlayer 的语义前提
        assertTrue(
            PlaybackTuning.BUFFER_FOR_PLAYBACK_MS <
                PlaybackTuning.BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS
        )
    }
}
