package org.libretv.tv.ui

import androidx.annotation.OptIn
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import androidx.compose.ui.layout.ContentScale
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
import coil.compose.AsyncImage
import coil.request.ImageRequest
import org.libretv.tv.AppViewModel
import org.libretv.tv.Screen
import org.libretv.tv.data.AppData
import org.libretv.tv.data.LiveChannel
import org.libretv.tv.data.Net
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.OkGreen
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

@Composable
fun LiveScreen(vm: AppViewModel, data: AppData) {
    val live = vm.live
    LaunchedEffect(Unit) {
        if (live.channels.isEmpty() && !live.loading) vm.loadLive()
    }

    val channels = remember(live.channels, live.selectedGroup, live.keyword) {
        live.channels.filter { ch ->
            val groupOk = live.selectedGroup == "全部" || (ch.group ?: "未分组") == live.selectedGroup
            val keywordOk = live.keyword.isBlank() ||
                ch.name.contains(live.keyword, ignoreCase = true) ||
                (ch.group ?: "").contains(live.keyword, ignoreCase = true)
            groupOk && keywordOk
        }
    }

    Row(Modifier.fillMaxSize().padding(ScreenPadding)) {
        Column(Modifier.width(226.dp)) {
            SectionHeader("分组", if (live.groups.isEmpty()) "" else "${live.groups.size - 1} 个")
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxSize()) {
                items(live.groups) { group ->
                    val count = if (group == "全部") live.channels.size else live.channels.count { (it.group ?: "未分组") == group }
                    GroupRow(group, count, group == live.selectedGroup) { vm.setLiveGroup(group) }
                }
            }
        }

        Spacer(Modifier.width(20.dp))

        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "直播频道",
                    color = TextPrimary,
                    fontSize = MaterialTheme.typography.headlineMedium.fontSize,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    if (live.loading) "解析直播源中…" else "${channels.size} / ${live.channels.size} 个频道",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Spacer(Modifier.weight(1f))
                TvButton("重新加载", onClick = { vm.loadLive() })
            }

            if (live.statuses.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    live.statuses.forEach { (name, status) ->
                        Chip("$name · $status", active = status.endsWith("频道"))
                    }
                }
            }

            Spacer(Modifier.height(14.dp))

            if (live.channels.isEmpty() && !live.loading) {
                EmptyState(
                    "没有可用的直播频道",
                    "请在设置里添加 M3U 直播源，或点击「恢复默认源」导入 iptv-org 公开频道列表。",
                ) {
                    TvButton("去设置", onClick = { vm.go(Screen.Settings) })
                }
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(238.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(channels, key = { "${it.sourceKey}:${it.url}" }) { channel ->
                        ChannelRow(
                            channel = channel,
                            favorite = data.liveFavorites.any { it.url == channel.url },
                            onPlay = { vm.go(Screen.LivePlayer(channel)) },
                            onToggleFavorite = { vm.toggleLiveFavorite(channel) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun GroupRow(label: String, count: Int, active: Boolean, onClick: () -> Unit) {
    TvCard(
        onClick = onClick,
        containerColor = if (active) org.libretv.tv.ui.theme.Panel2 else Panel,
        shape = RoundedCornerShape(10.dp),
        focusedScale = 1.03f,
    ) { focused ->
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                color = when {
                    focused -> Accent
                    active -> Color(0xFFFFC4B0)
                    else -> TextPrimary
                },
                fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            Text("$count", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }
    }
}

@Composable
private fun ChannelRow(
    channel: LiveChannel,
    favorite: Boolean,
    onPlay: () -> Unit,
    onToggleFavorite: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        TvCard(onClick = onPlay, modifier = Modifier.weight(1f), focusedScale = 1.03f) { focused ->
            Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(44.dp).background(Color(0xFF0C0F14), RoundedCornerShape(9.dp)),
                    contentAlignment = Alignment.Center,
                ) {
                    if (!channel.logo.isNullOrBlank()) {
                        AsyncImage(
                            model = ImageRequest.Builder(LocalContext.current)
                                .data(channel.logo)
                                .addHeader("User-Agent", Net.UA)
                                .build(),
                            contentDescription = null,
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.size(40.dp).padding(4.dp),
                        )
                    } else {
                        Text("TV", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    }
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        channel.name,
                        color = if (focused) Accent else TextPrimary,
                        fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                        maxLines = 1,
                    )
                    Text(
                        channel.group ?: "未分组",
                        color = TextMuted,
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        maxLines = 1,
                    )
                }
            }
        }
        Spacer(Modifier.width(8.dp))
        TvCard(
            onClick = onToggleFavorite,
            modifier = Modifier.size(46.dp),
            containerColor = Panel,
            focusedScale = 1.06f,
        ) { focused ->
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    if (favorite) "★" else "☆",
                    color = if (favorite || focused) Accent else TextMuted,
                    fontSize = MaterialTheme.typography.titleMedium.fontSize,
                )
            }
        }
    }
}

/** 直播播放页：无进度条，方向键只做音量/退出，避免误触 */
@OptIn(UnstableApi::class)
@Composable
fun LivePlayerScreen(vm: AppViewModel, channel: LiveChannel, onExit: () -> Unit) {
    val context = LocalContext.current
    var error by remember { mutableStateOf<String?>(null) }
    var buffering by remember { mutableStateOf(true) }
    var overlay by remember { mutableStateOf(true) }
    val focusRequester = remember { FocusRequester() }

    // 播放器与频道 URL 绑定：切台时必须重建，否则会复用已 release 的实例
    val exo = remember(channel.url) {
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

    DisposableEffect(channel.url) {
        exo.setMediaItem(MediaItem.fromUri(channel.url))
        exo.prepare()
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                buffering = playbackState == Player.STATE_BUFFERING || playbackState == Player.STATE_IDLE
            }

            override fun onPlayerError(playerError: PlaybackException) {
                error = (playerError.message ?: "直播流加载失败").take(120)
                buffering = false
            }
        }
        exo.addListener(listener)
        onDispose {
            exo.removeListener(listener)
            exo.release()
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
                    Key.DirectionCenter, Key.Enter -> {
                        if (exo.isPlaying) exo.pause() else exo.play()
                        overlay = true
                        true
                    }
                    // 返回键交给 Activity 的 BackHandler，避免 KeyDown 消费 + KeyUp 不消费
                    // 导致 BackHandler 再触发一次、一次退两级
                    else -> {
                        overlay = true
                        false
                    }
                }
            },
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    player = exo
                    keepScreenOn = true
                }
            },
            modifier = Modifier.fillMaxSize(),
        )

        if (buffering && error == null) {
            Text("正在连接直播流…", color = TextPrimary, modifier = Modifier.align(Alignment.Center))
        }
        if (error != null) {
            Column(Modifier.align(Alignment.Center).width(520.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("直播播放失败", color = TextPrimary, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text(error ?: "", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TvButton("重试", onClick = { error = null; exo.prepare() })
                    TvButton("返回", onClick = onExit)
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color(0xCC000000), Color.Transparent)))
                .padding(horizontal = 34.dp, vertical = 22.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.background(Accent, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp)
            ) {
                Text("LIVE", color = Color(0xFF1A0D07), fontSize = MaterialTheme.typography.bodySmall.fontSize, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(10.dp))
            Column {
                Text(channel.name, color = TextPrimary, fontSize = MaterialTheme.typography.titleLarge.fontSize, fontWeight = FontWeight.Bold)
                Text(channel.group ?: "未分组", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
            Spacer(Modifier.weight(1f))
            Text("OK 暂停/继续 · 返回 退出", color = Color(0xFF9AA4B4), fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }
    }
}
