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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.libretv.tv.AppViewModel
import org.libretv.tv.data.AppData
import org.libretv.tv.ui.theme.Line
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

@Composable
fun SettingsScreen(vm: AppViewModel, data: AppData) {
    var vodName by remember { mutableStateOf("") }
    var vodUrl by remember { mutableStateOf("") }
    var vodDetail by remember { mutableStateOf("") }
    var liveName by remember { mutableStateOf("") }
    var liveUrl by remember { mutableStateOf("") }
    var liveEpg by remember { mutableStateOf("") }
    var subUrl by remember { mutableStateOf("") }

    Column(
        Modifier
            .fillMaxSize()
            .padding(ScreenPadding)
            .verticalScroll(rememberScrollState()),
    ) {
        Text("设置", color = TextPrimary, fontSize = MaterialTheme.typography.headlineLarge.fontSize, fontWeight = FontWeight.Bold)
        Text(
            "数据源、播放偏好与本地数据都在这里管理",
            color = TextMuted,
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
        )

        SectionHeader("添加点播源", "Apple CMS 采集接口")
        PanelBox {
            // 分两行排：内容区只有 764dp 宽（960 设计宽 - 104 导航 - 92 内边距），
            // 三个固定宽输入框挤在一行会把最后一个压成竖排单字
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = vodName,
                        onValueChange = { vodName = it },
                        label = { Text("名称（可选）") },
                        singleLine = true,
                        modifier = Modifier.width(220.dp),
                    )
                    OutlinedTextField(
                        value = vodUrl,
                        onValueChange = { vodUrl = it },
                        label = { Text("接口地址") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = vodDetail,
                        onValueChange = { vodDetail = it },
                        label = { Text("详情页根地址（可选）") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TvButton("添加", onClick = {
                        vm.addSource(vodName, vodUrl, vodDetail.ifBlank { null })
                        vodName = ""
                        vodUrl = ""
                        vodDetail = ""
                    }, primary = true)
                }
            }
        }

        SectionHeader("点播源", "${data.activeSources().size}/${data.sources.size} 已启用")
        data.sources.forEach { source ->
            SourceRow(
                name = source.name,
                subtitle = source.url + if (source.builtin) "  ·  内置" else "",
                enabled = source.key in data.selected,
                onToggle = { vm.toggleSource(source.key) },
                onDelete = { vm.removeSource(source.key) },
            )
        }
        if (data.sources.isEmpty()) {
            Text("还没有点播源，可在下方「订阅导入」里恢复默认源。", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }

        SectionHeader("添加直播源", "M3U / M3U8 播放列表")
        PanelBox {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = liveName,
                        onValueChange = { liveName = it },
                        label = { Text("名称（可选）") },
                        singleLine = true,
                        modifier = Modifier.width(220.dp),
                    )
                    OutlinedTextField(
                        value = liveUrl,
                        onValueChange = { liveUrl = it },
                        label = { Text("M3U 地址") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedTextField(
                        value = liveEpg,
                        onValueChange = { liveEpg = it },
                        label = { Text("EPG 地址（可选）") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    TvButton("添加", onClick = {
                        vm.addLiveSource(liveName, liveUrl, liveEpg.ifBlank { null })
                        liveName = ""
                        liveUrl = ""
                        liveEpg = ""
                    }, primary = true)
                }
            }
        }

        SectionHeader("直播源", "${data.activeLiveSources().size}/${data.liveSources.size} 已启用")
        data.liveSources.forEach { source ->
            SourceRow(
                name = source.name,
                subtitle = source.url + if (source.builtin) "  ·  内置" else "",
                enabled = source.key in data.liveSelected,
                onToggle = { vm.toggleLiveSource(source.key) },
                onDelete = { vm.removeLiveSource(source.key) },
            )
        }

        SectionHeader("订阅导入", "LibreTV-SourceList 或 TVBOX 配置")
        PanelBox {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = subUrl,
                    onValueChange = { subUrl = it },
                    label = { Text("订阅地址") },
                    singleLine = true,
                    modifier = Modifier.width(620.dp),
                )
                TvButton(
                    if (vm.importing) "导入中…" else "导入",
                    onClick = { vm.importSubscription(subUrl) },
                    primary = true,
                )
                TvButton("恢复默认源", onClick = { vm.restoreBuiltinSources() })
            }
        }

        SectionHeader("播放设置")
        PanelBox {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SettingToggle(
                    "成人内容过滤",
                    "过滤含敏感分类关键词的搜索结果",
                    data.settings.adultFilter,
                ) { vm.updateSettings { s -> s.copy(adultFilter = !s.adultFilter) } }
                SettingToggle(
                    "自动连播下一集",
                    "当前集播放结束后自动播放下一集",
                    data.settings.autoplayNext,
                ) { vm.updateSettings { s -> s.copy(autoplayNext = !s.autoplayNext) } }
                SettingToggle(
                    "记住播放进度",
                    "下次打开同一影片时从上次位置继续播放",
                    data.settings.resumePlayback,
                ) { vm.updateSettings { s -> s.copy(resumePlayback = !s.resumePlayback) } }
            }
        }

        SectionHeader("本地数据")
        PanelBox {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                TvButton("清空观看历史（${data.history.size} 条）", onClick = { vm.clearHistory() })
                Text(
                    "收藏 ${data.favorites.size} 部 · 直播收藏 ${data.liveFavorites.size} 个",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
            }
        }

        SectionHeader("关于")
        PanelBox {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                // 版本号从安装包读，不写死：写死过一次（v0.1.0 一直没跟着改）
                val context = LocalContext.current
                val versionName = remember(context) {
                    runCatching {
                        context.packageManager.getPackageInfo(context.packageName, 0).versionName
                    }.getOrNull().orEmpty().ifEmpty { "—" }
                }
                Text("LibreTV TV 版 v$versionName", color = TextPrimary, fontWeight = FontWeight.SemiBold)
                Text(
                    "基于 LibreTV（AGPL-3.0-or-later）的衍生客户端：采集聚合、解析与播放全部在电视本地完成，不需要部署服务器。",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Text(
                    "内置源均为第三方公开接口，与本项目无隶属关系，内容合法性由对应数据源负责；可在上方随时停用或删除。",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
                Text(
                    "投屏：本机作为 DLNA 接收端（DMR），手机视频 App 的「投屏」可直接选到「LibreTV 电视」。",
                    color = TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                )
            }
        }

        Spacer(Modifier.height(40.dp))
    }
}

@Composable
private fun PanelBox(content: @Composable () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Panel)
            .padding(18.dp)
    ) {
        content()
    }
}

@Composable
private fun SourceRow(
    name: String,
    subtitle: String,
    enabled: Boolean,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 10.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color0F)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(name, color = TextPrimary, fontSize = MaterialTheme.typography.bodyMedium.fontSize, fontWeight = FontWeight.Medium)
            Text(
                subtitle,
                color = TextMuted,
                fontSize = MaterialTheme.typography.bodySmall.fontSize,
                maxLines = 1,
            )
        }
        TvButton(if (enabled) "已启用" else "已停用", onClick = onToggle)
        Spacer(Modifier.width(10.dp))
        TvButton("删除", onClick = onDelete)
    }
}

@Composable
private fun SettingToggle(title: String, desc: String, checked: Boolean, onToggle: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = TextPrimary, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
            Text(desc, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }
        TvButton(if (checked) "已开启" else "已关闭", onClick = onToggle)
    }
}

private val Color0F = androidx.compose.ui.graphics.Color(0xFF10141B)
