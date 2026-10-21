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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import org.libretv.tv.AppViewModel
import org.libretv.tv.data.AppData
import org.libretv.tv.data.SearchGroup
import org.libretv.tv.data.SearchItem
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.OkGreen
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.WarnAmber

@Composable
fun SearchScreen(vm: AppViewModel, data: AppData) {
    val search = vm.search
    var input by remember { mutableStateOf(search.keyword) }
    val searchButtonFocus = remember { FocusRequester() }
    val suggestions = remember(data.history, search.keyword) {
        (search.keyword.takeIf { it.isNotBlank() }?.let { listOf(it) } ?: emptyList()) +
            data.history.map { it.title }.distinct().take(6)
    }

    LaunchedEffect(Unit) { runCatching { searchButtonFocus.requestFocus() } }

    Column(Modifier.fillMaxSize().padding(ScreenPadding)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.width(520.dp),
                singleLine = true,
                placeholder = { Text("输入片名、剧名或演员", color = TextMuted) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { vm.startSearch(input) }),
            )
            Spacer(Modifier.width(12.dp))
            TvButton("搜索", onClick = { vm.startSearch(input) }, primary = true, focusRequester = searchButtonFocus)
            Spacer(Modifier.width(16.dp))
            Text(
                if (search.loading) "搜索中… ${search.outcomes.size}/${data.activeSources().size} 个源"
                else if (search.searched) "${search.groups.size} 部影片"
                else "已启用 ${data.activeSources().size} 个源",
                color = TextMuted,
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
            )
        }

        if (suggestions.isNotEmpty() && !search.searched) {
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("试试：", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                suggestions.take(8).forEach { kw ->
                    Chip(kw) { input = kw; vm.startSearch(kw) }
                }
            }
        }

        if (search.outcomes.isNotEmpty()) {
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                search.outcomes.forEach { outcome ->
                    val text = if (outcome.ok) "${outcome.sourceName} · ${outcome.items.size} 条 · ${outcome.ms}ms"
                    else "${outcome.sourceName} · ${if (outcome.timedOut) "超时" else outcome.error ?: "失败"}"
                    Chip(text, active = outcome.ok)
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        when {
            data.activeSources().isEmpty() -> EmptyState(
                "还没有点播源",
                "请到设置里添加采集站地址，或使用「恢复默认源」导入内置源。",
                Modifier.padding(top = 30.dp),
            ) {
                TvButton("去设置", onClick = { vm.go(org.libretv.tv.Screen.Settings) })
            }

            !search.searched -> EmptyState(
                "搜索影片",
                "搜索会并行查询所有已启用的点播源，结果按片名聚合，同一部片来自多个源时可在详情里换源。",
                Modifier.padding(top = 30.dp),
            )

            search.groups.isEmpty() -> EmptyState(
                if (search.loading) "正在搜索…" else "没有找到相关内容",
                if (search.loading) "各源返回速度不同，结果会陆续出现。" else "换个关键词，或在设置里检查源是否可用。",
                Modifier.padding(top = 30.dp),
            )

            else -> LazyVerticalGrid(
                columns = GridCells.Adaptive(164.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(search.groups, key = { it.key }) { group ->
                    ResultCard(group) { vm.openDetail(group, group.items.first()) }
                }
            }
        }
    }
}

@Composable
private fun ResultCard(group: SearchGroup, onClick: () -> Unit) {
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
                            color = Accent,
                            fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        )
                    }
                }
            }
        }
    }
}
