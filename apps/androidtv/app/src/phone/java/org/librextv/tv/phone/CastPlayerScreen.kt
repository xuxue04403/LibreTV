package org.librextv.tv.phone

import android.os.Handler
import android.os.Looper
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import org.librextv.tv.Screen
import org.librextv.tv.cast.CastRuntime
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.TextPrimary

/**
 * 手机版投屏播放页：手机/电脑通过 DLNA 投过来的地址直接交给 ExoPlayer 播放。
 *
 * 逻辑与电视版 `ui/App.kt` 里的 CastPlayerScreen 完全一致——投屏控制面与屏幕形态无关：
 * - 用主线程 Handler 把 DLNA 线程发来的 play/pause/seek 转给 ExoPlayer（ExoPlayer 只能在主线程调用）；
 * - 每秒刷新 positionMs / durationMs / playbackState 供 GetTransportInfo / GetPositionInfo 读取；
 * - 判断「在播」用 playWhenReady 而不是 isPlaying，否则缓冲中手机会看到已暂停。
 *
 * 手机版多一层：进入播放页时切横屏、退出时切回竖屏，全屏观看体验才正常。
 */
@OptIn(UnstableApi::class)
@Composable
fun CastPlayerScreen(target: Screen.CastPlayer, onExit: () -> Unit) {
    val context = LocalContext.current
    // key 用投屏地址：第二次投屏必须重建播放器，否则 remember{} 会复用上一个实例继续播旧视频
    val exo = remember(target.url) {
        ExoPlayer.Builder(context).build().apply {
            playWhenReady = true
            setHandleAudioBecomingNoisy(true)
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .setUsage(C.USAGE_MEDIA)
                    .build(),
                true,
            )
        }
    }

    DisposableEffect(target.url) {
        exo.setMediaItem(MediaItem.fromUri(target.url))
        exo.prepare()
        onDispose { exo.release() }
    }

    // 把播放器交给 DLNA 控制面：DlnaServer 在自己的线程里回调，这里转回主线程
    val mainHandler = remember { Handler(Looper.getMainLooper()) }
    DisposableEffect(exo) {
        CastRuntime.transport = object : CastRuntime.CastTransport {
            override fun play() = mainHandler.post { runCatching { exo.play() } }.let {}
            override fun pause() = mainHandler.post { runCatching { exo.pause() } }.let {}
            override fun seekTo(positionMs: Long) =
                mainHandler.post { runCatching { exo.seekTo(positionMs) } }.let {}
        }
        onDispose { CastRuntime.clearTransport() }
    }

    // 每秒刷新一次状态，供手机的 GetPositionInfo / GetTransportInfo 读取
    LaunchedEffect(exo) {
        while (true) {
            CastRuntime.positionMs = runCatching { exo.currentPosition }.getOrDefault(0L)
            CastRuntime.durationMs = runCatching { exo.duration }.getOrDefault(0L)
            CastRuntime.playbackState = when {
                !exo.playWhenReady -> "PAUSED_PLAYBACK"
                exo.playbackState == Player.STATE_ENDED -> "STOPPED"
                else -> "PLAYING"
            }
            delay(1000)
        }
    }

    BackHandler { onExit() }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = true
                    player = exo
                    keepScreenOn = true
                }
            },
            // 投屏地址变化时 exo 会被重建，但 AndroidView 的 factory 只跑一次：
            // 不在这里同步 player，第二次投屏就只剩声音没有画面
            update = { it.player = exo },
            modifier = Modifier.fillMaxSize(),
        )
        Row(
            Modifier
                .align(Alignment.TopStart)
                .statusBarsPadding()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(Accent)
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            ) {
                Text("投屏", color = Color(0xFF1A0D07), style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.width(10.dp))
            Text(
                target.title.ifBlank { "正在播放手机投屏内容" },
                color = TextPrimary,
                style = MaterialTheme.typography.titleMedium,
            )
        }
    }
}
