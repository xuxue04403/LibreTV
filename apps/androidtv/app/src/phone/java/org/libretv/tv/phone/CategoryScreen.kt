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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.libretv.tv.AppViewModel
import org.libretv.tv.data.AppData
import org.libretv.tv.data.CategoryKey
import org.libretv.tv.ui.theme.Line
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

/**
 * 分类浏览页。
 *
 * 结构照电视版：顶部一排分类胶囊 + 下方结果网格。手机上把「焦点落下即预览」
 * 换成「点一下才加载」，避免滑一下列表就发一堆请求。
 */
@Composable
fun CategoryScreen(vm: AppViewModel, data: AppData) {
    val state = vm.category

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        PhoneTopBar(title = state.key.label, onBack = { vm.back() })

        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                when {
                    state.fromCache && state.groups.isNotEmpty() -> "${state.groups.size} 部（缓存）"
                    state.loading && state.groups.isEmpty() -> "加载中…"
                    else -> "${state.groups.size} 部"
                },
                color = TextPrimary,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f),
            )
            if (state.supportedSources > 0 || state.failedSources > 0) {
                Text(
                    "${state.supportedSources} 个源有此分类"
                        + if (state.failedSources > 0) " · ${state.failedSources} 个失败" else "",
                    color = TextMuted,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        LazyRow(
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(CategoryKey.home, key = { it.name }) { key ->
                PhoneChip(
                    text = key.label,
                    active = key == state.key,
                    onClick = if (key == state.key) null else ({ vm.selectCategory(key) }),
                )
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                state.loading && state.groups.isEmpty() -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            "正在从各源加载「${state.key.label}」…",
                            color = TextMuted,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }

                state.groups.isEmpty() -> {
                    Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.TopCenter) {
                        if (state.failedSources > 0 && state.supportedSources == 0) {
                            PhoneEmpty(
                                title = "所有源都没能返回内容",
                                description = buildString {
                                    append("${state.failedSources} 个源请求失败")
                                    if (state.failureReason.isNotBlank()) append("：${state.failureReason}")
                                    append("。稍后再试，或到设置里换几个源。")
                                },
                            ) {
                                PhoneButton("重试", onClick = { vm.selectCategory(state.key) }, primary = true)
                            }
                        } else {
                            PhoneEmpty(
                                title = "这个分类暂时没有内容",
                                description = "已启用的源里有 ${state.supportedSources} 个提供「${state.key.label}」，但此刻都没有内容。",
                            )
                        }
                    }
                }

                else -> {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(2),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(state.groups, key = { it.key }) { group ->
                            CategoryCell(group) { vm.openDetail(group, group.items.first()) }
                        }
                    }
                }
            }
        }
    }
}

/** 分类结果格：海报 + 片名 + 元信息 + 多源角标。 */
@Composable
private fun CategoryCell(group: org.libretv.tv.data.SearchGroup, onClick: () -> Unit) {
    val item = group.items.firstOrNull() ?: return
    Column(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        PhonePoster(item.pic, item.name, Modifier.fillMaxWidth().aspectRatio(2f / 3f))
        Text(
            item.name,
            color = TextPrimary,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            listOfNotNull(item.year, item.remarks).joinToString(" · ").ifBlank { item.sourceName },
            color = TextMuted,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** 加载骨架：一屏灰块，避免「点了没反应」的观感。 */
@Composable
fun PhoneSkeletonGrid(rows: Int = 6) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        repeat(rows / 2) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                repeat(2) {
                    Box(
                        Modifier
                            .weight(1f)
                            .aspectRatio(2f / 3f)
                            .clip(RoundedCornerShape(10.dp))
                            .background(Panel),
                    )
                }
            }
        }
    }
}

/** 空态里带一条细边框提示（详情页与分类页共用）。 */
@Composable
fun PhoneHintBox(text: String) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Panel)
            .padding(14.dp),
    ) {
        Text(text, color = TextMuted, style = MaterialTheme.typography.bodySmall)
    }
}

/** 1dp 竖直分隔线（分类页顶部状态行用）。 */
@Composable
fun PhoneVLine(modifier: Modifier = Modifier) {
    Box(modifier.background(Line))
}
