// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.ui

import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * The setup pages' own palette: the landing screen's ground and halo, with
 * cards and chips a step darker or lighter than it. Not design-system tokens —
 * these washes compose one flow, and light is the same idea inverted.
 */
@Immutable
data class SetupPalette(
    val isDark: Boolean,
    val base: Color,
    val card: Color,
    val cardBorder: Color,
    val chip: Color,
    val chipText: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    val segmentPending: Color,
    val haloAlpha: Float,
    val toggleOn: Color,
    /** "On" as text: the switch green, deepened where it would wash out on a light ground. */
    val onText: Color,
    val link: Color,
    val danger: Color,
)

private val DarkSetup = SetupPalette(
    isDark = true,
    base = Color(0xFF070B12),
    card = Color(0xFF0C1320),
    cardBorder = Color(0xFF1D2838),
    chip = Color(0xFF152032),
    chipText = Color(0xFFCFD9E4),
    textPrimary = Color(0xFFE6EDF3),
    textSecondary = Color(0xFF9AA6B3),
    textMuted = Color(0xFF6E7A88),
    segmentPending = Color(0xFF1F2A3A),
    haloAlpha = 0.34f,
    toggleOn = Color(0xFF30D158),
    onText = Color(0xFF30D158),
    link = Color(0xFF9CC4FF),
    danger = Color(0xFFF85149),
)

private val LightSetup = SetupPalette(
    isDark = false,
    base = Color(0xFFFFFFFF),
    card = Color(0xFFF5F8FC),
    cardBorder = Color(0xFFDCE3EC),
    chip = Color(0xFFE8EEF6),
    chipText = Color(0xFF24303F),
    textPrimary = Color(0xFF18202C),
    textSecondary = Color(0xFF4A5666),
    textMuted = Color(0xFF6A7584),
    segmentPending = Color(0xFFDCE3EC),
    haloAlpha = 0.22f,
    toggleOn = Color(0xFF34C759),
    onText = Color(0xFF1A7F37),
    link = Color(0xFF0B55C9),
    danger = Color(0xFFCF222E),
)

val setupPalette: SetupPalette
    @Composable get() = if (OmTheme.colors.isDark) DarkSetup else LightSetup

/** The brand tint Connected, Choose and Finish are lit with. */
val SetupBrandTint = Color(0xFF4B9BFF)

/** The brand blue deep enough to draw the mark on a light ground. */
val SetupBrandInk = Color(0xFF2F6BEA)

/** The mark's gradient, light to deep. */
val SetupGradient = listOf(Color(0xFF72C7FF), Color(0xFF4B9BFF), Color(0xFF386FFF))

/**
 * A tint legible as foreground: bright tints (the notifications yellow) wash
 * out on a white ground, so light pages draw glyphs and indicators a shade
 * deeper. Fills keep the tint itself.
 */
fun Color.asSetupForeground(palette: SetupPalette): Color =
    if (palette.isDark) this else lerp(this, Color.Black, 0.28f)

/**
 * Whether decorative motion should be skipped: under render tests, where an
 * animation would never idle, and while animations are turned off system-wide.
 * Read again every time the app resumes, so turning animations back on in
 * Settings brings the motion back.
 */
@Composable
fun setupMotionReduced(): Boolean {
    if (LocalInspectionMode.current) return true
    val context = LocalContext.current
    var disabled by remember(context) { mutableStateOf(systemAnimationsDisabled(context)) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { disabled = systemAnimationsDisabled(context) }
    return disabled
}

/** Animations are off system-wide: developer options or "Remove animations" set the animator duration scale to 0. */
fun systemAnimationsDisabled(context: Context): Boolean =
    runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
        .getOrDefault(false)
