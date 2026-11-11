package org.librextv.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.librextv.tv.AppViewModel
import org.librextv.tv.HomeRow
import org.librextv.tv.Screen
import org.librextv.tv.data.AppData
import org.librextv.tv.data.CategoryKey
import org.librextv.tv.data.FavoriteEntry
import org.librextv.tv.data.HistoryEntry
import org.librextv.tv.data.HistoryDedupe
import org.librextv.tv.data.LiveFavoriteEntry
import org.librextv.tv.data.SearchItem
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/** 首页「继续观看 / 收藏」卡宽：比内容页海报略小，一屏能多看几张。 */
private val HOME_CARD_WIDTH = 116.dp

/** 分类胶囊的宽度区间：按文字收缩，最多这么宽；再多就横向滚动 */
private val MIN_CATEGORY_CHIP_WIDTH = 84.dp
private val MAX_CATEGORY_CHIP_WIDTH = 176.dp

@Composable
fun HomeScreen(vm: AppViewModel, data: AppData) {
    val firstFocus = remember { FocusRequester() }
    // 首屏焦点落在第一个分类入口上（banner 去掉之后这里就是最上一层可操作项）。
    // 必须重试：组合第一次跑时目标节点还没挂载，requestFocus() 会抛
    // 「FocusRequester is not initialized」，被 runCatching 吞掉之后焦点就默认落到
    // 第一个可聚焦项（导航栏的「首页」），看起来像没有选中项。
    // 进入本页时的确认序号：只有「进入之后」用户在导航项上按了 OK，
    // 才说明是明确要进这一页，这时才抢焦点（见 FocusPolicy）。
    // 注意必须用页面自持的可变状态记录「已响应过的序号」，
    // 写成 `remember(tick) { tick }` 会让两边一起变、判定恒假。
    val autoFocus = rememberAutoFocusState(vm.contentFocusTick)
    LaunchedEffect(vm.contentFocusTick) {
        // 焦点还在导航栏里移动（导航支持「移上去就切页」）时不抢，
        // 否则焦点一进导航就被首页拽到内容区，← → 走不到下一个导航项。
        if (!autoFocus.consume(vm.navFocusHold, vm.contentFocusTick)) {
            return@LaunchedEffect
        }
        repeat(4) { attempt ->
            if (attempt > 0) kotlinx.coroutines.delay(80L)
            if (runCatching { firstFocus.requestFocus() }.isSuccess) {
                autoFocus.handledTick = vm.contentFocusTick
                return@LaunchedEffect
            }
        }
    }

    val rows = vm.homeRows

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(HomePadding),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        // 分类入口：一排胶囊，进屋就能选「电影 / 电视剧 / 少儿 / 综艺 …」
        // 只显示真的有内容的分类：点了进空页面比看不到入口更糟
        // 第一块紧贴顶栏：默认 26dp 的上边距会把首屏推下去一大截
        item { SectionHeader("分类浏览", "按源站分类直接打开", topPadding = 2.dp) }
        item { CategoryRow(vm, data, firstFocus) }

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
                                    org.librextv.tv.data.LiveChannel(
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

        // 数据源信息压成一行文字放在最后：它属于「设置」而不是内容，
        // 又不该整屏占一块视觉重心（新装用户 0 记录 0 收藏时整屏都是数字）。
        item {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 20.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "点播源 ${data.activeSources().size}/${data.sources.size} · " +
                        "直播源 ${data.activeLiveSources().size}/${data.liveSources.size} · " +
                        "记录 ${data.history.size} · 收藏 ${data.favorites.size + data.liveFavorites.size}",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Spacer(Modifier.weight(1f))
                TvCard(
                    onClick = { vm.go(Screen.Settings) },
                    shape = RoundedCornerShape(999.dp),
                    containerColor = Color.Transparent,
                    focusedScale = 1.04f,
                ) { focused ->
                    Text(
                        "数据源设置 ›",
                        color = if (focused) Accent else TextMuted,
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun CategoryRow(vm: AppViewModel, data: AppData, firstFocus: FocusRequester? = null) {
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

    // 单行不换行；胶囊按文字长短自己收缩，不摊满整行 —— 之前按「均分可用宽度」
    // 算，7 个分类时每个宽到 125dp、里面只有两个字，看着又宽又空。
    // 放不下（分类特别多）才横向滚动，遥控器 ← → 移过去。
    // 字号按设计宽度（960dp）等比例给：换到 720p / 4K 上整体缩放，不会一大一小。
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val gap = 8.dp
        val labelSize = (maxWidth.value / 62f).coerceIn(13f, 19f).sp
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(gap),
            contentPadding = PaddingValues(end = 6.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            itemsIndexed(keys, key = { _, key -> key.name }) { index, key ->
                TvCard(
                    onClick = { vm.selectCategory(key) },
                    modifier = Modifier.widthIn(
                        min = MIN_CATEGORY_CHIP_WIDTH,
                        max = MAX_CATEGORY_CHIP_WIDTH,
                    ),
                    containerColor = Panel,
                    shape = RoundedCornerShape(9.dp),
                    focusedScale = 1.06f,
                    focusRequester = if (index == 0) firstFocus else null,
                ) { focused ->
                    Row(
                        Modifier
                            .padding(horizontal = 14.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .background(
                                    if (focused) Accent else Color(0xFFFFB199),
                                    androidx.compose.foundation.shape.CircleShape,
                                )
                        )
                        Spacer(Modifier.width(7.dp))
                        Text(
                            key.label,
                            color = if (focused) Accent else TextPrimary,
                            fontSize = labelSize,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun HistoryCard(entry: HistoryEntry, onClick: () -> Unit) {
    // 记录里的下标可能越界（老版本「看完一集」会把下标推到列表长度），
    // 卡片是用户判断「从哪一集续播」的唯一依据，必须先夹紧再显示
    val shown = HistoryDedupe.clampEntry(entry)
    TvCard(onClick = onClick, modifier = Modifier.width(HOME_CARD_WIDTH)) {
        Column {
            Poster(shown.cover, shown.title, Modifier.fillMaxWidth().height(HOME_CARD_WIDTH * 1.45f))
            Column(Modifier.padding(10.dp)) {
                EllipsizedText(shown.title, fontSize = MaterialTheme.typography.titleMedium.fontSize)
                Spacer(Modifier.height(4.dp))
                Text(
                    if (shown.episodeCount > 0) {
                        "第 ${shown.episodeIndex + 1}/${shown.episodeCount} 集 · ${shown.sourceName}"
                    } else {
                        shown.sourceName
                    },
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                    maxLines = 1,
                )
                Spacer(Modifier.height(8.dp))
                val progress = if (shown.durationMs > 0) shown.positionMs.toFloat() / shown.durationMs else 0f
                ProgressBar(progress, Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun FavoriteCard(fav: FavoriteEntry, onClick: () -> Unit) {
    TvCard(onClick = onClick, modifier = Modifier.width(HOME_CARD_WIDTH)) {
        Column {
            Poster(fav.cover, fav.title, Modifier.fillMaxWidth().height(HOME_CARD_WIDTH * 1.45f))
            Column(Modifier.padding(10.dp)) {
                EllipsizedText(fav.title, fontSize = MaterialTheme.typography.titleMedium.fontSize)
                Text("收藏", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
        }
    }
}

@Composable
private fun LiveFavoriteCard(fav: LiveFavoriteEntry, onClick: () -> Unit) {
    TvCard(onClick = onClick, modifier = Modifier.width(176.dp), focusedScale = 1.04f) { focused ->
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
