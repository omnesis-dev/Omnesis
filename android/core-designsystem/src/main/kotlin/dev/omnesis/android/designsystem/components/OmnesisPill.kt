// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.PillColors
import dev.omnesis.android.designsystem.theme.pill

/**
 * State chip — uppercased, tracked, 11sp medium, on a tinted background with a fixed 10dp
 * radius (NOT a full capsule). Ported from the iOS `OmnesisPill` (Theme.swift). Colours
 * come from the [PillColors] pair (see `OmnesisColors.pill`).
 */
@Composable
fun OmnesisPill(
    text: String,
    colors: PillColors,
    modifier: Modifier = Modifier,
    monospace: Boolean = false,
) {
    Text(
        text = text.uppercase(),
        style = MaterialTheme.typography.labelSmall.copy(
            letterSpacing = 0.5.sp,
            fontFamily = if (monospace) FontFamily.Monospace else null,
        ),
        color = colors.foreground,
        modifier = modifier
            .clip(RoundedCornerShape(OmRadius.pill))
            .background(colors.background)
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

/**
 * Convenience for a sync-state string — resolves the [PillColors] from the active palette.
 * The colour always keys off the raw [state] token; [label] overrides only the rendered text
 * (e.g. raw `needs-auth` colour with a "needs auth" label), mirroring the iOS `OmnesisPill`
 * which separates `text:` from `colors:`.
 */
@Composable
fun OmnesisStatePill(
    state: String?,
    paused: Boolean = false,
    label: String? = null,
    modifier: Modifier = Modifier,
) = OmnesisPill(label ?: state.orEmpty(), OmTheme.colors.pill(state, paused), modifier)
