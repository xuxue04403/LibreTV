package org.libretv.tv.ui

import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import org.libretv.tv.AppViewModel
import org.libretv.tv.Screen
import org.libretv.tv.cast.CastRuntime
import org.libretv.tv.ui.theme.Bg
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextPrimary

@Composable
fun LibretvApp(vm: AppViewModel) {
    val data by vm.data.collectAsStateWithLifecycle()
    val screen = vm.screen

    // 手机投屏过来：自动进入播放页
    LaunchedEffect(CastRuntime.pending) {
        CastRuntime.pending?.let { request ->
            vm.playCast(request.url, request.title)
            CastRuntime.pending = null
        }
    }

    BackHandler(enabled = screen !is Screen.Home) { vm.back() }

    Box(Modifier.fillMaxSize().background(Bg)) {
        when (screen) {
            is Screen.Player -> PlayerScreen(vm, screen, onExit = { vm.back() })
            is Screen.LivePlayer -> LivePlayerScreen(
                vm = vm,
                channel = screen.channel,
                playlist = screen.playlist,
                onExit = { vm.back() },
            )
            is Screen.CastPlayer -> CastPlayerScreen(screen, onExit = { vm.back() })
            else -> Row(Modifier.fillMaxSize()) {
                NavRail(screen, onSelect = { vm.go(it) })
                Box(Modifier.weight(1f).fillMaxSize()) {
                    when (screen) {
                        Screen.Home -> HomeScreen(vm, data)
                        Screen.Search -> SearchScreen(vm, data)
                        Screen.Live -> LiveScreen(vm, data)
                        Screen.Settings -> SettingsScreen(vm, data)
                        Screen.Cast -> CastScreen()
                        is Screen.Category -> CategoryScreen(vm, data)
                        is Screen.Detail -> DetailScreen(vm, screen, data)
                        else -> Unit
                    }
                }
            }
        }

        ToastHost(vm)
    }
}

@Composable
private fun ToastHost(vm: AppViewModel) {
    val message = vm.toast
    LaunchedEffect(message) {
        if (message != null) {
            delay(3200)
            vm.consumeToast()
        }
    }
    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = message != null,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 36.dp),
        ) {
            Box(
                Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(Panel)
                    .padding(horizontal = 22.dp, vertical = 14.dp)
            ) {
                Text(
                    message ?: "",
                    color = TextPrimary,
                    fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                )
            }
        }
    }
}

/** 手机投屏过来的地址：直接交给 ExoPlayer，不再做解析 */
@OptIn(UnstableApi::class)
@Composable
private fun CastPlayerScreen(target: Screen.CastPlayer, onExit: () -> Unit) {
    val context = LocalContext.current
    // key 用投屏地址：第二次投屏必须重建播放器，否则 remember{} 会复用上一个实例继续播旧视频
    val exo = remember(target.url) {
        ExoPlayer.Builder(context).build().apply {
            playWhenReady = true
            setHandleAudioBecomingNoisy(true)
            setAudioAttributes(
                androidx.media3.common.AudioAttributes.Builder()
                    .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MOVIE)
                    .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                    .build(),
                true,
            )
        }
    }
    androidx.compose.runtime.DisposableEffect(target.url) {
        exo.setMediaItem(MediaItem.fromUri(target.url))
        exo.prepare()
        onDispose { exo.release() }
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
                .padding(28.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(org.libretv.tv.ui.theme.Accent)
                    .padding(horizontal = 8.dp, vertical = 3.dp)
            ) {
                Text("投屏", color = Color(0xFF1A0D07), fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
            Spacer(Modifier.width(10.dp))
            Text(
                target.title.ifBlank { "正在播放手机投屏内容" },
                color = TextPrimary,
                fontSize = MaterialTheme.typography.titleMedium.fontSize,
            )
        }
    }
}
