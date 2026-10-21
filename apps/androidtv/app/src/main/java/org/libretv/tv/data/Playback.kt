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

    /** 起播最小缓冲：比默认 2.5s 略低，点开就出画面 */
    private const val MIN_BUFFER_MS = 1_500
    /** 起播后继续攒到这么多，弱网时不容易立刻卡 */
    private const val MAX_BUFFER_MS = 30_000
    /** 单次播放就预读这么多，超过就停（内存有限的盒子不能无限预读） */
    private const val BUFFER_FOR_PLAYBACK_MS = 1_500
    private const val BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS = 3_000
    /** 允许回退缓存：电视上拖回看过的片段不必重新拉 */
    private const val BACK_BUFFER_MS = 20_000

    fun build(context: Context): ExoPlayer {
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                MIN_BUFFER_MS,
                MAX_BUFFER_MS,
                BUFFER_FOR_PLAYBACK_MS,
                BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS,
            )
            .setBackBuffer(BACK_BUFFER_MS, true)
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()

        val dataSource = DefaultHttpDataSource.Factory()
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

        return ExoPlayer.Builder(context)
            .setLoadControl(loadControl)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
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
