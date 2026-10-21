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
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.libretv.tv.AppViewModel
import org.libretv.tv.Screen
import org.libretv.tv.data.AppData
import org.libretv.tv.data.CategoryKey
import org.libretv.tv.data.HistoryEntry
import org.libretv.tv.data.LiveFavoriteEntry
import org.libretv.tv.data.FavoriteEntry
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

@Composable
fun HomeScreen(vm: AppViewModel, data: AppData) {
    val firstFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { firstFocus.requestFocus() } }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        item { HomeHero(data, onSearch = { vm.go(Screen.Search) }, onSettings = { vm.go(Screen.Settings) }, onCast = { vm.go(Screen.Cast) }, firstFocus) }

        // 分类入口：首页顶部一排，进屋就能选「电影 / 电视剧 / 少儿 / 综艺 …」
        // 只显示真的有内容的分类：点了进空页面比看不到入口更糟
        item { SectionHeader("分类浏览", "按源站分类直接打开") }
        item { CategoryRow(vm) }

        if (data.history.isNotEmpty()) {
            item { SectionHeader("继续观看", "${data.history.size} 条记录") }
            item {
                LazyRow(
                    state = rememberLazyListState(),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    items(data.history.take(14), key = { it.id }) { entry ->
                        HistoryCard(entry) { vm.resumeFromHistory(entry) }
                    }
                }
            }
        }

        if (data.favorites.isNotEmpty()) {
            item { SectionHeader("我的收藏", "${data.favorites.size} 部") }
            item {
                LazyRow(
                    state = rememberLazyListState(),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    items(data.favorites.take(20), key = { it.id }) { fav ->
                        FavoriteCard(fav) { vm.playFavorite(fav.id) }
                    }
                }
            }
        }

        if (data.liveFavorites.isNotEmpty()) {
            item { SectionHeader("直播收藏", "${data.liveFavorites.size} 个频道") }
            item {
                LazyRow(
                    state = rememberLazyListState(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
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

        item { SectionHeader("数据源") }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                StatCard("点播源", "${data.activeSources().size}/${data.sources.size}", Modifier.width(190.dp))
                StatCard("直播源", "${data.activeLiveSources().size}/${data.liveSources.size}", Modifier.width(190.dp))
                StatCard("观看记录", "${data.history.size}", Modifier.width(190.dp))
                StatCard("收藏", "${data.favorites.size + data.liveFavorites.size}", Modifier.width(190.dp))
            }
        }
    }
}

@Composable
private fun CategoryRow(vm: AppViewModel) {
    // 进首页即探测各分类是否有内容；看到的是「已过滤后的入口」而不是全量
    LaunchedEffect(Unit) { vm.probeCategories() }

    val available = vm.availableCategories
    val keys = available ?: CategoryKey.home
    if (keys.isEmpty()) {
        Text(
            "所选源暂未返回任何分类内容，可直接搜索片名",
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
    Box(
        Modifier
            .fillMaxWidth()
            .height(232.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(
                Brush.horizontalGradient(
                    0f to Color(0xFF171C26),
                    1f to Color(0xFF0E1218),
                )
            )
            .padding(horizontal = 34.dp, vertical = 26.dp),
    ) {
        Box(
            Modifier
                .size(320.dp)
                .align(Alignment.CenterEnd)
                .background(
                    Brush.radialGradient(
                        listOf(Color(0x66FF6B3D), Color.Transparent)
                    )
                )
        )
        Column {
            Text(
                "LibreTV · 电视版",
                color = TextPrimary,
                fontSize = MaterialTheme.typography.headlineLarge.fontSize,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "搜索聚合、解析与播放全部在本机完成：无需服务器，手机投屏可直接接收。",
                color = TextMuted,
                fontSize = MaterialTheme.typography.bodyMedium.fontSize,
            )
            Spacer(Modifier.height(20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvButton("开始搜索", onSearch, primary = true, focusRequester = firstFocus)
                TvButton("数据源设置", onSettings)
                TvButton("投屏接收", onCast)
            }
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(22.dp)) {
                HeroStat("${data.activeSources().size}", "启用点播源")
                HeroStat("${data.activeLiveSources().size}", "启用直播源")
                HeroStat("${data.history.size}", "观看记录")
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
private fun StatCard(label: String, value: String, modifier: Modifier = Modifier) {
    Column(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(Panel)
            .padding(18.dp)
    ) {
        Text(value, color = Color(0xFFFFB59C), fontSize = MaterialTheme.typography.headlineMedium.fontSize, fontWeight = FontWeight.Bold)
        Text(label, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
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
