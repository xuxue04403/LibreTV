package org.libretv.tv.ui

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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.libretv.tv.AppViewModel
import org.libretv.tv.HomeRow
import org.libretv.tv.Screen
import org.libretv.tv.data.AppData
import org.libretv.tv.data.CategoryKey
import org.libretv.tv.data.FavoriteEntry
import org.libretv.tv.data.HistoryEntry
import org.libretv.tv.data.LiveFavoriteEntry
import org.libretv.tv.data.SearchItem
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

@Composable
fun HomeScreen(vm: AppViewModel, data: AppData) {
    val firstFocus = remember { FocusRequester() }
    // 首屏焦点落在「开始搜索」上。必须重试：组合第一次跑时目标节点还没挂载，
    // requestFocus() 会抛「FocusRequester is not initialized」，被 runCatching 吞掉之后
    // 焦点就默认落到第一个可聚焦项（左侧导航栏的「首页」），看起来像没有选中项。
    LaunchedEffect(Unit) {
        // 焦点还在左侧导航里移动（导航支持「移上去就切页」）时不抢，
        // 否则焦点一进导航就被首页拽到「开始搜索」，↓ 走不到「搜索」。
        if (vm.navFocusHold) return@LaunchedEffect
        repeat(4) { attempt ->
            if (attempt > 0) kotlinx.coroutines.delay(80L)
            if (runCatching { firstFocus.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }

    val rows = vm.homeRows

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        item {
            HomeHero(
                data,
                onSearch = { vm.go(Screen.Search) },
                onSettings = { vm.go(Screen.Settings) },
                onCast = { vm.go(Screen.Cast) },
                firstFocus,
            )
        }

        // 分类入口：一排胶囊，进屋就能选「电影 / 电视剧 / 少儿 / 综艺 …」
        // 只显示真的有内容的分类：点了进空页面比看不到入口更糟
        item { SectionHeader("分类浏览", "按源站分类直接打开") }
        item { CategoryRow(vm, data) }

        // 继续观看：有记录才出现，放在内容流最上面（用户回来大概率是为了接着看）
        if (data.history.isNotEmpty()) {
            item {
                SectionHeader(
                    "继续观看",
                    hint = "${data.history.size} 条记录",
                    onMore = null,
                )
            }
            item {
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(data.history.take(14), key = { it.id }) { entry ->
                        HistoryCard(entry) { vm.resumeFromHistory(entry) }
                    }
                }
            }
        }

        // 内容流：每个可用分类一排真实海报。数据来自本地目录缓存，
        // 所以进首页不需要等网络；缓存没到位时这几排先不渲染，不会留空框。
        items(rows, key = { it.key.name }) { row ->
            Column {
                SectionHeader(
                    row.key.label,
                    hint = "${row.items.size} 部",
                    onMore = { vm.selectCategory(row.key) },
                )
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(row.items, key = { "${it.sourceKey}:${it.vodId}" }) { item ->
                        PosterCard(
                            title = item.name,
                            poster = item.pic,
                            subtitle = listOfNotNull(item.year?.takeIf { it.isNotBlank() }, item.remarks?.takeIf { it.isNotBlank() })
                                .joinToString(" · ")
                                .ifBlank { row.key.label },
                        ) { vm.openDetailForItem(item) }
                    }
                }
            }
        }

        if (data.favorites.isNotEmpty()) {
            item { SectionHeader("我的收藏", "${data.favorites.size} 部") }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    items(data.favorites.take(20), key = { it.id }) { fav ->
                        FavoriteCard(fav) { vm.playFavorite(fav.id) }
                    }
                }
            }
        }

        if (data.liveFavorites.isNotEmpty()) {
            item { SectionHeader("直播收藏", "${data.liveFavorites.size} 个频道") }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    items(data.liveFavorites, key = { it.url }) { fav ->
                        LiveFavoriteCard(fav) {
                            vm.go(
                                Screen.LivePlayer(
                                    org.libretv.tv.data.LiveChannel(
                                        id = fav.url,
                                        name = fav.name,
                                        url = fav.url,
                                        logo = fav.logo,
                                    )
                                )
                            )
                        }
                    }
                }
            }
        }

        // 数据源入口挪到最后：它是「设置」，不是内容。
        // 原来四张统计卡摆在首屏主视觉上，新装用户 0 记录 0 收藏时整屏都是数字。
        item { SectionHeader("数据源") }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                StatCard(
                    "点播源",
                    "${data.activeSources().size}/${data.sources.size}",
                    Modifier.width(190.dp),
                ) { vm.go(Screen.Settings) }
                StatCard(
                    "直播源",
                    "${data.activeLiveSources().size}/${data.liveSources.size}",
                    Modifier.width(190.dp),
                ) { vm.go(Screen.Settings) }
                StatCard("观看记录", "${data.history.size}", Modifier.width(190.dp)) { vm.go(Screen.Search) }
                StatCard("收藏", "${data.favorites.size + data.liveFavorites.size}", Modifier.width(190.dp))
            }
        }
    }
}

