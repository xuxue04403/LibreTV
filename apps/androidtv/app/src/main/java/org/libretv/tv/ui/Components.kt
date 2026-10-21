package org.libretv.tv.ui

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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import coil.compose.AsyncImage
import coil.request.ImageRequest
import org.libretv.tv.data.Net
import org.libretv.tv.ui.theme.Accent
import org.libretv.tv.ui.theme.Line
import org.libretv.tv.ui.theme.Panel
import org.libretv.tv.ui.theme.Panel2
import org.libretv.tv.ui.theme.TextMuted
import org.libretv.tv.ui.theme.TextPrimary

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
    content: @Composable (Boolean) -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val scale by animateFloatAsState(if (focused) focusedScale else 1f, label = "tvCardScale")

    Box(
        modifier
            .zIndex(if (focused) 2f else 0f)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(shape)
            .background(if (focused) Panel2 else containerColor)
            .border(if (focused) 2.dp else 1.dp, if (focused) Accent else Line, shape)
            .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
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
) {
    TvCard(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(999.dp),
        containerColor = if (primary) Accent else Panel2,
        focusedScale = 1.06f,
        focusRequester = focusRequester,
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
fun SectionHeader(title: String, hint: String? = null, modifier: Modifier = Modifier) {
    // 参数顺序符合 Compose 约定：modifier 是第一个可选参数（lint ModifierParameter）
    Row(
        modifier = modifier.padding(top = 26.dp, bottom = 10.dp),
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

val ScreenPadding = PaddingValues(horizontal = 46.dp, vertical = 26.dp)

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
