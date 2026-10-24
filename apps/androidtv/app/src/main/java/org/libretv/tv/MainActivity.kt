package org.libretv.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import org.libretv.tv.cast.CastRuntime
import org.libretv.tv.data.Pinyin
import org.libretv.tv.cast.DlnaServer
import org.libretv.tv.ui.LibretvApp
import org.libretv.tv.ui.theme.LibreTvTheme
import org.libretv.tv.ui.theme.TvScaleSurface

class MainActivity : ComponentActivity() {
    private var dlna: DlnaServer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installPinyinTable()
        startCastReceiver()

        setContent {
            LibreTvTheme {
                // 不同电视上报的 densityDpi 差异很大（720p 盒子常报 160/213），
                // 不归一化就会「不随分辨率缩放」，这里统一拉回 960×540dp 设计基准
                TvScaleSurface {
                    val vm: AppViewModel = viewModel()
                    LibretvApp(vm)
                }
            }
        }
    }

    /**
     * 载入拼音首字母表（21KB 文本）。
     *
     * 遥控器输中文很痛苦，有了它用户敲 `qmmk` 就能搜「奇妙萌可」。
     * 读失败只影响拼音检索，普通搜索照常可用，所以整段吞掉异常。
     */
    private fun installPinyinTable() {
        runCatching {
            assets.open("pinyin-table.txt").bufferedReader().use { Pinyin.install(it.readText()) }
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
