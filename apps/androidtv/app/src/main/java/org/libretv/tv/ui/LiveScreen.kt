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
import org.libretv.tv.data.Playback
import org.libretv.tv.data.channelAt
import org.libretv.tv.data.indexOfChannel
import org.libretv.tv.data.stepChannelIndex
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.OkGreen
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

/**
 * 换台后多久没出画面就判定「这个台不通」。
 *
 * iptv 列表里死链很常见（返回 HTML 错误页、被地区限制），ExoPlayer 遇到这类
 * 情况既不报错也不进 READY，界面会永远停在「正在连接直播流…」，用户只能靠
 * 盲按换台。设个死线，到点就给结论。
 */
private const val LIVE_START_TIMEOUT_MS = 20_000L

@Composable
fun LiveScreen(vm: AppViewModel, data: AppData) {
    val live = vm.live
    LaunchedEffect(Unit) {
        if (!live.loading && live.channels.isEmpty()) vm.loadLive()
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

    // 分组计数一次遍历算好：原来是每个分组各 count 一遍（近万频道 × 上百分组 = 每次重组上百万次比较）
    val counts = remember(live.channels, live.groups) {
        val map = HashMap<String, Int>()
        live.channels.forEach { ch ->
            val g = ch.group ?: "未分组"
            map[g] = (map[g] ?: 0) + 1
        }
        map
    }

    Row(Modifier.fillMaxSize().padding(ScreenPadding)) {
        Column(Modifier.width(226.dp)) {
            SectionHeader("分组", if (live.groups.isEmpty()) "" else "${live.groups.size - 1} 个")
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxSize()) {
                items(live.groups) { group ->
                    val count = if (group == "全部") live.channels.size else counts[group] ?: 0
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
                    when {
                        live.channels.isNotEmpty() && live.loading -> "已加载 ${live.channels.size} 个频道，仍在读取…"
                        live.loading -> if (live.downloadedBytes > 0) {
                            "正在读取直播源 ${live.downloadedBytes / 1024} KB…"
                        } else {
                            "连接直播源…"
                        }
                        live.fromCache -> "${channels.size} / ${live.channels.size} 个频道（缓存）"
                        else -> "${channels.size} / ${live.channels.size} 个频道"
                    },
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Spacer(Modifier.weight(1f))
                TvButton("重新加载", onClick = { vm.loadLive(force = true) })
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
                            // 把当前可见列表一并带进播放页：遥控器上下键就在这个列表里循环换台，
                            // 而不是全量频道（用户已选分组/搜过关键词，换到列表外的频道会莫名其妙）
                            onPlay = { vm.go(Screen.LivePlayer(channel, channels)) },
                            onToggleFavorite = { vm.toggleLiveFavorite(channel) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun GroupRow(label: String, count: Int, active: Boolean, onClick: () -> Unit) {    TvCard(
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

/**
 * 直播播放页：方向键上下换台，OK 暂停/继续。
 *
 * 换台在 `playlist`（进播放页时的可见频道列表）里循环，与桌面端的 ↑/↓ 行为一致。
 * playlist 为空（例如从首页直播收藏直接进来）时上下键不响应——那里没有列表语境。
 */
@OptIn(UnstableApi::class)
@Composable
fun LivePlayerScreen(
    vm: AppViewModel,
    channel: LiveChannel,
    playlist: List<LiveChannel>,
    onExit: () -> Unit,
) {
    val context = LocalContext.current
    var current by remember(channel.url) { mutableStateOf(channel) }
    var error by remember { mutableStateOf<String?>(null) }
    var buffering by remember { mutableStateOf(true) }
    var overlay by remember { mutableStateOf(true) }
    var switching by remember { mutableStateOf(false) }
    val focusRequester = remember { FocusRequester() }

    val index = indexOfChannel(playlist, current.url)
    val total = playlist.size

    // 播放器与频道 URL 绑定：切台时必须重建，否则会复用已 release 的实例
    val exo = remember(current.url) {
        Playback.build(context).apply { playWhenReady = true }
    }

    DisposableEffect(current.url) {
        error = null
        buffering = true
        exo.setMediaItem(MediaItem.fromUri(current.url))
        exo.prepare()
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                buffering = playbackState == Player.STATE_BUFFERING || playbackState == Player.STATE_IDLE
                if (playbackState == Player.STATE_READY) {
                    switching = false
                    // 已经在放了，之前那条错误就是过期信息（直播流常见「某个分片
                    // 404 报错后自己恢复」），不清掉会让错误面板一直盖着正常画面。
                    error = null
                }
            }

            override fun onPlayerError(playerError: PlaybackException) {
                error = (playerError.message ?: "直播流加载失败").take(120)
                buffering = false
                switching = false
            }
        }
        exo.addListener(listener)
        onDispose {
            exo.removeListener(listener)
            exo.release()
        }
    }

    // 看门狗：有的台返回的是 HTML 错误页，ExoPlayer 既不报错也不出画面，
    // 界面会永远停在「正在连接直播流…」。超时就直接给结论并允许换台。
    LaunchedEffect(current.url) {
        kotlinx.coroutines.delay(LIVE_START_TIMEOUT_MS)
        if (exo.playbackState != Player.STATE_READY && error == null) {
            buffering = false
            switching = false
            error = "这个频道 ${LIVE_START_TIMEOUT_MS / 1000} 秒内没有出画面，可能已下线或被地区限制"
        }
    }

    LaunchedEffect(Unit) { runCatching { focusRequester.requestFocus() } }

    // 换台闸门兜底：某些流迟迟不到 READY 也不报错，不设死线会让上下键永久失灵
    LaunchedEffect(current.url) {
        if (switching) {
            kotlinx.coroutines.delay(8_000)
            switching = false
        }
    }

    // 信息条 4 秒后自动隐藏：常驻会一直压住画面上沿
    LaunchedEffect(overlay, current.url) {
        if (overlay) {
            kotlinx.coroutines.delay(4_000)
            overlay = false
        }
    }

    // 换台：在可见列表里循环，动画期间忽略重复按键避免连跳
    val switchTo: (Int) -> Unit = { dir ->
        if (!switching && playlist.size > 1) {
            val next = channelAt(playlist, stepChannelIndex(playlist.size, index, if (dir > 0) 1 else -1))
            if (next != null && next.url != current.url) {
                switching = true
                current = next
                overlay = true
            }
        }
    }

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
                    // 上下键换台，左右键做上一台/下一台（遥控器上左右更顺手）
                    Key.DirectionUp, Key.DirectionLeft, Key.ChannelUp -> {
                        switchTo(-1); true
                    }
                    Key.DirectionDown, Key.DirectionRight, Key.ChannelDown -> {
                        switchTo(1); true
                    }
                    Key.MediaNext -> {
                        switchTo(1); true
                    }
                    Key.MediaPrevious -> {
                        switchTo(-1); true
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
            update = { it.player = exo },
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
                    if (playlist.size > 1) {
                        TvButton("下一个频道", onClick = { switchTo(1) })
                    }
                    TvButton("返回", onClick = onExit)
                }
            }
        }

        // 顶部信息条：按键后出现，4 秒无操作淡出，避免长时间遮挡画面
        if (overlay) {
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
                Text(current.name, color = TextPrimary, fontSize = MaterialTheme.typography.titleLarge.fontSize, fontWeight = FontWeight.Bold)
                Text(current.group ?: "未分组", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
            Spacer(Modifier.weight(1f))
            if (total > 1) {
                Text(
                    "${index + 1} / $total",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Spacer(Modifier.width(16.dp))
            }
            Text(
                if (total > 1) "↑↓ 换台 · OK 暂停/继续 · 返回 退出" else "OK 暂停/继续 · 返回 退出",
                color = Color(0xFF9AA4B4),
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
            )
        }
        }
    }
}
