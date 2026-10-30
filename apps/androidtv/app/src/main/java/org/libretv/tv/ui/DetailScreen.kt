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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.libretv.tv.AppViewModel
import org.libretv.tv.Screen
import org.libretv.tv.data.AppData
import org.libretv.tv.data.HistoryDedupe
import org.libretv.tv.data.Parsers
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

@Composable
fun DetailScreen(vm: AppViewModel, target: Screen.Detail, data: AppData) {
    val state = vm.detail
    val item = target.item
    val vod = state?.detail
    val playFocus = remember { FocusRequester() }
    val favoriteId = "${item.sourceKey}:${item.vodId}"
    val favorite = data.favorites.any { it.id == favoriteId }
    // 观看记录按片名去重，换了采集源也能续播：先按 id 精确找，找不到再按片名兜底
    val rawResume = data.history.firstOrNull { it.id == favoriteId }
        ?: data.history.firstOrNull { Parsers.normalizeTitle(it.title) == Parsers.normalizeTitle(item.name) }
    // 续播下标必须按**当前这份分集列表**夹紧：历史可能是别的源写的，长度不一样。
    // 夹紧后按钮文案与点击行为才指向同一集，不会出现「写着第 15 集、播的是第 2 集」。
    val resumeIndex = rawResume?.let { entry ->
        if (vod?.episodes.isNullOrEmpty()) null else HistoryDedupe.clampEpisodeIndex(entry.episodeIndex, vod.episodes.size)
    }

    // 只在「首次进入这部片」抢焦点。原来 key 用 vodId：用户在同片源里换个源，
    // vodId 变了 effect 就重跑，焦点被从第 20 集硬拽回顶部的「播放」按钮，
    // 得重新按一路 ↓ 走回去。现在按「片名 + 源集合」判重，换源不再重抢。
    // 单次 requestFocus 在首帧可能落空（节点还没放置），所以重试几次。
    val focusKey = Parsers.normalizeTitle(item.name)
    val focusDoneFor = remember { mutableSetOf<String>() }
    LaunchedEffect(focusKey) {
        if (!focusDoneFor.add(focusKey)) return@LaunchedEffect
        repeat(4) { attempt ->
            if (attempt > 0) kotlinx.coroutines.delay(80L)
            if (runCatching { playFocus.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }

    // 整页用同一个 LazyVerticalGrid：头部（海报 + 简介 + 按钮）作为通栏 item 放在最前，
    // 分集卡片跟在后面。旧写法是 Column { 固定头部 + LazyVerticalGrid(fillMaxSize) }，
    // 头部先吃掉 310dp 左右高度，剩下的才给网格，而且整页**无法滚动**——
    // 手机竖屏式简介在电视上被 maxLines=3 截断、同片源卡片变多时会被挤出屏幕外，
    // 用遥控器根本够不到。
    LazyVerticalGrid(
        columns = GridCells.Adaptive(104.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxSize().padding(ScreenPadding),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(Modifier.fillMaxWidth()) {
                Row(Modifier.fillMaxWidth()) {
                    Poster(vod?.cover ?: item.pic, item.name, Modifier.width(208.dp).height(310.dp))
                    Spacer(Modifier.width(26.dp))
                    Column(Modifier.weight(1f)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Chip(item.sourceName, active = true)
                            item.typeName?.let { Chip(it) }
                            item.year?.let { Chip(it) }
                            item.area?.let { Chip(it) }
                        }
                        Spacer(Modifier.height(10.dp))
                        Text(
                            vod?.title ?: item.name,
                            color = TextPrimary,
                            fontSize = MaterialTheme.typography.headlineLarge.fontSize,
                            fontWeight = FontWeight.Bold,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            vod?.desc?.replace(Regex("<[^>]+>"), " ")?.trim()?.take(220) ?: "暂无简介",
                            color = TextMuted,
                            fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                            maxLines = 3,
                        )
                        vod?.actor?.let {
                            Spacer(Modifier.height(8.dp))
                            Text("主演：$it", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize, maxLines = 1)
                        }
                        Spacer(Modifier.height(18.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            TvButton(
                                text = if (resumeIndex != null) "继续播放 · 第 ${resumeIndex + 1} 集" else "立即播放",
                                onClick = { vm.playFromDetail(resumeIndex ?: 0) },
                                primary = true,
                                focusRequester = playFocus,
                            )
                            TvButton(
                                text = if (favorite) "已收藏" else "收藏",
                                onClick = { vm.toggleFavorite(item, vod?.title, vod?.cover) },
                            )
                            if (vod != null && vod.episodes.isNotEmpty()) {
                                Text("共 ${vod.episodes.size} 集", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                            }
                        }
                        Spacer(Modifier.height(16.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("同片源（${target.group.items.size}）：", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                            target.group.items.forEach { other ->
                                val selected = other.sourceKey == item.sourceKey && other.vodId == item.vodId
                                Chip(other.sourceName, active = selected) {
                                    if (!selected) vm.openDetail(target.group, other)
                                }
                            }
                        }
                    }
                }

                SectionHeader("选集", if (state?.loading == true) "加载中…" else "${vod?.episodes?.size ?: 0} 集")
            }
        }

        when {
            state?.error != null -> item(span = { GridItemSpan(maxLineSpan) }) {
                EmptyState("无法获取播放地址", state.error, Modifier.padding(top = 12.dp)) {
                    TvButton("返回换源", onClick = { vm.back() })
                }
            }

            state?.loading == true -> item(span = { GridItemSpan(maxLineSpan) }) {
                Box(
                    Modifier.fillMaxWidth().height(120.dp).padding(top = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("正在解析播放地址…", color = TextMuted)
                }
            }

            vod != null && vod.episodes.isEmpty() -> item(span = { GridItemSpan(maxLineSpan) }) {
                EmptyState("该源没有解析到可播放地址", "可以试试列表里的其他同片源。", Modifier.padding(top = 12.dp))
            }

            vod != null -> itemsIndexed(vod.episodes) { index, _ ->
                TvCard(
                    onClick = { vm.playFromDetail(index) },
                    containerColor = Panel,
                    shape = RoundedCornerShape(10.dp),
                    focusedScale = 1.08f,
                ) { focused ->
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(52.dp)
                            .clip(RoundedCornerShape(10.dp)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "第 ${index + 1} 集",
                            color = if (focused) Accent else TextPrimary,
                            fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                            fontWeight = if (focused) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    }
                }
            }
        }
    }
}
