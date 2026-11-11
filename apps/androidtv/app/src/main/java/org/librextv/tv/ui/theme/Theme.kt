package org.librextv.tv.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Accent = Color(0xFFFF6B3D)
val AccentSoft = Color(0xFF3A1D12)
val Bg = Color(0xFF0A0C10)
val Panel = Color(0xFF13171F)
val Panel2 = Color(0xFF1A202B)
val Line = Color(0xFF242B38)
val TextPrimary = Color(0xFFE9EDF5)
val TextMuted = Color(0xFF8D97A8)
val OkGreen = Color(0xFF4ECB8F)
val WarnAmber = Color(0xFFF0B429)
val ErrRed = Color(0xFFF2555A)

private val TvColors = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF1A0D07),
    primaryContainer = AccentSoft,
    onPrimaryContainer = Color(0xFFFFD0BF),
    secondary = Color(0xFFFFB199),
    onSecondary = Color(0xFF1A0D07),
    background = Bg,
    onBackground = TextPrimary,
    surface = Panel,
    onSurface = TextPrimary,
    surfaceVariant = Panel2,
    onSurfaceVariant = TextMuted,
    outline = Line,
    error = ErrRed,
)

@Composable
fun LibreXtvTheme(content: @Composable () -> Unit) {
    // TV 端固定深色：客厅环境更合适，也避免投屏时屏幕过亮
    MaterialTheme(colorScheme = TvColors, typography = TvTypography, content = content)
}
