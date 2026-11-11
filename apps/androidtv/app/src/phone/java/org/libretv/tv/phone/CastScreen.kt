package org.libretv.tv.phone

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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.libretv.tv.cast.CastRuntime
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.Line
import org.libretv.tv.ui.theme.OkGreen
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

/**
 * 手机版投屏接收页。
 *
 * 与电视版 `ui/CastScreen.kt` 展示同样的信息（是否就绪、局域网地址、最近一次投屏），
 * 只是把内容改成竖屏单列。真正把 DLNA 请求转成播放的是 [PhoneApp] 里的
 * `CastRuntime.pending` 监听 + [CastPlayerScreen]，本页只做说明与状态展示。
 */
@Composable
fun CastScreen() {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(PhonePadding),
    ) {
        Text(
            "投屏接收",
            color = TextPrimary,
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            "保持这个页面开着，同一 Wi-Fi 下的手机或电脑就能把视频投到这台设备播放。",
            color = TextMuted,
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(14.dp))

        // 状态卡
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF10141B))
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val running = CastRuntime.running
                Box(
                    Modifier
                        .width(9.dp)
                        .height(9.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(if (running) OkGreen else Color(0xFF4A5464)),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    if (running) "投屏接收已就绪" else "投屏接收未启动",
                    color = TextPrimary,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            if (CastRuntime.running) {
                Text(
                    "局域网地址：${CastRuntime.address ?: "未获取到"}",
                    color = TextMuted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            CastRuntime.error?.let {
                Text("启动失败：$it", color = Color(0xFFF2555A), style = MaterialTheme.typography.bodySmall)
            }
        }

        Spacer(Modifier.height(16.dp))
        PhoneSection("怎么投屏")
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF10141B))
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf(
                "1. 手机和本设备连同一个 Wi-Fi。",
                "2. 在手机的视频 App 里点「投屏 / TV」按钮。",
                "3. 选择列表里出现的这台 LibreTV 设备。",
                "4. 视频会直接在这台设备上播放，手机会变成遥控器。",
            ).forEach { line ->
                Text(line, color = TextMuted, style = MaterialTheme.typography.bodySmall)
            }
        }

        val lastTitle = CastRuntime.lastTitle
        val lastUrl = CastRuntime.lastUrl
        if (lastTitle != null || lastUrl != null) {
            Spacer(Modifier.height(16.dp))
            PhoneSection("最近一次投屏")
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color(0xFF10141B))
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    lastTitle ?: "未命名视频",
                    color = TextPrimary,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                )
                lastUrl?.let {
                    Text(it, color = TextMuted, style = MaterialTheme.typography.bodySmall, maxLines = 2)
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xFF0E1218))
                .padding(12.dp),
        ) {
            Text(
                "投屏接收基于 DLNA（SSDP + HTTP）。部分路由器开启了「AP 隔离」会导致" +
                    "设备之间互相看不见，遇到这种情况需要在路由器里关掉该选项。",
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
            )
        }

        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(3.dp).height(16.dp).clip(RoundedCornerShape(2.dp)).background(Accent))
            Spacer(Modifier.width(8.dp))
            Text("提示", color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(6.dp))
        Text(
            "如果投屏按钮里找不到这台设备，先确认两件事：App 是否在前台运行；" +
                "上面的状态是否显示「已就绪」。",
            color = TextMuted,
            style = MaterialTheme.typography.bodySmall,
        )

        Spacer(Modifier.height(24.dp))
        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
        Spacer(Modifier.height(12.dp))
        Text(
            "DLNA 接收与屏幕形态无关，手机版与电视版跑的是同一份 DlnaServer。",
            color = TextMuted,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
