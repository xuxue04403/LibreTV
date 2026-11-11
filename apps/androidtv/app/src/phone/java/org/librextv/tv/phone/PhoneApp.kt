package org.librextv.tv.phone

import android.app.Activity
import android.content.pm.ActivityInfo
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import org.librextv.tv.AppViewModel
import org.librextv.tv.Screen
import org.librextv.tv.cast.CastRuntime
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.Bg
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/**
 * 手机版根界面。
 *
 * 与电视版 `org.librextv.tv.ui.LibreXtvApp` 用同一个 [AppViewModel]，差别只在导航形态：
 * 电视是顶部横排 NavRail + 遥控器焦点，手机是底部四个 Tab，播放页与详情页整屏覆盖。
 */
@Composable
fun PhoneApp(vm: AppViewModel) {
    val data by vm.data.collectAsStateWithLifecycle()
    val screen = vm.screen

    // 同一局域网里的设备通过 DLNA 投过来时，直接进播放页
    LaunchedEffect(CastRuntime.pending) {
        CastRuntime.pending?.let {
            vm.playCast(it.url, it.title)
            CastRuntime.pending = null
        }
    }

    // 手机上系统返回键/手势是主入口，必须接管，否则一返回就退出 App
    BackHandler(enabled = screen !is Screen.Home) { vm.back() }

    // 清单里固定竖屏；播放页需要横屏全屏，进出时动态切回来
    KeepScreenOrientation(screen)

    Box(Modifier.fillMaxSize().background(Bg)) {
        when (screen) {
            is Screen.Player -> PlayerScreen(vm, screen, onExit = { vm.back() })
            is Screen.LivePlayer -> LivePlayerScreen(vm, screen.channel, screen.playlist, onExit = { vm.back() })
            is Screen.CastPlayer -> CastPlayerScreen(screen, onExit = { vm.back() })
            is Screen.Detail -> DetailScreen(vm, screen, data)
            is Screen.Category -> CategoryScreen(vm, data)
            else -> Column(Modifier.fillMaxSize().statusBarsPadding()) {
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (screen) {
                        Screen.Home -> HomeScreen(vm, data)
                        Screen.Search -> SearchScreen(vm, data)
                        Screen.Live -> LiveScreen(vm, data)
                        Screen.Cast -> CastScreen()
                        else -> SettingsScreen(vm, data)
                    }
                }
                PhoneBottomNav(current = screen, onSelect = { vm.go(it) })
            }
        }
        ToastHost(vm)
    }
}

/**
 * 播放页横屏、其它页面竖屏。
 *
 * 清单把 Activity 固定成 portrait（手机是竖屏设备，锁竖屏最稳），
 * 播放时再用 [Activity.requestedOrientation] 临时切到 landscape 全屏。
 * 不用 `sensorLandscape` 是因为用户可能正躺着看，固定 landscape 才不跳。
 */
@Composable
private fun KeepScreenOrientation(screen: Screen) {
    val activity = LocalContext.current as? Activity
    val landscape = screen is Screen.Player || screen is Screen.LivePlayer || screen is Screen.CastPlayer
    LaunchedEffect(landscape) {
        activity?.requestedOrientation = if (landscape) {
            ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        } else {
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }
    // 离开时把横屏留下会让下一屏也用横屏布局，所以离开组合时复位
    DisposableEffect(Unit) {
        onDispose {
            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }
}

private data class NavItem(val screen: Screen, val label: String, val icon: ImageVector)
/** 底部四个 Tab。「投屏」不占 Tab 位，从首页的投屏状态条进。 */
@Composable
private fun PhoneBottomNav(current: Screen, onSelect: (Screen) -> Unit) {
    val items = remember {
        listOf(
            NavItem(Screen.Home, "首页", Icons.Filled.Home),
            NavItem(Screen.Search, "搜索", Icons.Filled.Search),
            NavItem(Screen.Live, "直播", Icons.Filled.PlayArrow),
            NavItem(Screen.Settings, "设置", Icons.Filled.Settings),
        )
    }
    Column(Modifier.fillMaxWidth().background(Panel)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Line))
        Row(
            modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            items.forEach { item ->
                // Cast 页归属于「设置」这一栏：手机版没有独立投屏 Tab
                val active = current::class == item.screen::class ||
                    (item.screen is Screen.Settings && current is Screen.Cast)
                Column(
                    modifier = Modifier
                        .clip(RoundedCornerShape(12.dp))
                        .clickable { onSelect(item.screen) }
                        .background(if (active) Color(0xFF22140F) else Color.Transparent)
                        .padding(horizontal = 18.dp, vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Icon(
                        item.icon,
                        contentDescription = item.label,
                        tint = if (active) Accent else TextMuted,
                        modifier = Modifier.size(22.dp),
                    )
                    Text(
                        item.label,
                        color = if (active) Accent else TextMuted,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                    )
                }
            }
        }
    }
}

/** 二级页面的返回头。手机上没有遥控器，必须给一个明确的返回按钮。 */
@Composable
fun PhoneTopBar(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            Box(
                Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(Panel)
                    .clickable(onClick = onBack)
                    .padding(horizontal = 13.dp, vertical = 7.dp),
            ) {
                Text("‹ 返回", color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
            }
            Box(Modifier.size(10.dp))
        }
        Text(
            title,
            color = TextPrimary,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

/** 轻提示，3.2 秒自动消失，与电视版一致。 */
@Composable
private fun ToastHost(vm: AppViewModel) {
    val message = vm.toast
    LaunchedEffect(message) {
        if (message != null) {
            delay(3200)
            vm.consumeToast()
        }
    }
    Box(Modifier.fillMaxSize().padding(bottom = 100.dp), contentAlignment = Alignment.BottomCenter) {
        AnimatedVisibility(
            visible = message != null,
            enter = fadeIn() + slideInVertically { it / 2 },
            exit = fadeOut() + slideOutVertically { it / 2 },
        ) {
            Box(
                Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .background(Panel)
                    .padding(horizontal = 18.dp, vertical = 12.dp),
            ) {
                Text(message ?: "", color = TextPrimary, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/** 1dp 分隔线。 */
@Composable
fun PhoneDivider(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(Line))
}
