// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * The Omnesis palette, ported 1:1 from the iOS `Theme` tokens. Both apps draw the
 * GitHub Primer palette — the dark variants mirror the portal's GitHub-dark CSS, the
 * light variants the GitHub-light equivalent — so the iOS app, Android app, and portal
 * read as the same product.
 *
 * iOS resolves `Color(light:dark:)` adaptively per call site; Compose can't, so the full
 * resolved token set is carried in [OmnesisColors] and supplied through
 * [LocalOmnesisColors]. Read it via [OmTheme.colors] inside composables.
 */
data class OmnesisColors(
    val isDark: Boolean,
    // Background surfaces
    val bgPrimary: Color,
    val bgDrawer: Color,
    val bgSecondary: Color,
    val bgTertiary: Color,
    val border: Color,
    val borderLight: Color,
    // Text
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    // Accent / state
    val accent: Color,
    val accentHover: Color,
    // Brand mark — kept distinct from accent so the logo stays a consistent
    // brand blue across surfaces (#1F6FEB light / #58A6FF dark).
    val brandLogo: Color,
    val success: Color,
    val danger: Color,
    val warning: Color,
)

private fun hex(rgb: Long): Color = Color(0xFF000000 or rgb)

/** Light theme — GitHub-light palette. */
val OmnesisLightColors = OmnesisColors(
    isDark = false,
    bgPrimary = hex(0xFFFFFF),
    bgDrawer = hex(0xEAEEF2),
    bgSecondary = hex(0xF6F8FA),
    bgTertiary = hex(0xEAEEF2),
    border = hex(0xD0D7DE),
    borderLight = hex(0xE4E8EC),
    textPrimary = hex(0x1F2328),
    textSecondary = hex(0x59636E),
    textMuted = hex(0x656D76),
    accent = hex(0x0969DA),
    accentHover = hex(0x0860CA),
    brandLogo = hex(0x1F6FEB),
    success = hex(0x1A7F37),
    danger = hex(0xCF222E),
    warning = hex(0x9A6700),
)

/** Dark theme — GitHub-dark palette (the app default). */
val OmnesisDarkColors = OmnesisColors(
    isDark = true,
    bgPrimary = hex(0x0D1117),
    bgDrawer = hex(0x060A0F),
    bgSecondary = hex(0x161B22),
    bgTertiary = hex(0x21262D),
    border = hex(0x30363D),
    borderLight = hex(0x21262D),
    textPrimary = hex(0xE6EDF3),
    textSecondary = hex(0x8B949E),
    textMuted = hex(0x6E7681),
    accent = hex(0x58A6FF),
    accentHover = hex(0x79C0FF),
    brandLogo = hex(0x58A6FF),
    success = hex(0x3FB950),
    danger = hex(0xF85149),
    warning = hex(0xD29922),
)

val LocalOmnesisColors = staticCompositionLocalOf { OmnesisDarkColors }

/**
 * Derive a Material3 ColorScheme from the Omnesis tokens so stock Material components
 * (TopAppBar, Card, OutlinedTextField, …) adopt the same palette without every call site
 * reaching for [OmTheme]. Token-exact surfaces still read [OmTheme.colors] directly where
 * iOS does something specific.
 */
internal fun materialSchemeFrom(c: OmnesisColors) = if (c.isDark) {
    darkColorScheme(
        primary = c.accent,
        onPrimary = hex(0x0D1117),
        primaryContainer = c.accent.copy(alpha = 0.18f),
        onPrimaryContainer = c.accentHover,
        secondary = c.textSecondary,
        secondaryContainer = c.bgTertiary,
        onSecondaryContainer = c.textSecondary,
        background = c.bgPrimary,
        onBackground = c.textPrimary,
        surface = c.bgPrimary,
        onSurface = c.textPrimary,
        surfaceVariant = c.bgSecondary,
        onSurfaceVariant = c.textSecondary,
        surfaceContainer = c.bgSecondary,
        surfaceContainerHigh = c.bgTertiary,
        surfaceContainerHighest = c.bgTertiary,
        surfaceContainerLow = c.bgSecondary,
        surfaceContainerLowest = c.bgPrimary,
        outline = c.border,
        outlineVariant = c.borderLight,
        error = c.danger,
        onError = hex(0x0D1117),
        errorContainer = c.danger.copy(alpha = 0.18f),
        onErrorContainer = c.danger,
    )
} else {
    lightColorScheme(
        primary = c.accent,
        onPrimary = Color.White,
        primaryContainer = c.accent.copy(alpha = 0.12f),
        onPrimaryContainer = c.accentHover,
        secondary = c.textSecondary,
        secondaryContainer = c.bgTertiary,
        onSecondaryContainer = c.textSecondary,
        background = c.bgPrimary,
        onBackground = c.textPrimary,
        surface = c.bgPrimary,
        onSurface = c.textPrimary,
        surfaceVariant = c.bgSecondary,
        onSurfaceVariant = c.textSecondary,
        surfaceContainer = c.bgSecondary,
        surfaceContainerHigh = c.bgTertiary,
        surfaceContainerHighest = c.bgTertiary,
        surfaceContainerLow = c.bgSecondary,
        surfaceContainerLowest = c.bgPrimary,
        outline = c.border,
        outlineVariant = c.borderLight,
        error = c.danger,
        onError = Color.White,
        errorContainer = c.danger.copy(alpha = 0.12f),
        onErrorContainer = c.danger,
    )
}
