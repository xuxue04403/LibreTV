package org.libretv.tv.cast

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

data class CastRequest(val url: String, val title: String)

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

    fun onIncoming(url: String, title: String) {
        lastUrl = url
        lastTitle = title
        pending = CastRequest(url, title)
    }
}
