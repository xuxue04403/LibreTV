package org.libretv.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import org.libretv.tv.cast.CastRuntime
import org.libretv.tv.cast.DlnaServer
import org.libretv.tv.ui.LibretvApp
import org.libretv.tv.ui.theme.LibreTvTheme

class MainActivity : ComponentActivity() {
    private var dlna: DlnaServer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startCastReceiver()

        setContent {
            LibreTvTheme {
                val vm: AppViewModel = viewModel()
                LibretvApp(vm)
            }
        }
    }

    /** 启动 DLNA 接收端：让手机投屏列表里出现本机 */
    private fun startCastReceiver() {
        runCatching {
            dlna = DlnaServer.start(applicationContext) { url, title ->
                CastRuntime.onIncoming(url, title)
            }.also { server ->
                CastRuntime.running = server.running
                CastRuntime.address = server.address
                CastRuntime.error = null
            }
        }.onFailure {
            CastRuntime.running = false
            CastRuntime.error = it.message ?: "DLNA 启动失败"
        }
    }

    override fun onDestroy() {
        dlna?.stop()
        dlna = null
        CastRuntime.running = false
        super.onDestroy()
    }
}
