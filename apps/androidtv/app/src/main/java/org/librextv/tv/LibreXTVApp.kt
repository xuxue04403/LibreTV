package org.librextv.tv

import android.app.Application
import android.content.ComponentCallbacks2
import android.util.Log
import org.librextv.tv.data.SegmentPrefetch

class LibreXtvApp : Application() {
    /**
     * 内存吃紧时把分片预取缓存还回去。
     *
     * 缓存是 32MB 级的 ByteArray，对电视盒子（heap 常见 192MB）不是小数目。
     * 系统压过来时优先丢它：丢了只是下一片要回源，留着则可能被 OOM 杀掉整个进程。
     */
    @Suppress("DEPRECATION") // TRIM_MEMORY_RUNNING_LOW 在 API 34 标记废弃，但 minSdk 23 仍需要它
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // 10 = TRIM_MEMORY_RUNNING_LOW，从低到高还有 MODERATE / COMPLETE 等更严重的档位
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            SegmentPrefetch.clear()
            Log.d("LibreXTV", "内存压力 $level：已释放分片预取缓存")
        }
    }

    override fun onLowMemory() {
        super.onLowMemory()
        SegmentPrefetch.clear()
    }
}
