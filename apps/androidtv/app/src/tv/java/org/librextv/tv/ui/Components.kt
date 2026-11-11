package org.librextv.tv.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
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
 * 电视端统一的可聚焦卡片：获得焦点时放大 + 橙色描边。
 *
 * 没有用 tv-material 的 Card，是因为焦点态样式（描边宽度、放大倍数、
 * 浮层层级）需要按客厅观看距离微调，自己实现更好控制。
 */
@Composable
fun TvCard(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    shape: RoundedCornerShape = RoundedCornerShape(14.dp),
    containerColor: Color = Panel,
    focusedScale: Float = 1.05f,
    focusRequester: FocusRequester? = null,
    /**
     * 焦点变化回调。
     *
     * 别在外层用 `Modifier.onFocusChanged {}` 代替：传进来的 modifier 后面还接着
     * focusRequester / clickable，外层拿不到焦点事件——实测焦点描边出来了、
     * 回调一次都没触发。卡片内部本来就在观察 interaction 的焦点态（描边与放大
     * 都靠它），在这里转发才可靠。
     */
    onFocusChange: ((Boolean) -> Unit)? = null,
    /** 置灰并禁用点击：重复进同一个长任务（如导入）时不给第二次机会 */
    enabled: Boolean = true,
    content: @Composable (Boolean) -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val scale by animateFloatAsState(if (focused) focusedScale else 1f, label = "tvCardScale")
    LaunchedEffect(focused) { onFocusChange?.invoke(focused) }

    Box(
        modifier
            .zIndex(if (focused) 2f else 0f)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                if (!enabled) alpha = 0.45f
            }
            .clip(shape)
            .background(if (focused) Panel2 else containerColor)
            .border(if (focused) 2.dp else 1.dp, if (focused) Accent else Line, shape)
            .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                onClick = onClick,
            )
    ) {
        content(focused)
    }
}

/** 电视端按钮：胶囊形，聚焦时反色，避免小按钮在 3 米外看不清 */
@Composable
fun TvButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    focusRequester: FocusRequester? = null,
    enabled: Boolean = true,
) {
    TvCard(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(999.dp),
        containerColor = if (primary) Accent else Panel2,
        focusedScale = 1.06f,
        focusRequester = focusRequester,
        enabled = enabled,
    ) { focused ->
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 22.dp, vertical = 11.dp),
            color = when {
                primary && focused -> Color.White
                primary -> Color(0xFF1A0D07)
                focused -> Accent
                else -> TextPrimary
            },
            fontSize = MaterialTheme.typography.labelLarge.fontSize,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
}

/** 海报：2:3 比例，加载失败时显示首字占位 */
@Composable
fun Poster(
    url: String?,
    title: String,
    modifier: Modifier = Modifier,
    showLabel: Boolean = true,
) {
    Box(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xFF10141B)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = title.take(2).ifBlank { "?" },
            color = Color(0xFF455063),
            fontSize = MaterialTheme.typography.headlineLarge.fontSize,
            fontWeight = FontWeight.Bold,
        )
        if (!url.isNullOrBlank()) {
            AsyncImage(
                model = ImageRequest.Builder(androidx.compose.ui.platform.LocalContext.current)
                    .data(url)
                    .addHeader("User-Agent", Net.UA)
                    .addHeader("Referer", runCatching { java.net.URI(url).let { "${it.scheme}://${it.host}/" } }.getOrDefault(""))
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
                        androidx.compose.ui.graphics.Brush.verticalGradient(
                            0.55f to Color.Transparent,
                            1f to Color(0xCC05070A),
                        )
                    )
            )
        }
    }
}

