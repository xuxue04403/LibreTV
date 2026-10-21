package org.libretv.tv.ui

import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.focusable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import org.libretv.tv.AppViewModel
import org.libretv.tv.Screen
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

private const val SEEK_STEP_MS = 10_000L

/**
 * 播放页：ExoPlayer + 遥控器友好控件。
 *
 * 电视端不做可聚焦按钮条（遥控器在控件间移动很烦），而是把常用操作
 * 全部映射到方向键与 OK 键，屏幕上只显示状态与快捷键提示。
 */
@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(vm: AppViewModel, target: Screen.Player, onExit: () -> Unit) {
    val context = LocalContext.current
    var index by remember { mutableIntStateOf(target.startIndex.coerceIn(0, (target.episodes.size - 1).coerceAtLeast(0))) }
    val currentIndex by rememberUpdatedState(index)
    var playing by remember { mutableStateOf(true) }
    var position by remember { mutableLongStateOf(0L) }
    var duration by remember { mutableLongStateOf(0L) }
    var controlsVisible by remember { mutableStateOf(true) }
    var drawerVisible by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var rate by remember { mutableFloatStateOf(1f) }
    var resumedOnce by remember { mutableStateOf(false) }
    var buffering by remember { mutableStateOf(true) }

    val focusRequester = remember { FocusRequester() }
    val exo = remember {
        ExoPlayer.Builder(context).build().apply {
            playWhenReady = true
            setHandleAudioBecomingNoisy(true)
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            vm.saveProgress(target, currentIndex, exo.currentPosition.coerceAtLeast(0), exo.duration.coerceAtLeast(0))
            exo.release()
        }
    }

    // 切集 / 首次进入
    LaunchedEffect(index) {
        error = null
        buffering = true
        val url = target.episodes.getOrNull(index) ?: return@LaunchedEffect
        exo.setMediaItem(MediaItem.fromUri(url))
        exo.prepare()
        exo.playWhenReady = true
        if (!resumedOnce) {
            resumedOnce = true
            val hist = vm.data.value.history.firstOrNull { it.id == "${target.source.key}:${target.vodId}" }
            if (vm.data.value.settings.resumePlayback && hist != null && hist.episodeIndex == index && hist.positionMs > 15_000) {
                exo.seekTo(hist.positionMs)
                vm.showToast("已从 ${formatMs(hist.positionMs)} 继续播放")
            }
        }
    }

    DisposableEffect(exo) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                buffering = playbackState == Player.STATE_BUFFERING || playbackState == Player.STATE_IDLE
                if (playbackState == Player.STATE_ENDED) {
                    val next = currentIndex + 1
                    if (vm.data.value.settings.autoplayNext && next < target.episodes.size) {
                        index = next
                    } else {
                        vm.saveProgress(target, currentIndex, exo.duration.coerceAtLeast(0), exo.duration.coerceAtLeast(0))
                    }
                }
            }

            override fun onPlayerError(playerError: PlaybackException) {
                error = playerError.errorCodeName + "：" + (playerError.message ?: "播放失败").take(120)
                buffering = false
            }
        }
        exo.addListener(listener)
        onDispose { exo.removeListener(listener) }
    }

    // 进度与自动保存
    LaunchedEffect(Unit) {
        var tick = 0
        while (true) {
            position = exo.currentPosition.coerceAtLeast(0)
            val d = exo.duration
            duration = if (d > 0) d else 0
            tick++
            if (tick % 4 == 0 && position > 0) {
                vm.saveProgress(target, currentIndex, position, duration)
            }
            delay(1000)
        }
    }

    // 控件自动隐藏
    LaunchedEffect(controlsVisible, playing, drawerVisible) {
        if (controlsVisible && playing && !drawerVisible) {
            delay(3500)
            controlsVisible = false
        }
    }

    LaunchedEffect(Unit) { runCatching { focusRequester.requestFocus() } }

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(focusRequester)
            .focusable()
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (event.key) {
                    Key.DirectionCenter, Key.Enter, Key.Spacebar -> {
                        if (exo.isPlaying) exo.pause() else exo.play()
                        controlsVisible = true
                        true
                    }
                    Key.DirectionLeft -> {
                        exo.seekTo((exo.currentPosition - SEEK_STEP_MS).coerceAtLeast(0))
                        controlsVisible = true
                        true
                    }
                    Key.DirectionRight -> {
                        exo.seekTo(exo.currentPosition + SEEK_STEP_MS)
                        controlsVisible = true
                        true
                    }
                    Key.DirectionUp -> {
                        drawerVisible = true
                        controlsVisible = true
                        true
                    }
                    Key.DirectionDown -> {
                        drawerVisible = false
                        true
                    }
                    Key.MediaPlayPause, Key.MediaPlay, Key.MediaPause -> {
                        if (exo.isPlaying) exo.pause() else exo.play()
                        true
                    }
                    Key.MediaNext -> {
                        if (index + 1 < target.episodes.size) index += 1
                        true
                    }
                    Key.MediaPrevious -> {
                        if (index > 0) index -= 1
                        true
                    }
                    Key.Back -> {
                        vm.saveProgress(target, currentIndex, exo.currentPosition.coerceAtLeast(0), exo.duration.coerceAtLeast(0))
                        onExit()
                        true
                    }
                    else -> false
                }
            },
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    player = exo
                    setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                    keepScreenOn = true
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        if (buffering && error == null) {
            Row(
                Modifier.align(Alignment.Center),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .width(26.dp)
                        .height(26.dp)
                        .background(Accent.copy(alpha = 0.25f), androidx.compose.foundation.shape.CircleShape)
                )
                Spacer(Modifier.width(12.dp))
                Text("正在缓冲…", color = TextPrimary, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
            }
        }

        if (error != null) {
            Column(
                Modifier
                    .align(Alignment.Center)
                    .width(560.dp)
                    .background(Color(0xE612161D), androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("播放失败", color = TextPrimary, fontSize = MaterialTheme.typography.titleMedium.fontSize, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Text(error ?: "", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TvButton("重试", onClick = {
                        error = null
                        exo.prepare()
                        exo.play()
                    })
                    TvButton("下一集", onClick = {
                        if (index + 1 < target.episodes.size) index += 1
                    })
                    TvButton("返回", onClick = onExit)
                }
            }
        }

        AnimatedVisibility(visible = controlsVisible, modifier = Modifier.align(Alignment.TopStart)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color(0xD9000000), Color.Transparent)))
                    .padding(horizontal = 34.dp, vertical = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        target.title,
                        color = TextPrimary,
                        fontSize = MaterialTheme.typography.headlineMedium.fontSize,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "${target.sourceName} · 第 ${index + 1} 集 · 共 ${target.episodes.size} 集",
                        color = Color(0xFFB7C0CE),
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                    )
                }
                Spacer(Modifier.weight(1f))
                Text(
                    "OK 播放/暂停   ←→ 快退/快进 10s   ↑ 选集   返回 退出",
                    color = Color(0xFF9AA4B4),
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
            }
        }

        AnimatedVisibility(visible = controlsVisible, modifier = Modifier.align(Alignment.BottomStart)) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xE6000000))))
                    .padding(horizontal = 34.dp, vertical = 22.dp),
            ) {
                val progress = if (duration > 0) position.toFloat() / duration else 0f
                ProgressBar(progress, Modifier.fillMaxWidth())
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(formatMs(position), color = TextPrimary, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    Text(" / ${formatMs(duration)}", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    Spacer(Modifier.width(18.dp))
                    Text(if (playing) "播放中" else "已暂停", color = if (playing) Accent else TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    Spacer(Modifier.weight(1f))
                    Text("${rate}×", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                }
            }
        }

        AnimatedVisibility(visible = drawerVisible, modifier = Modifier.align(Alignment.BottomStart)) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(Color(0xF20E1117))
                    .padding(horizontal = 34.dp, vertical = 18.dp),
            ) {
                Text("选集（↑ 打开 / ↓ 收起）", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                Spacer(Modifier.height(10.dp))
                LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    itemsIndexed(target.episodes) { i, _ ->
                        EpisodeChip(
                            label = "第 ${i + 1} 集",
                            selected = i == index,
                            onClick = { index = i; drawerVisible = false },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun EpisodeChip(label: String, selected: Boolean, onClick: () -> Unit) {
    TvCard(
        onClick = onClick,
        containerColor = if (selected) org.libretv.tv.ui.theme.Panel2 else Color(0xFF1A202B),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(10.dp),
        focusedScale = 1.08f,
    ) { focused ->
        Text(
            label,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            color = if (selected || focused) Accent else TextPrimary,
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
        )
    }
}

internal fun formatMs(ms: Long): String {
    if (ms <= 0) return "00:00"
    val total = ms / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}
