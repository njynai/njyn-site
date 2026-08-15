package ai.njyn.meetingnotes.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * njyn.ai brand colours, matching the website and the desktop app.
 *
 * The app is dark regardless of the system setting - obsidian and gold is the
 * brand, and a recorder that is mostly used in dim rooms has no business
 * flashing white.
 */
object Njyn {
    val Obsidian = Color(0xFF0B0E1A)
    val Obsidian2 = Color(0xFF10141F)
    val Gold = Color(0xFFC9A96E)
    val Gold2 = Color(0xFFE2C99A)
    val Royal = Color(0xFF4B0082)
    val Text = Color(0xFFE8E4F0)
    val Muted = Color(0xFF9B94B0)
    val Red = Color(0xFFE84A4A)
    val Green = Color(0xFF3AD07A)
}

private val ColorScheme = darkColorScheme(
    primary = Njyn.Gold,
    onPrimary = Njyn.Obsidian,
    secondary = Njyn.Royal,
    onSecondary = Njyn.Text,
    background = Njyn.Obsidian,
    onBackground = Njyn.Text,
    surface = Njyn.Obsidian2,
    onSurface = Njyn.Text,
    surfaceVariant = Njyn.Obsidian2,
    onSurfaceVariant = Njyn.Muted,
    error = Njyn.Red,
    outline = Njyn.Gold.copy(alpha = 0.3f),
)

/** The site's mono label treatment: small, wide-tracked, uppercase. */
val LabelStyle = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 11.sp,
    letterSpacing = 2.sp,
    fontWeight = FontWeight.Normal,
)

/** The site's display treatment: heavy, tight, uppercase. */
val DisplayStyle = TextStyle(
    fontWeight = FontWeight.Black,
    letterSpacing = 0.5.sp,
)

@Composable
fun NjynTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = ColorScheme,
        typography = Typography(),
        content = content,
    )
}