@Composable
fun SectionHeader(
    title: String,
    hint: String? = null,
    modifier: Modifier = Modifier,
    onMore: (() -> Unit)? = null,
    // 首页第一个分区不需要再空一大截（顶栏下面本来就有留白），其它页面保持默认
    topPadding: Dp = 26.dp,
) {
    // 参数顺序符合 Compose 约定：modifier 是第一个可选参数（lint ModifierParameter）
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = topPadding, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(width = 4.dp, height = 18.dp)
                .background(Accent, RoundedCornerShape(2.dp))
        )
        Spacer(Modifier.width(9.dp))
        Text(title, color = TextPrimary, fontSize = MaterialTheme.typography.titleLarge.fontSize, fontWeight = FontWeight.SemiBold)
        if (hint != null) {
            Spacer(Modifier.width(10.dp))
            Text(hint, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        }
        if (onMore != null) {
            Spacer(Modifier.weight(1f))
            // 「查看全部 ›」：内容流每排只摆十几张，得有个明确的出口
            TvCard(
                onClick = onMore,
                shape = RoundedCornerShape(999.dp),
                containerColor = Color.Transparent,
                focusedScale = 1.04f,
            ) { focused ->
                Text(
                    "查看全部 ›",
                    color = if (focused) Accent else TextMuted,
                    fontSize = MaterialTheme.typography.bodySmall.fontSize,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
    }
}

/**
 * 首页/分类页统一的海报卡：2:3 海报 + 标题 + 副标题。
 *
 * 原来首页并存三种比例（分类 128 方形、收藏 158×228、直播 200 横卡），
 * 一屏里三种尺度在客厅距离下显得很乱。内容流统一用这一种。
 */
@Composable
fun PosterCard(
    title: String,
    poster: String?,
    subtitle: String? = null,
    width: androidx.compose.ui.unit.Dp = 124.dp,
    onClick: () -> Unit,
) {
    // 海报高度由宽度推出来（约 1.45 倍），这样改卡宽不用各处同步改高度。
    TvCard(onClick = onClick, modifier = Modifier.width(width), focusedScale = 1.06f) { focused ->
        Column {
            Poster(poster, title, Modifier.fillMaxWidth().height(width * 1.45f))
            Column(Modifier.padding(horizontal = 9.dp, vertical = 8.dp)) {
                EllipsizedText(
                    title,
                    fontSize = MaterialTheme.typography.titleSmall.fontSize,
                    color = if (focused) Accent else TextPrimary,
                )
                if (!subtitle.isNullOrBlank()) {
                    Spacer(Modifier.height(3.dp))
                    Text(
                        subtitle,
                        color = TextMuted,
                        fontSize = MaterialTheme.typography.bodySmall.fontSize,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
fun Chip(text: String, active: Boolean = false, onClick: (() -> Unit)? = null) {
    val shape = RoundedCornerShape(999.dp)
    // 遥控器上必须能看出焦点在哪：之前只有 clickable 没有焦点态，换源/建议全靠猜
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Box(
        Modifier
            .clip(shape)
            .background(
                when {
                    focused -> Panel
                    active -> Color(0xFF3A1D12)
                    else -> Panel2
                }
            )
            .border(
                when {
                    focused -> 2.dp
                    active -> 1.dp
                    else -> 1.dp
                },
                if (focused || active) Accent else Line,
                shape,
            )
            .then(
                if (onClick != null) {
                    Modifier.focusable(interactionSource = interaction).clickable(
                        interactionSource = interaction,
                        indication = null,
                    ) { onClick() }
                } else {
                    Modifier
                }
            )
            .padding(horizontal = 12.dp, vertical = 6.dp)
    ) {
        Text(
            text = text,
            color = if (focused || active) Color(0xFFFFC4B0) else TextMuted,
            fontSize = MaterialTheme.typography.bodySmall.fontSize,
            maxLines = 1,
        )
    }
}

@Composable
fun EmptyState(title: String, description: String, modifier: Modifier = Modifier, action: @Composable () -> Unit = {}) {
    Column(
        modifier
            .width(620.dp)
            .clip(RoundedCornerShape(16.dp))
            .border(1.dp, Line, RoundedCornerShape(16.dp))
            .background(Color(0xFF0E1218))
            .padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, color = TextPrimary, fontSize = MaterialTheme.typography.titleMedium.fontSize, fontWeight = FontWeight.SemiBold)
        Text(description, color = TextMuted, fontSize = MaterialTheme.typography.bodySmall.fontSize)
        action()
    }
}

@Composable
fun RowSpacer(width: Int = 10) {
    Spacer(Modifier.width(width.dp))
}

@Composable
fun VSpacer(height: Int = 10) {
    Spacer(Modifier.height(height.dp))
}

// 左右留白对称：导航收窄到 84dp 之后，左边不再比右边多出一截。
// 原来是 horizontal = 46dp，加上 104dp 导航，左侧视觉留白 150dp、右侧只有 46dp。
val ScreenPadding = PaddingValues(horizontal = 36.dp, vertical = 22.dp)

/**
 * 首页专用内边距：顶栏已经有 76dp 高，再叠 22dp 会在内容上方留出
 * 一块什么也没有的空白（截图里被用户圈出来的那块）。上边只留 6dp。
 */
val HomePadding = PaddingValues(start = 36.dp, top = 6.dp, end = 36.dp, bottom = 16.dp)

@Composable
fun ProgressBar(progress: Float, modifier: Modifier = Modifier, color: Color = Accent) {
    Box(
        modifier
            .height(4.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(Color(0x33FFFFFF))
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .graphicsLayer { scaleX = progress.coerceIn(0f, 1f); transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0.5f) }
                .background(color)
        )
    }
}

@Composable
fun EllipsizedText(text: String, maxLines: Int = 1, color: Color = TextPrimary, fontSize: androidx.compose.ui.unit.TextUnit = MaterialTheme.typography.bodyMedium.fontSize) {
    Text(
        text = text,
        color = color,
        fontSize = fontSize,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}
