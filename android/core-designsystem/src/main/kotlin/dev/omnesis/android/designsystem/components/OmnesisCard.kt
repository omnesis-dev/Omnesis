// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * Flat card surface — `bgSecondary` fill + 1px `border` hairline + 8dp corners, NO
 * elevation/shadow. Ported from the iOS `OmnesisCard` (Theme.swift). Use for stat blocks,
 * summary panels, and group containers. Clip-then-fill-then-border so the stroke lands on
 * the rounded edge.
 */
@Composable
fun OmnesisCard(
    modifier: Modifier = Modifier,
    padding: Dp = OmSpacing.md,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = OmTheme.colors
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(OmRadius.large))
            .background(c.bgSecondary)
            .border(1.dp, c.border, RoundedCornerShape(OmRadius.large))
            .padding(padding),
        content = content,
    )
}
