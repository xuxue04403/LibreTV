package org.libretv.tv.data

import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory

/**
 * ExoPlayer 的构建与调优。
 *
 * 电视盒子的解码与内存都有限，默认参数有两个问题：
 * 1) 默认起播缓冲只有 2.5s、再缓冲 5s：网络稍抖就卡住，用户看到的是「一直转圈」；
 * 2) 默认 HTTP 数据源不带 Referer/UA，部分采集站的分片会 403，表现为「某些源永远播不了」。
 *
 * 这里放宽缓冲区间（起播更快、抗抖更强）并统一请求头。
 */
@UnstableApi
object Playback {

    /** 播放器统一用的 HTTP 数据源（UA / 超时 / 跨协议跳转都在这里配） */
    fun dataSourceFactory(): DefaultHttpDataSource.Factory =
        DefaultHttpDataSource.Factory()
            .setUserAgent(Net.UA)
            .setConnectTimeoutMs(12_000)
            .setReadTimeoutMs(20_000)
            // 分片请求偶尔 4xx 是防盗链抖动，允许一次重试比直接判死更实用
            .setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(
                mapOf(
                    "Accept" to "*/*",
                    "Accept-Encoding" to "identity",
                )
            )

    fun build(context: Context): ExoPlayer {
        // 参数本身放在 PlaybackTuning 里，由单测保证不违反 Media3 的三条硬约束
        // （违反会在 build() 时抛 IllegalArgumentException，表现为按播放就闪退）
        check(PlaybackTuning.violations().isEmpty()) {
            "ExoPlayer 缓冲参数不合法: " + PlaybackTuning.violations().joinToString("; ")
        }
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                PlaybackTuning.MIN_BUFFER_MS,
                PlaybackTuning.MAX_BUFFER_MS,
                PlaybackTuning.BUFFER_FOR_PLAYBACK_MS,
                PlaybackTuning.BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS,
            )
            .setBackBuffer(PlaybackTuning.BACK_BUFFER_MS, true)
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()

        return ExoPlayer.Builder(context)
            .setLoadControl(loadControl)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory()))
            .build()
            .apply {
                playWhenReady = true
                setHandleAudioBecomingNoisy(true)
                // 申请音频焦点：电视上不申请会和其他 App 混音，回桌面后仍继续出声
                setAudioAttributes(
                    androidx.media3.common.AudioAttributes.Builder()
                        .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MOVIE)
                        .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                        .build(),
                    true,
                )
            }
    }

}
