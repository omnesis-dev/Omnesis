// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider

/**
 * Root theme for the Omnesis Android app. Wrap every screen (and every `@Preview`) in
 * this. Supplies the GitHub-Primer [OmnesisColors] tokens via [LocalOmnesisColors] (read
 * through [OmTheme.colors]) and a Material3 scheme derived from the same tokens, so both
 * token-exact and stock-Material call sites share one palette. Dark is the default.
 */
@Composable
fun OmnesisTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) OmnesisDarkColors else OmnesisLightColors
    CompositionLocalProvider(
        LocalOmnesisColors provides colors,
        // Tight text metrics (no font padding, trimmed leading) for every call site, including
        // ad-hoc `Text(fontSize = …)` ones that don't pick up a Typography style. See Type.kt.
        LocalTextStyle provides OmnesisDefaultTextStyle,
    ) {
        MaterialTheme(
            colorScheme = materialSchemeFrom(colors),
            typography = OmnesisTypography,
            content = content,
        )
    }
}
