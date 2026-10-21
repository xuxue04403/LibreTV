package org.libretv.tv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.libretv.tv.AppViewModel
import org.libretv.tv.Screen
import org.libretv.tv.data.AppData
import org.libretv.tv.data.CategoryKey
import org.libretv.tv.data.SearchGroup
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

@Composable
fun CategoryScreen(vm: AppViewModel, data: AppData) {
    val state = vm.category
    val firstFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { firstFocus.requestFocus() } }

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
                if (state.loading) "加载中…" else "${state.groups.size} 部",
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

        // 分类切换行（遥控器左右移动即可换分类）
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            CategoryKey.home.forEachIndexed { index, key ->
                TvCard(
                    onClick = { vm.selectCategory(key) },
                    containerColor = if (key == state.key) org.libretv.tv.ui.theme.Panel2 else org.libretv.tv.ui.theme.Panel,
                    shape = androidx.compose.foundation.shape.RoundedCornerShape(999.dp),
                    focusedScale = 1.06f,
                    focusRequester = if (index == 0) firstFocus else null,
                ) { focused ->
                    Text(
                        key.label,
                        modifier = Modifier.padding(horizontal = 18.dp, vertical = 10.dp),
                        color = when {
                            focused -> org.libretv.tv.ui.theme.Accent
                            key == state.key -> androidx.compose.ui.graphics.Color(0xFFFFC4B0)
                            else -> TextPrimary
                        },
                        fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                    )
                }
            }
        }

        Spacer(Modifier.height(18.dp))

        when {
            data.activeSources().isEmpty() -> EmptyState(
                "还没有点播源",
                "请到设置里添加采集站，或使用「恢复默认源」导入内置源。",
            ) {
                TvButton("去设置", onClick = { vm.go(Screen.Settings) })
            }

            state.loading -> androidx.compose.foundation.layout.Box(
                Modifier.fillMaxWidth().height(160.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("正在从各源拉取「${state.key.label}」…", color = TextMuted)
            }

            state.groups.isEmpty() -> EmptyState(
                "这个分类暂时没有内容",
                "各源对分类的命名不同，部分源可能没有「${state.key.label}」；也可以直接搜索片名。",
            ) {
                TvButton("去搜索", onClick = { vm.go(Screen.Search) })
            }

            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(164.dp),
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

@Composable
private fun CategoryCard(group: SearchGroup, onClick: () -> Unit) {
    val first = group.items.first()
    TvCard(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column {
            Poster(first.pic, group.name, Modifier.fillMaxWidth().height(238.dp))
            Column(Modifier.padding(10.dp)) {
                EllipsizedText(group.name, fontSize = MaterialTheme.typography.titleMedium.fontSize)
                Spacer(Modifier.height(4.dp))
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
                            color = org.libretv.tv.ui.theme.Accent,
                            fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        )
                    }
                }
            }
        }
    }
}
