package org.libretv.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.Image
import androidx.compose.foundation.focusable
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.libretv.tv.Screen
import org.libretv.tv.cast.CastRuntime
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.Bg
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

private data class NavItem(val screen: Screen, val label: String, val icon: ImageVector)

private val items = listOf(
    NavItem(Screen.Home, "首页", Icons.Filled.Home),
    NavItem(Screen.Search, "搜索", Icons.Filled.Search),
    NavItem(Screen.Live, "直播", Icons.Filled.PlayArrow),
    NavItem(Screen.Settings, "设置", Icons.Filled.Settings),
)

@Composable
fun NavRail(
    current: Screen,
    onSelect: (Screen) -> Unit,
    onFocusEnter: () -> Unit = {},
    onFocusLeave: () -> Unit = {},
    onConfirm: () -> Unit = {},
) {
    // 导航收窄到 84dp：104dp 常显时占掉 960dp 设计宽的 11%，
    // 而电视上没人需要一直看到文字标签——聚焦时再显示就够了。
    Column(
        Modifier
            .width(84.dp)
            .fillMaxHeight()
            .background(Brush.verticalGradient(listOf(Color(0xFF10141C), Bg)))
            .padding(vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Image(
            painter = painterResource(id = org.libretv.tv.R.drawable.logo),
            contentDescription = "LibreTV",
            modifier = Modifier
                .size(42.dp)
                .clip(RoundedCornerShape(12.dp)),
        )
        Spacer(Modifier.height(14.dp))

        items.forEach { item ->
            val active = current::class == item.screen::class
            TvCard(
                onClick = {
                    onSelect(item.screen)
                    // 显式确认进入：解除导航焦点保持，让页面自己抢首焦点。
                    // 不加这一句的话「焦点移上去就切页」会让 navFocusHold 恒为 true，
                    // 每个页面的首焦点 LaunchedEffect 都被早退掉，永远不会执行。
                    onConfirm()
                },
                // 焦点移到导航项就切过去，不用再按 OK：电视上「先选中再确认」
                // 是鼠标时代遗留的操作方式，遥控器连着按过去才是自然的手感。
                // 只对「按页切换」的项生效；Home 之外的状态（播放页等）不会出现在导航里。
                onFocusChange = { focused ->
                    if (focused) {
                        onFocusEnter()
                        if (!active) onSelect(item.screen)
                    } else {
                        onFocusLeave()
                    }
                },
                modifier = Modifier.size(64.dp),
                containerColor = if (active) Color(0xFF22140F) else Color(0x00000000),
                shape = RoundedCornerShape(14.dp),
                focusedScale = 1.07f,
            ) { focused ->
                Column(
                    Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Icon(
                        imageVector = item.icon,
                        contentDescription = item.label,
                        tint = if (active || focused) Accent else TextMuted,
                        modifier = Modifier.size(24.dp),
                    )
                    // 标签只在「当前页」和「聚焦中」出现，其余时候纯图标
                    if (active || focused) {
                        Spacer(Modifier.height(3.dp))
                        Text(
                            item.label,
                            color = if (active || focused) Accent else TextMuted,
                            fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.weight(1f))

        if (CastRuntime.running) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(Color(0xFF4ECB8F)))
                Spacer(Modifier.width(6.dp))
                Text("投屏就绪", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
            Spacer(Modifier.height(8.dp))
        }
        Text(
            "LIBRETV\nTV",
            color = Color(0xFF3A4352),
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
            fontWeight = FontWeight.Bold,
            lineHeight = MaterialTheme.typography.bodySmall.fontSize * 1.2f,
        )
    }
}

@Composable
fun CastScreen() {
    // 整页原来只有 Text/Panel，没有任何可聚焦元素：从导航进来后焦点仍留在导航项上，
    // 按 ↓ 直接跳到下一个导航项，用户根本「停不住」在投屏页看地址。
    // 这里让页面容器本身可聚焦并请求焦点——不伪造一个「点了什么也不做」的按钮。
    val pageFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        repeat(4) { attempt ->
            if (attempt > 0) kotlinx.coroutines.delay(80L)
            if (runCatching { pageFocus.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(ScreenPadding)
            .focusRequester(pageFocus)
            .focusable()
    ) {
        Text("投屏接收", color = TextPrimary, fontSize = MaterialTheme.typography.headlineLarge.fontSize, fontWeight = FontWeight.Bold)
        Text(
            "电视作为 DLNA 接收端运行，手机与电视连同一个 Wi-Fi 即可投屏。",
            color = TextMuted,
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
        )

        SectionHeader("状态")
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(Panel)
                .padding(20.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(if (CastRuntime.running) Color(0xFF4ECB8F) else Color(0xFFF2555A))
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (CastRuntime.running) "接收端已启动" else "接收端未启动",
                        color = TextPrimary,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                if (CastRuntime.running) {
                    Text("设备描述地址：${CastRuntime.address}", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                    Text("设备名称：LibreTV 电视", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
                }
                CastRuntime.error?.let {
                    Text("启动失败：$it", color = Color(0xFFF2555A), fontSize = MaterialTheme.typography.bodySmall.fontSize)
                }
            }
        }

        SectionHeader("怎么投屏")
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(Panel)
                .padding(20.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("1. 手机与电视连到同一个 Wi-Fi（电视建议用有线或 5GHz）。", color = TextMuted, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
                Text("2. 在手机视频 App 的播放页点击「TV / 投屏」按钮。", color = TextMuted, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
                Text("3. 设备列表里选择「LibreTV 电视」，视频会自动在电视上播放。", color = TextMuted, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
                Text("提示：部分 App 只推送自家的加密流，若长时间转圈请改用其他 App 或直接在本机搜索播放。", color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
            }
        }

        SectionHeader("最近一次投屏")
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(Panel)
                .padding(20.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(CastRuntime.lastTitle?.takeIf { it.isNotBlank() } ?: "还没有收到投屏请求", color = TextPrimary, fontSize = MaterialTheme.typography.bodyMedium.fontSize)
                CastRuntime.lastUrl?.let {
                    Text(it, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize, maxLines = 2)
                }
            }
        }
    }
}
