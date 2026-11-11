package org.libretv.tv.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.libretv.tv.AppViewModel
import org.libretv.tv.Screen
import org.libretv.tv.cast.CastRuntime
import org.libretv.tv.data.AppData
import org.libretv.tv.data.CategoryKey
import org.libretv.tv.data.HistoryEntry
import org.libretv.tv.data.LiveChannel
import org.libretv.tv.ui.theme.OkGreen
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

/** 首页海报卡宽度：竖屏一行露出 3 个多，暗示可以横滑。 */
private val HomeCardWidth = 104.dp

/**
 * 首页：分类入口 + 继续观看 + 各分类推荐排 + 收藏。
 *
 * 结构照电视版 `HomeScreen`，但去掉全部焦点逻辑、缩小卡片尺寸，
 * 并把电视上「焦点落到分类就自动预览」改成手机上「点一下才进」。
 */
@Composable
fun HomeScreen(vm: AppViewModel, data: AppData) {
    // 启用源或成人过滤变化后重新预热分类，否则推荐排会一直空着
    val signature = remember(data.selected, data.settings.adultFilter) {
        data.selected.sorted().joinToString("|") + "#" + data.settings.adultFilter
    }
    LaunchedEffect(signature) { vm.probeCategories() }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 16.dp),
    ) {
        item("header") { HomeHeader(data) }

        item("categories") {
            Column {
                PhoneSection("分类浏览", "按源站分类直接打开")
                CategoryRow(vm)
            }
        }

        if (data.history.isNotEmpty()) {
            item("history-title") { PhoneSection("继续观看", "${data.history.size} 条记录") }
            item("history") {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(data.history.take(14), key = { it.id }) { entry ->
                        HistoryCard(entry) { vm.resumeFromHistory(entry) }
                    }
                }
            }
        }

        items(vm.homeRows, key = { "row-${it.key.name}" }) { row ->
            Column {
                PhoneSection(
                    title = row.key.label,
                    hint = "${row.items.size} 部",
                    onMore = { vm.selectCategory(row.key) },
                )
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(row.items, key = { "${it.sourceKey}:${it.vodId}" }) { item ->
                        PosterCell(
                            title = item.name,
                            poster = item.pic,
                            subtitle = listOfNotNull(item.year, item.remarks)
                                .joinToString(" · ")
                                .ifBlank { row.key.label },
                        ) { vm.openDetailForItem(item) }
                    }
                }
            }
        }

        if (data.favorites.isNotEmpty()) {
            item("fav-title") { PhoneSection("我的收藏", "${data.favorites.size} 部") }
            item("fav") {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(data.favorites, key = { it.id }) { fav ->
                        PosterCell(fav.title, fav.cover, fav.year) { vm.playFavorite(fav.id) }
                    }
                }
            }
        }

        if (data.liveFavorites.isNotEmpty()) {
            item("livefav-title") { PhoneSection("直播收藏", "${data.liveFavorites.size} 个频道") }
            item("livefav") {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(data.liveFavorites, key = { it.url }) { fav ->
                        PhoneChip(
                            fav.name,
                            onClick = {
                                // 从收藏直接进直播播放页：playlist 传空，表示「只播这一个」
                                vm.go(
                                    Screen.LivePlayer(
                                        LiveChannel(
                                            id = fav.url,
                                            name = fav.name,
                                            url = fav.url,
                                            logo = fav.logo,
                                            sourceKey = "",
                                            sourceName = "直播收藏",
                                        ),
                                    ),
                                )
                            },
                        )
                    }
                }
            }
        }

        item("footer") { HomeFooter(data, vm) }
    }
}

@Composable
private fun HomeHeader(data: AppData) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "LibreTV",
                color = TextPrimary,
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
            )
            Text(
                "点播 ${data.activeSources().size}/${data.sources.size} · "
                    + "直播 ${data.activeLiveSources().size}/${data.liveSources.size}",
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        // 投屏状态胶囊：手机版把 DLNA 入口放这里，不占底部 Tab 位
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(Panel)
                .clickable { /* 占位：投屏入口在底部 footer */ }
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(7.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(if (CastRuntime.running) OkGreen else Color(0xFF4A5464)),
            )
            Box(Modifier.width(6.dp))
            Text(
                if (CastRuntime.running) "投屏就绪" else "投屏关闭",
                color = if (CastRuntime.running) TextPrimary else TextMuted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/** 分类入口：横向可滑的胶囊，点一下进分类页；源站没有的分类点上去给提示。 */
@Composable
private fun CategoryRow(vm: AppViewModel) {
    val available = vm.availableCategories
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(CategoryKey.home, key = { it.name }) { key ->
            val exists = available == null || key in available
            PhoneChip(
                text = key.label,
                onClick = {
                    if (exists) {
                        vm.selectCategory(key)
                    } else {
                        vm.showToast("${key.label}：已启用的源都没有这个分类")
                    }
                },
            )
        }
    }
}

/** 竖版海报卡：图 + 片名 + 副标题。 */
@Composable
private fun PosterCell(title: String, poster: String?, subtitle: String?, onClick: () -> Unit) {
    Column(
        modifier = Modifier.width(HomeCardWidth).clickable(onClick = onClick),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        PhonePoster(
            url = poster,
            title = title,
            modifier = Modifier.fillMaxWidth().aspectRatio(2f / 3f),
        )
        Text(
            title,
            color = TextPrimary,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (!subtitle.isNullOrBlank()) {
            Text(
                subtitle,
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** 继续观看卡：横版缩略图 + 底部进度条 + 「看到第几集」。 */
@Composable
private fun HistoryCard(entry: HistoryEntry, onClick: () -> Unit) {
    val progress = if (entry.durationMs > 0) {
        (entry.positionMs.toFloat() / entry.durationMs).coerceIn(0f, 1f)
    } else {
        0f
    }
    Column(
        modifier = Modifier.width(152.dp).clickable(onClick = onClick),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(86.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xFF10141B)),
        ) {
            PhonePoster(entry.cover, entry.title, Modifier.fillMaxSize())
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Brush.verticalGradient(0.6f to Color.Transparent, 1f to Color(0xCC05070A))),
            )
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                PhoneProgress(progress)
            }
        }
        Text(
            entry.title,
            color = TextPrimary,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            "第 ${entry.episodeIndex + 1}/${entry.episodeCount} 集 · ${entry.sourceName}",
            color = TextMuted,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 首页底部：投屏与源管理入口 + 一句免责说明。 */
@Composable
private fun HomeFooter(data: AppData, vm: AppViewModel) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PhoneButton("投屏接收", onClick = { vm.go(Screen.Cast) })
            PhoneButton("源管理", onClick = { vm.go(Screen.Settings) })
        }
        Text(
            "记录 ${data.history.size} 条 · 收藏 ${data.favorites.size} 部 · "
                + "直播收藏 ${data.liveFavorites.size} 个。内置源均为第三方公开接口，与本项目无隶属关系。",
            color = Color(0xFF5C6678),
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
