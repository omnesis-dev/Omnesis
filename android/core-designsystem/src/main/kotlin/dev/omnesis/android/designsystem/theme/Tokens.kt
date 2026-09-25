// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Token accessor mirroring the iOS `Theme` enum. Use inside composables:
 * `OmTheme.colors.bgSecondary`, `OmTheme.spacing.lg`, `OmTheme.radius.medium`.
 */
object OmTheme {
    val colors: OmnesisColors
        @Composable @ReadOnlyComposable get() = LocalOmnesisColors.current

    val spacing get() = OmSpacing
    val radius get() = OmRadius
}

/** iOS `Theme.Spacing`: xs=4, sm=8, md=12, lg=16, xl=24. */
object OmSpacing {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
}

/** iOS `Theme.Radius`: small=4, medium=6, large=8, pill=10. */
object OmRadius {
    val small = 4.dp
    val medium = 6.dp
    val large = 8.dp
    val pill = 10.dp
}

/**
 * Doc-type left-border accent, ported from iOS `Theme.docTypeAccent`. Mirrors the
 * portal's colour-coding on result cards; light variants are darker so the thin accent
 * stays legible on a light surface.
 */
fun OmnesisColors.docTypeAccent(type: String?): Color = when (type) {
    "email" -> if (isDark) Color(0xFFF78166) else Color(0xFFBC4C00)
    "note" -> if (isDark) Color(0xFF7EE787) else Color(0xFF1A7F37)
    "event" -> if (isDark) Color(0xFFD2A8FF) else Color(0xFF8250DF)
    "conversation", "message" -> if (isDark) Color(0xFF79C0FF) else Color(0xFF0969DA)
    "bookmark" -> if (isDark) Color(0xFFFFA657) else Color(0xFF9A6700)
    "task", "reminder" -> if (isDark) Color(0xFFFF7B72) else Color(0xFFCF222E)
    "page" -> if (isDark) Color(0xFFA5D6FF) else Color(0xFF218BFF)
    "activity" -> if (isDark) Color(0xFF7EE787) else Color(0xFF1A7F37)
    "contact" -> if (isDark) Color(0xFFD2A8FF) else Color(0xFF8250DF)
    else -> accent
}

/** State-pill colour pair (background tint + foreground). Ported from iOS `Theme.pillColor`. */
data class PillColors(val background: Color, val foreground: Color)

fun OmnesisColors.pill(state: String?, paused: Boolean = false): PillColors {
    if (paused) return PillColors(bgTertiary, textMuted)
    return when (state) {
        "syncing" -> PillColors(accent.copy(alpha = 0.15f), accentHover)
        "synced", "completed" -> PillColors(success.copy(alpha = 0.15f), success)
        "error" -> PillColors(danger.copy(alpha = 0.15f), danger)
        "needs-auth" -> PillColors(warning.copy(alpha = 0.15f), warning)
        // Forward-looking consent-expiry (#927): the source is still syncing fine,
        // but its authorization expires soon. A softer amber-tinted warning, distinct
        // from the harder terminal `needs-auth`; the inline "Expires on <date>" copy
        // carries the actual distinction in the rows/detail. Mirrors iOS Theme.pillColor.
        "auth-expiring" -> PillColors(warning.copy(alpha = 0.12f), warning)
        // The source syncs fine but its local data feed has stopped delivering,
        // usually because the app maintaining it isn't running. Indexed data is
        // intact and the fix takes seconds, so it shares the softer amber of
        // `auth-expiring` rather than error-red. Mirrors iOS Theme.pillColor.
        "stale" -> PillColors(warning.copy(alpha = 0.12f), warning)
        "idle" -> PillColors(bgTertiary, textSecondary)
        "disabled", "paused" -> PillColors(bgTertiary, textMuted)
        else -> PillColors(bgTertiary, textSecondary)
    }
}
