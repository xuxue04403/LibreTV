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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
    LaunchedEffect(Unit) { runCatching { firstFocus.requestFocus() } }

    Row(Modifier.fillMaxSize().padding(ScreenPadding)) {
        // 分类改成左侧竖栏：原来顶部横排胶囊只能摆下七八个，加了分类就溢出被硬裁，
        // 而且横排占用首屏高度。竖栏既放得下全部，也让「当前在哪个分类」一眼可见。
        Column(
            Modifier
                .width(196.dp)
                .fillMaxHeight()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CategoryKey.home.forEachIndexed { index, key ->
                TvCard(
                    onClick = { vm.selectCategory(key) },
                    // 焦点落到分类上就自动加载：遥控器一路上下划过去就能看内容，
                    // 不用每换一个分类再按一次 OK。
                    // 用 TvCard 自己的 onFocusChange，而不是外层 Modifier.onFocusChanged：
                    // 后者接在 focusRequester/clickable 之前，拿不到焦点事件。
                    onFocusChange = { focused -> if (focused) vm.previewCategory(key) },
                    containerColor = if (key == state.key) Panel2 else Panel,
                    shape = RoundedCornerShape(12.dp),
                    focusedScale = 1.04f,
                    focusRequester = if (index == 0) firstFocus else null,
                ) { focused ->
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier
                                .width(3.dp)
                                .height(16.dp)
                                .background(
                                    if (key == state.key || focused) Accent else Color(0x33FFFFFF),
                                    RoundedCornerShape(2.dp),
                                )
                        )
                        Spacer(Modifier.width(10.dp))
                        Text(
                            key.label,
                            color = when {
                                focused -> Accent
                                key == state.key -> Color(0xFFFFC4B0)
                                else -> TextPrimary
                            },
                            fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                            maxLines = 1,
                        )
                        if (key == state.key && state.fromCache) {
                            Spacer(Modifier.width(6.dp))
                            Text("缓存", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                        }
                    }
                }
            }
        }

        Spacer(Modifier.width(24.dp))

        Column(Modifier.weight(1f).fillMaxHeight()) {
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
                        state.loading -> "加载中…"
                        state.groups.isEmpty() -> ""
                        else -> "${state.groups.size} 部"
                    },
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    if (state.groups.isEmpty()) "" else "${state.supportedSources} 个源有此分类" +
                        if (state.failedSources > 0) " · ${state.failedSources} 个源失败" else "",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
            }

            Spacer(Modifier.height(14.dp))

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
                    "这个分类暂时没有内容",
                    "各源对分类的命名不同，部分源可能没有「${state.key.label}」；也可以直接搜索片名。",
                ) {
                    TvButton("去搜索", onClick = { vm.go(Screen.Search) })
                }

                else -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(180.dp),
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
        columns = GridCells.Adaptive(180.dp),
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
