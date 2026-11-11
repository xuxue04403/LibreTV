package org.librextv.tv.phone

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import org.librextv.tv.data.Net
import org.librextv.tv.ui.theme.Accent
import org.librextv.tv.ui.theme.Line
import org.librextv.tv.ui.theme.Panel
import org.librextv.tv.ui.theme.Panel2
import org.librextv.tv.ui.theme.TextMuted
import org.librextv.tv.ui.theme.TextPrimary

/**
 * 手机版的基础视觉组件。
 *
 * 与电视版的 `ui/Components.kt` 刻意分开：电视版所有控件都围绕「焦点」设计
 * （FocusRequester、聚焦放大、遥控器方向键遍历），手机上这些全无意义，
 * 只保留点击与水波纹。配色、圆角、层级感保持一致，两个版本看起来仍是同一个 App。
 */

/** 手机版通用页面内边距：比电视版窄，竖屏两侧各 16dp 才不会显得空。 */
val PhonePadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp)

/** 底部导航栏占位高度，供各页面给内容留出不被遮挡的空间。 */
val BottomNavHeight: Dp = 60.dp

/**
 * 可点击的卡片：统一圆角、边框与按下的深色反馈。
 *
 * 不用 Material 的 Card，是因为我们要的是「深色 + 细边框」这种克制风格，
 * Card 自带的阴影与表面色在纯黑背景上会显脏。
 */
@Composable
fun PhoneCard(
    onClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    shape: RoundedCornerShape = RoundedCornerShape(12.dp),
    containerColor: Color = Panel,
    borderColor: Color = Line,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val base = modifier
        .clip(shape)
        .background(containerColor)
        .border(1.dp, borderColor, shape)
    val clickable = if (onClick != null && enabled) base.clickable(onClick = onClick) else base
    Box(clickable) { content() }
}

/** 主要/次要按钮，胶囊形。主按钮用强调色实心，次按钮用面板色。 */
@Composable
fun PhoneButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    enabled: Boolean = true,
) {
    val bg = when {
        !enabled -> Panel
        primary -> Accent
        else -> Panel2
    }
    val fg = when {
        !enabled -> TextMuted
        primary -> Color(0xFF1A0D07)
        else -> TextPrimary
    }
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bg)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = fg, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
    }
}

/** 文本胶囊，用于分类筛选、片源切换、状态标签。可选 `onClick` 为空表示纯展示。 */
@Composable
fun PhoneChip(
    text: String,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val bg = if (active) Color(0xFF3A1D12) else Panel
    val fg = if (active) Color(0xFFFFC4B0) else TextMuted
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(bg)
            .border(1.dp, if (active) Accent else Line, RoundedCornerShape(999.dp))
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 13.dp, vertical = 7.dp),
    ) {
        Text(text, color = fg, style = MaterialTheme.typography.bodySmall, maxLines = 1)
    }
}

/**
 * 2:3 海报。
 *
 * 片源站的图床大多校验 Referer，不带给就会 403 出白图——这里按图片自身域名补上，
 * 与电视版一致。加载失败时退回片名首两字的色块，避免大片空白。
 */
@Composable
fun PhonePoster(
    url: String?,
    title: String,
    modifier: Modifier = Modifier,
    showLabel: Boolean = true,
) {
    Box(modifier = modifier.clip(RoundedCornerShape(10.dp)).background(Color(0xFF10141B))) {
        if (url.isNullOrBlank()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    title.take(2),
                    color = Color(0xFF455063),
                    style = MaterialTheme.typography.titleLarge,
                )
            }
        } else {
            val context = LocalContext.current
            val referer = remember(url) {
                runCatching {
                    val parsed = Uri.parse(url)
                    "${parsed.scheme}://${parsed.host}/"
                }.getOrNull() ?: ""
            }
            AsyncImage(
                model = ImageRequest.Builder(context)
                    .data(url)
                    .addHeader("User-Agent", Net.UA)
                    .apply { if (referer.isNotEmpty()) addHeader("Referer", referer) }
                    .crossfade(true)
                    .build(),
                contentDescription = title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        if (showLabel) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(
                        Brush.verticalGradient(
                            0.55f to Color.Transparent,
                            1f to Color(0xCC05070A),
                        ),
                    ),
            )
        }
    }
}

/** 分区标题：左侧一竖条强调色 + 标题 + 可选说明与「更多」。 */
@Composable
fun PhoneSection(
    title: String,
    hint: String? = null,
    modifier: Modifier = Modifier,
    onMore: (() -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(top = 18.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(16.dp).clip(RoundedCornerShape(2.dp)).background(Accent))
        Spacer(Modifier.width(8.dp))
        Text(
            title,
            color = TextPrimary,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
        if (hint != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                hint,
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.weight(1f))
        if (onMore != null) {
            Text(
                "更多 ›",
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.clip(RoundedCornerShape(999.dp)).clickable(onClick = onMore).padding(6.dp),
            )
        }
    }
}

/** 空状态 / 错误态面板。手机上宽度自适应，不再固定 620dp。 */
@Composable
fun PhoneEmpty(
    title: String,
    description: String,
    modifier: Modifier = Modifier,
    action: @Composable () -> Unit = {},
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Color(0xFF0E1218))
            .border(1.dp, Line, RoundedCornerShape(14.dp))
            .padding(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, color = TextPrimary, style = MaterialTheme.typography.titleMedium)
            Text(
                description,
                color = TextMuted,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
            action()
        }
    }
}

/** 细进度条，用于播放页缓冲显示。 */
@Composable
fun PhoneProgress(progress: Float, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(3.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(Color(0xFF232A36)),
    ) {
        Box(
            Modifier
                .fillMaxWidth(progress.coerceIn(0f, 1f))
                .height(3.dp)
                .background(Accent),
        )
    }
}

/** 单行省略文本的常用封装。 */
@Composable
fun PhoneLine(
    text: String,
    color: Color = TextPrimary,
    size: TextUnit = MaterialTheme.typography.bodyMedium.fontSize,
    maxLines: Int = 1,
    modifier: Modifier = Modifier,
) {
    Text(
        text,
        color = color,
        fontSize = size,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier,
    )
}

/** 小间距盒子，给 LazyRow/LazyColumn 之间塞空隙用。 */
@Composable
fun Gap(size: Dp) {
    Spacer(Modifier.size(size))
}
