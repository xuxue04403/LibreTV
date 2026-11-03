package org.libretv.tv.cast

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * 一次投屏请求。
 *
 * [seq] 是必需的：手机重复投同一部片（同一 url、同一 title，比如上次播完
 * 又点了一次投屏）时，只有 url/title 的 data class 与上一次**完全相等**，
 * `mutableStateOf` 判定「值没变」就不会通知，`LaunchedEffect(pending)` 也不会重启，
 * 电视端表现为完全没反应——用户按了投屏，电视一动不动。
 * 每次请求带上自增序号，保证状态一定发生变化。
 */
data class CastRequest(val url: String, val title: String, val seq: Long)

/**
 * DLNA 接收端的运行时状态（Compose 可观察）。
 * 服务本身跑在 MainActivity 里，界面只读这个对象。
 */
object CastRuntime {
    var running by mutableStateOf(false)
    var address by mutableStateOf("")
    var lastUrl by mutableStateOf<String?>(null)
    var lastTitle by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    var pending by mutableStateOf<CastRequest?>(null)

    /** 请求自增序号：同地址重复投屏靠它区分（见 [CastRequest.seq]） */
    private var seq = 0L

    fun onIncoming(url: String, title: String) {
        lastUrl = url
        lastTitle = title
        seq += 1
        pending = CastRequest(url, title, seq)
    }

    // —— 传输控制面（DLNA 的 Play/Pause/Stop/Seek 靠它真正起作用） ——
    //
    // ExoPlayer 只能在它的应用线程（主线程）上调用，而 DlnaServer 跑在自己的线程里，
    // 所以这里不直接持有 player：CastPlayerScreen 注册一个 [CastTransport]，
    // 由它把调用 post 回主线程。没有注册（尚未开始播放）时所有命令都是空操作，
    // 但**状态仍要如实回报**，否则手机端的控制条会一直显示「播放中」。

    /** 投屏播放器的控制入口，由 CastPlayerScreen 注册/注销。 */
    interface CastTransport {
        fun play()
        fun pause()
        fun seekTo(positionMs: Long)
    }

    @Volatile
    var transport: CastTransport? = null

    /** "PLAYING" / "PAUSED_PLAYBACK" / "STOPPED"，GetTransportInfo 直接回这个。 */
    @Volatile
    var playbackState: String = "STOPPED"

    @Volatile
    var positionMs: Long = 0L

    @Volatile
    var durationMs: Long = 0L

    fun play() {
        transport?.play()
        playbackState = "PLAYING"
    }

    fun pause() {
        transport?.pause()
        playbackState = "PAUSED_PLAYBACK"
    }

    fun stop() {
        transport?.pause()
        playbackState = "STOPPED"
        positionMs = 0L
    }

    fun seek(ms: Long) {
        transport?.seekTo(ms.coerceAtLeast(0L))
        positionMs = ms.coerceAtLeast(0L)
    }

    /** 播放器页面销毁时调用，避免把命令发给已释放的 ExoPlayer。 */
    fun clearTransport() {
        transport = null
        playbackState = "STOPPED"
        positionMs = 0L
        durationMs = 0L
    }
}