@Composable
private fun CategoryRow(vm: AppViewModel, data: AppData) {
    // 进首页即探测各分类是否有内容；看到的是「已过滤后的入口」而不是全量。
    //
    // 关键：这里必须按「当前启用的源」重新触发，不能用 LaunchedEffect(Unit)。
    // ViewModel 的 data 是异步 collect 的，首帧组合时 activeSources() 还是空的；
    // Unit 只在首次组合跑一次，等源到位后不会重跑，首页就永远停在
    // 「暂未返回任何分类内容」。改 key 后源一到就重新探测。
    val signature = remember(data.sources, data.selected, data.settings.adultFilter) {
        data.activeSources().map { it.key }.sorted().joinToString(",") +
            "|" + data.settings.adultFilter
    }
    LaunchedEffect(signature) { vm.probeCategories() }

    val available = vm.availableCategories
    val keys = available ?: CategoryKey.home
    if (keys.isEmpty()) {
        // 探测还没出结果时不要急着说「没有」——那时源可能还没加载完
        Text(
            if (available == null) "正在识别可用分类…" else "所选源暂未返回任何分类内容，可直接搜索片名",
            color = TextMuted,
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
            modifier = Modifier.padding(vertical = 6.dp),
        )
        return
    }

    LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        items(keys) { key ->
            TvCard(
                onClick = { vm.selectCategory(key) },
                modifier = Modifier.width(128.dp),
                containerColor = Panel,
                shape = RoundedCornerShape(12.dp),
                focusedScale = 1.06f,
            ) { focused ->
                Row(
                    Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        Modifier
                            .size(7.dp)
                            .background(
                                if (focused) Accent else Color(0xFFFFB199),
                                androidx.compose.foundation.shape.CircleShape,
                            )
                    )
                    Spacer(Modifier.width(9.dp))
                    Text(
                        key.label,
                        color = if (focused) Accent else TextPrimary,
                        fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun HomeHero(
    data: AppData,
    onSearch: () -> Unit,
    onSettings: () -> Unit,
    onCast: () -> Unit,
    firstFocus: FocusRequester,
) {
    // 横幅高度从 232dp 收到 152dp：原来是标题 / 说明 / 按钮 / 统计四行竖排，
    // 在 540dp 的设计高度里吃掉 43%，下面「分类浏览」要滚一屏才看得到。
    // 改成左右两栏——左边只说清这是什么，右边全是可操作项，一行就够。
    Box(
        Modifier
            .fillMaxWidth()
            .height(152.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(
                Brush.horizontalGradient(
                    0f to Color(0xFF171C26),
                    1f to Color(0xFF0E1218),
                )
            )
            .padding(horizontal = 28.dp),
    ) {
        Box(
            Modifier
                .size(280.dp)
                .align(Alignment.CenterEnd)
                .background(
                    Brush.radialGradient(
                        listOf(Color(0x55FF6B3D), Color.Transparent)
                    )
                )
        )
        Row(
            Modifier.fillMaxSize(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    "LibreTV · 电视版",
                    color = TextPrimary,
                    fontSize = MaterialTheme.typography.headlineMedium.fontSize,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    "搜索聚合、解析与播放全部在本机完成",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                    maxLines = 2,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TvButton("开始搜索", onSearch, primary = true, focusRequester = firstFocus)
                    TvButton("数据源设置", onSettings)
                    TvButton("投屏接收", onCast)
                }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    HeroStat("${data.activeSources().size}", "点播源")
                    HeroStat("${data.activeLiveSources().size}", "直播源")
                    HeroStat("${data.history.size}", "记录")
                }
            }
        }
    }
}

@Composable
private fun HeroStat(value: String, label: String) {
    Row(verticalAlignment = Alignment.Bottom) {
        Text(value, color = Color(0xFFFFB59C), fontSize = MaterialTheme.typography.headlineMedium.fontSize, fontWeight = FontWeight.Bold)
        Spacer(Modifier.width(6.dp))
        Text(label, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize, modifier = Modifier.padding(bottom = 4.dp))
    }
}

@Composable
private fun StatCard(label: String, value: String, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    if (onClick == null) {
        Column(
            modifier
                .clip(RoundedCornerShape(14.dp))
                .background(Panel)
                .padding(18.dp)
        ) {
            Text(value, color = Color(0xFFFFB59C), fontSize = MaterialTheme.typography.headlineMedium.fontSize, fontWeight = FontWeight.Bold)
            Text(label, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }
    } else {
        TvCard(onClick = onClick, modifier = modifier, containerColor = Panel) {
            Column(Modifier.padding(18.dp)) {
                Text(value, color = Color(0xFFFFB59C), fontSize = MaterialTheme.typography.headlineMedium.fontSize, fontWeight = FontWeight.Bold)
                Text(label, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
        }
    }
}

@Composable
private fun HistoryCard(entry: HistoryEntry, onClick: () -> Unit) {
    TvCard(onClick = onClick, modifier = Modifier.width(158.dp)) {
        Column {
            Poster(entry.cover, entry.title, Modifier.fillMaxWidth().height(228.dp))
            Column(Modifier.padding(10.dp)) {
                EllipsizedText(entry.title, fontSize = MaterialTheme.typography.titleMedium.fontSize)
                Spacer(Modifier.height(4.dp))
                Text(
                    "第 ${entry.episodeIndex + 1}/${entry.episodeCount} 集 · ${entry.sourceName}",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                    maxLines = 1,
                )
                Spacer(Modifier.height(8.dp))
                val progress = if (entry.durationMs > 0) entry.positionMs.toFloat() / entry.durationMs else 0f
                ProgressBar(progress, Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun FavoriteCard(fav: FavoriteEntry, onClick: () -> Unit) {
    TvCard(onClick = onClick, modifier = Modifier.width(158.dp)) {
        Column {
            Poster(fav.cover, fav.title, Modifier.fillMaxWidth().height(228.dp))
            Column(Modifier.padding(10.dp)) {
                EllipsizedText(fav.title, fontSize = MaterialTheme.typography.titleMedium.fontSize)
                Text("收藏", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
        }
    }
}

@Composable
private fun LiveFavoriteCard(fav: LiveFavoriteEntry, onClick: () -> Unit) {
    TvCard(onClick = onClick, modifier = Modifier.width(200.dp), focusedScale = 1.04f) { focused ->
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(46.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color(0xFF0C0F14)),
                contentAlignment = Alignment.Center,
            ) {
                Text("TV", color = if (focused) Accent else TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
            Spacer(Modifier.width(10.dp))
            Column {
                EllipsizedText(fav.name, fontSize = MaterialTheme.typography.titleMedium.fontSize)
                Text("直播收藏", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
        }
    }
}
