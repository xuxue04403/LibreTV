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
}
