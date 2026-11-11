package org.librextv.tv.data

/**
 * ExoPlayer 的缓冲参数，单独抽出来是为了能被单测覆盖。
 *
 * Media3 的 `DefaultLoadControl` 有三条**硬约束**，违反任意一条都会在 `build()` 时抛
 * `IllegalArgumentException`，而它发生在 Compose 的组合/帧回调里 —— 表现就是「一点播放整个 App 闪退」，
 * 连 catch 的机会都没有。这类错误编译器完全查不出来，只能靠约束本身 + 单测兜住。
 *
 * 曾经的真实故障：`MIN_BUFFER_MS` 设成 1500 而 `AFTER_REBUFFER` 是 3000，装到设备上按播放立刻崩溃。
 */
object PlaybackTuning {

    /** 起播后维持的最小缓冲 */
    const val MIN_BUFFER_MS = 2_500
    /** 弱网时最多攒到这里就暂停预读 */
    const val MAX_BUFFER_MS = 30_000
    /** 攒够这么多就可以出画 */
    const val BUFFER_FOR_PLAYBACK_MS = 1_200
    /** 卡顿恢复后重新起播的门槛 */
    const val BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS = 2_000
    /** 允许回退缓存，电视上拖回看过的片段不必重新拉 */
    const val BACK_BUFFER_MS = 20_000

    /**
     * 返回所有被违反的约束（空列表表示合法）。
     *
     * 不写成 `require(...)` 是因为想让它可测：单测要能一次看到**全部**违规项，而不是撞到第一条就抛。
     * 参数带默认值，单测可以直接喂一组坏值来验证规则本身，不必改常量。
     */
    fun violations(
        minBufferMs: Int = MIN_BUFFER_MS,
        maxBufferMs: Int = MAX_BUFFER_MS,
        bufferForPlaybackMs: Int = BUFFER_FOR_PLAYBACK_MS,
        bufferForPlaybackAfterRebufferMs: Int = BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS,
        backBufferMs: Int = BACK_BUFFER_MS,
    ): List<String> = buildList {
        if (maxBufferMs < minBufferMs) {
            add("maxBufferMs($maxBufferMs) < minBufferMs($minBufferMs)")
        }
        if (minBufferMs < bufferForPlaybackMs) {
            add("minBufferMs($minBufferMs) < bufferForPlaybackMs($bufferForPlaybackMs)")
        }
        if (minBufferMs < bufferForPlaybackAfterRebufferMs) {
            add(
                "minBufferMs($minBufferMs) < bufferForPlaybackAfterRebufferMs" +
                    "($bufferForPlaybackAfterRebufferMs)"
            )
        }
        if (bufferForPlaybackMs < 0) add("bufferForPlaybackMs($bufferForPlaybackMs) < 0")
        if (bufferForPlaybackAfterRebufferMs < 0) {
            add("bufferForPlaybackAfterRebufferMs($bufferForPlaybackAfterRebufferMs) < 0")
        }
        if (backBufferMs < 0) add("backBufferMs($backBufferMs) < 0")
    }
}
