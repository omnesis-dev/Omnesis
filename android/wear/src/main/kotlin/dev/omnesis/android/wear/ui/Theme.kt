// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme

/** The watch app's colours. The watch draws on black only, so there is one palette. */
object WearPalette {
    /** The brand blue, as the phone's dark theme uses it. */
    val Accent = Color(0xFF58A6FF)
    val OnAccent = Color.Black
    val Text = Color.White

    /** Supporting lines, and the part of an answer not read aloud yet. */
    val SecondaryText = Color(0xFFA9B1BC)

    /** The fill of a button that is not the screen's main action. */
    val Tonal = Color(0xFF1E2835)
    val Success = Color(0xFF3DD68C)
    val Warning = Color(0xFFFFA940)
    val Recording = Color(0xFFFF6B63)
}

@Composable
fun OmnesisWearTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colors = Colors(
            primary = WearPalette.Accent,
            onPrimary = WearPalette.OnAccent,
            secondary = WearPalette.Accent,
            onSecondary = WearPalette.OnAccent,
            surface = WearPalette.Tonal,
            onSurface = WearPalette.Text,
            onSurfaceVariant = WearPalette.SecondaryText,
            background = Color.Black,
            onBackground = WearPalette.Text,
            error = WearPalette.Warning,
            onError = Color.Black,
        ),
        content = content,
    )
}
