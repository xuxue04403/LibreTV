package org.libretv.tv.ui

import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
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
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.libretv.tv.AppViewModel
import org.libretv.tv.Screen
import org.libretv.tv.data.Playback
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

private const val SEEK_STEP_MS = 10_000L
/** 连续缓冲超过这个时长就判定为卡死并换源（秒） */
private const val STALL_SECONDS = 15

/**
 * 播放页：ExoPlayer + 遥控器友好控件。
 *
 * 电视端不做可聚焦按钮条（遥控器在控件间移动很烦），而是把常用操作
 * 全部映射到方向键与 OK 键，屏幕上只显示状态与快捷键提示。
 *
 * 播放失败时按候选链自动换源：电视频道上「这个源挂了」很常见，
 * 让用户按返回、重新搜索、再点一次是很差的体验。
 */
@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(vm: AppViewModel, target: Screen.Player, onExit: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    /** 当前播放目标：换源后指向新源（不是入参 target） */
    var current by remember { mutableStateOf(target) }
    var index by remember {
        mutableIntStateOf(target.startIndex.coerceIn(0, (target.episodes.size - 1).coerceAtLeast(0)))
    }
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
    /** 换源过程中的提示（「正在切换到 XX…」） */
    var note by remember { mutableStateOf<String?>(null) }
    var failingOver by remember { mutableStateOf(false) }

    /** 已试过且失败的候选；换集时重置，让新一集仍可从当前源开始 */
    val tried = remember { mutableSetOf("${target.source.key}:${target.vodId}") }
    var discovered by remember { mutableStateOf(false) }

    val focusRequester = remember { FocusRequester() }
    val exo = remember { Playback.build(context) }

    DisposableEffect(Unit) {
        onDispose {
            vm.saveProgress(current, currentIndex, exo.currentPosition.coerceAtLeast(0), exo.duration.coerceAtLeast(0))
            exo.release()
        }
    }

    /** 失败转移：优先用候选链，全部失败后按片名反查补充 */
    val tryFailover: (String) -> Unit = { reason ->
        if (!failingOver) {
            failingOver = true
            note = "$reason，正在切换片源…"
            scope.launch {
                val result = vm.failoverPlayback(current, tried.toSet(), currentIndex, discovered)
                if (result == null) {
                    note = null
                    error = "$reason（已尝试全部片源）"
                    buffering = false
                } else {
                    tried += result.candidate.key
                    discovered = discovered || result.target.candidates.any { it.key !in target.candidates.map { c -> c.key } }
                    current = result.target
                    index = result.episodeIndex
                    error = null
                    note = "已切换到「${result.candidate.sourceName}」"
                    exo.setMediaItem(MediaItem.fromUri(result.target.episodes[result.episodeIndex]))
                    exo.prepare()
                    exo.playWhenReady = true
                    delay(2_400)
                    note = null
                }
                failingOver = false
            }
        }
    }

    // 切集 / 首次进入
    LaunchedEffect(current.source.key, current.vodId, index) {
        error = null
        buffering = true
        val url = current.episodes.getOrNull(index) ?: return@LaunchedEffect
        exo.setMediaItem(MediaItem.fromUri(url))
        exo.prepare()
        exo.playWhenReady = true
        if (!resumedOnce) {
            resumedOnce = true
            val hist = vm.data.value.history.firstOrNull { it.id == "${current.source.key}:${current.vodId}" }
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
                    val total = exo.duration.coerceAtLeast(0)
                    // 连播前把当前集记为「已看完」：位置 = 时长，但下次进入应从头播而不是跳到片尾
                    vm.saveProgress(current, currentIndex, total, total, finished = true)
                    if (vm.data.value.settings.autoplayNext && next < current.episodes.size) {
                        tried.clear()
                        tried += "${current.source.key}:${current.vodId}"
                        discovered = false
                        index = next
                    }
                }
            }

            override fun onPlayerError(playerError: PlaybackException) {
                buffering = false
                val message = playerError.errorCodeName + "：" + (playerError.message ?: "播放失败").take(120)
                error = message
                // 自动换源：这是本次改动的核心，用户不必手动返回重选
                tryFailover("播放失败")
            }
        }
        exo.addListener(listener)
        onDispose { exo.removeListener(listener) }
    }

    // 进度与自动保存 + 卡死看门狗
    LaunchedEffect(Unit) {
        var tick = 0
        var stalled = 0
        while (true) {
            position = exo.currentPosition.coerceAtLeast(0)
            val d = exo.duration
            duration = if (d > 0) d else 0
            tick++
            // 一直缓冲不动就是死了：ExoPlayer 自己不会超时，靠这里兜底换源
            stalled = if (buffering && !exo.isPlaying) stalled + 1 else 0
            if (stalled >= STALL_SECONDS && error == null && !failingOver) {
                stalled = 0
                tryFailover("加载超时")
            }
            if (tick % 4 == 0 && position > 0) {
                vm.saveProgress(current, currentIndex, position, duration)
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
                // 选集抽屉或错误面板可见时，把方向键/OK 让给里面的卡片，否则它们永远拿不到焦点
                if (drawerVisible || error != null || note != null) {
                    return@onPreviewKeyEvent when (event.key) {
                        Key.DirectionDown -> {
                            drawerVisible = false
                            true
                        }
                        else -> false
                    }
                }
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
                    Key.MediaPlayPause, Key.MediaPlay, Key.MediaPause -> {
                        if (exo.isPlaying) exo.pause() else exo.play()
                        true
                    }
                    Key.MediaNext -> {
                        if (index + 1 < current.episodes.size) index += 1
                        true
                    }
                    Key.MediaPrevious -> {
                        if (index > 0) index -= 1
                        true
                    }
                    // 菜单键：手动换源（自动换源失败后的兜底，也给想主动换线的用户）
                    Key.Menu -> {
                        tryFailover("手动切换")
                        true
                    }
                    // 返回键不在这里消费：交给 Activity 的 BackHandler 统一处理，
                    // 否则 KeyDown 消费 + KeyUp 不消费会让 BackHandler 再触发一次，一次退两级
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

        if (note != null) {
            Box(
                Modifier
                    .align(Alignment.Center)
                    .background(Color(0xCC0E1117), androidx.compose.foundation.shape.RoundedCornerShape(10.dp))
                    .padding(horizontal = 20.dp, vertical = 12.dp),
            ) {
                Text(note ?: "", color = Accent, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
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
                Spacer(Modifier.height(6.dp))
                Text(
                    "候选片源 ${current.candidates.size} 个 · 当前「${current.sourceName}」",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TvButton("换源重试", onClick = {
                        error = null
                        buffering = true
                        tryFailover("手动切换")
                    })
                    TvButton("重试", onClick = {
                        error = null
                        exo.prepare()
                        exo.play()
                    })
                    TvButton("下一集", onClick = {
                        if (index + 1 < current.episodes.size) index += 1
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
                        current.title,
                        color = TextPrimary,
                        fontSize = MaterialTheme.typography.headlineMedium.fontSize,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        "${current.sourceName} · 第 ${index + 1} 集 · 共 ${current.episodes.size} 集" +
                            if (current.candidates.size > 1) " · ${current.candidates.size} 个片源" else "",
                        color = Color(0xFFB7C0CE),
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                    )
                }
                Spacer(Modifier.weight(1f))
                Text(
                    "OK 播放/暂停   ←→ 快退/快进 10s   ↑ 选集   菜单 换源   返回 退出",
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
                    itemsIndexed(current.episodes) { i, _ ->
                        EpisodeChip(
                            label = "第 ${i + 1} 集",
                            selected = i == index,
                            onClick = {
                                index = i
                                drawerVisible = false
                                tried.clear()
                                tried += "${current.source.key}:${current.vodId}"
                                discovered = false
                            },
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
