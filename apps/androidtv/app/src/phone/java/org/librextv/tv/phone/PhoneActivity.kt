package org.librextv.tv.phone

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import org.librextv.tv.AppViewModel
import org.librextv.tv.cast.CastRuntime
import org.librextv.tv.cast.DlnaServer
import org.librextv.tv.data.Pinyin
import org.librextv.tv.ui.theme.LibreXtvTheme

/**
 * 手机版入口。
 *
 * 与电视版 [MainActivity] 的差别只在壳：
 * - 不做 960×540 的电视密度归一化，直接用系统 density（手机本来就按 dp 排版）；
 * - 清单里固定竖屏；播放页由 [PhoneApp] 在进出时动态切横屏/竖屏；
 * - 其余（数据层、[AppViewModel]、拼音表、DLNA 接收端）与电视版完全一致。
 *
 * 本文件在 `src/phone`，与 `src/tv` 的 MainActivity 靠 product flavor 二选一编译。
 */
class PhoneActivity : ComponentActivity() {
    private var dlna: DlnaServer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installPinyinTable()
        startCastReceiver()

        setContent {
            LibreXtvTheme {
                val vm: AppViewModel = viewModel()
                PhoneApp(vm)
            }
        }
    }

    /**
     * 载入拼音首字母表与多音字备选表。
     *
     * 手机上用户本来就能打中文，但「只记得首字母」时拼音检索仍是快手路径，
     * 所以照旧安装；读失败只影响拼音检索，普通搜索照常。
     */
    private fun installPinyinTable() {
        runCatching {
            assets.open("pinyin-table.txt").bufferedReader().use { Pinyin.install(it.readText()) }
        }
        runCatching {
            assets.open("pinyin-alts.txt").bufferedReader().use { Pinyin.installAlts(it.readText()) }
        }
    }

    /**
     * 启动 DLNA 接收端：让同一局域网里的其它设备把本机当成投屏目标。
     *
     * 手机版保留这个能力——家里没有电视盒子时，用另一台手机/平板投到这台机器上放。
     * 端口被占用或组播权限拿不到时只记日志，不影响本地播放。
     */
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
            Log.w("PhoneActivity", "DLNA 启动失败: ${it.message}")
        }
    }

    override fun onDestroy() {
        dlna?.stop()
        dlna = null
        CastRuntime.running = false
        super.onDestroy()
    }
}
