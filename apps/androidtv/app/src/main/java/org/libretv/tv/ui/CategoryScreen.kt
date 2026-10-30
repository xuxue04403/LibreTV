package org.libretv.tv.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.libretv.tv.AppViewModel
import org.libretv.tv.Screen
import org.libretv.tv.data.AppData
import org.libretv.tv.data.CategoryKey
import org.libretv.tv.data.SearchGroup
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.Panel2
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

@Composable
fun CategoryScreen(vm: AppViewModel, data: AppData) {
    val state = vm.category
    val firstFocus = remember { FocusRequester() }
    // 首屏焦点落在当前分类的胶囊上：进去就能用左右键换分类，往下进网格。
    //
    // 只在「第一次进入本页」时抢焦点。焦点移上分类会直接触发切换（previewCategory），
    // 若每次 state.key 变化都抢一次，用户刚按 ↓ 进网格就会被拽回分类行。
    // 页面在导航离开时会被销毁、回来时重新组合，所以 remember 会在下次进入时归零，
    // 「从详情返回分类页」依然能恢复焦点。
    var focusRestored by remember { mutableStateOf(false) }
    LaunchedEffect(state.key) {
        if (!focusRestored) {
            runCatching { firstFocus.requestFocus() }
            focusRestored = true
        }
    }

    Column(Modifier.fillMaxSize().padding(ScreenPadding)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                state.key.label,
                color = TextPrimary,
                fontSize = MaterialTheme.typography.headlineLarge.fontSize,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.width(12.dp))
            Text(
                when {
                    state.fromCache && state.groups.isNotEmpty() -> "${state.groups.size} 部（缓存）"
                    state.loading && state.groups.isEmpty() -> "加载中…"
                    state.groups.isEmpty() -> ""
                    else -> "${state.groups.size} 部"
                },
                color = TextMuted,
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
            )
            Spacer(Modifier.weight(1f))
            Text(
                if (state.groups.isEmpty()) "" else "${state.supportedSources} 个源有此分类" +
                    if (state.failedSources > 0) {
                        " · ${state.failedSources} 个源失败" +
                            if (state.failureReason.isNotBlank()) "（${state.failureReason}）" else ""
                    } else "",
                color = TextMuted,
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
            )
        }

        Spacer(Modifier.height(12.dp))

        // 分类回到顶部横排：竖栏吃掉 196dp 的横向空间——电视上横向宽度比纵向更金贵，
        // 少一列海报比多滚一下更难受。横排用 LazyRow，分类多到放不下时可以横向滚，
        // 不会像固定 Row 那样把最后几个硬裁一半。
        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            items(CategoryKey.home, key = { it.name }) { key ->
                val selected = key == state.key
                TvCard(
                    onClick = { vm.selectCategory(key) },
                    // 焦点落到分类上就自动加载：遥控器一路左右划过去就能看内容，
                    // 不用每换一个分类再按一次 OK。
                    // 用 TvCard 自己的 onFocusChange，而不是外层 Modifier.onFocusChanged：
                    // 后者接在 focusRequester/clickable 之前，拿不到焦点事件。
                    onFocusChange = { focused -> if (focused) vm.previewCategory(key) },
                    containerColor = if (selected) Panel2 else Panel,
                    shape = RoundedCornerShape(12.dp),
                    focusedScale = 1.06f,
                    focusRequester = if (selected) firstFocus else null,
                ) { focused ->
                    Row(
                        Modifier.padding(horizontal = 15.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .size(7.dp)
                                .background(
                                    if (focused) Accent else Color(0xFFFFB199),
                                    CircleShape,
                                )
                        )
                        Spacer(Modifier.width(9.dp))
                        Text(
                            key.label,
                            color = when {
                                focused -> Accent
                                selected -> Color(0xFFFFC4B0)
                                else -> TextPrimary
                            },
                            fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                            maxLines = 1,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        when {
            data.activeSources().isEmpty() -> EmptyState(
                "还没有点播源",
                "请到设置里添加采集站，或使用「恢复默认源」导入内置源。",
            ) {
                TvButton("去设置", onClick = { vm.go(Screen.Settings) })
            }

            // 加载态换骨架：原来只有一行「正在从各源拉取…」文字，
            // 内容到位时整页跳变；骨架块能提前占好位，看起来是「在填」而不是「卡着」。
            state.loading && state.groups.isEmpty() -> PosterGridSkeleton()

            state.groups.isEmpty() -> EmptyState(
                // 「这个分类没有内容」和「所有源都没连上」是两件事，前者用户该换分类、
                // 后者该重试或检查网络；用同一句话会把人引到错误的方向。
                if (state.failedSources > 0 && state.supportedSources == 0) "所有源都没能返回内容" else "这个分类暂时没有内容",
                if (state.failedSources > 0 && state.supportedSources == 0) {
                    // 括号不能省：`a + if (c) b else "" + d` 里 else 分支实际是 `"" + d`，
                    // failureReason 非空时（正是最需要引导的时候）后半句会被整段吞掉。
                    "请求全部失败" +
                        (if (state.failureReason.isNotBlank()) "（${state.failureReason}）" else "") +
                        "，通常是网络不通或采集站限流。稍后可重新进入本页重试。"
                } else {
                    "各源对分类的命名不同，部分源可能没有「${state.key.label}」；也可以直接搜索片名。"
                },
            ) {
                TvButton("去搜索", onClick = { vm.go(Screen.Search) })
            }

            else -> LazyVerticalGrid(
                // 内容区拿回了竖栏占掉的那 196dp，列数可以从 4 列涨到 5 列
                columns = GridCells.Adaptive(176.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(state.groups, key = { it.key }) { group ->
                    CategoryCard(group) { vm.openDetail(group, group.items.first()) }
                }
            }
        }
    }
}

/** 骨架屏：呼吸式灰块，占位尺寸与真实卡片一致 */
@Composable
private fun PosterGridSkeleton() {
    val transition = rememberInfiniteTransition(label = "skeleton")
    val alpha by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 0.7f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "skeletonAlpha",
    )
    LazyVerticalGrid(
        columns = GridCells.Adaptive(176.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        items(12) {
            Column {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(246.dp)
                        .graphicsLayer { this.alpha = alpha }
                        .clip(RoundedCornerShape(12.dp))
                        .background(Panel2)
                )
                Spacer(Modifier.height(9.dp))
                Box(
                    Modifier
                        .fillMaxWidth(0.7f)
                        .height(13.dp)
                        .graphicsLayer { this.alpha = alpha }
                        .clip(RoundedCornerShape(4.dp))
                        .background(Panel2)
                )
            }
        }
    }
}

@Composable
private fun CategoryCard(group: SearchGroup, onClick: () -> Unit) {
    val first = group.items.first()
    TvCard(onClick = onClick, modifier = Modifier.fillMaxWidth(), focusedScale = 1.06f) { focused ->
        Column {
            Poster(first.pic, group.name, Modifier.fillMaxWidth().height(238.dp))
            Column(Modifier.padding(horizontal = 10.dp, vertical = 9.dp)) {
                EllipsizedText(
                    group.name,
                    fontSize = MaterialTheme.typography.titleMedium.fontSize,
                    color = if (focused) Accent else TextPrimary,
                )
                Spacer(Modifier.height(3.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        listOfNotNull(first.typeName, first.year).joinToString(" · "),
                        color = TextMuted,
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        maxLines = 1,
                    )
                    if (group.items.size > 1) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "${group.items.size} 源",
                            color = Accent,
                            fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        )
                    }
                }
            }
        }
    }
}
