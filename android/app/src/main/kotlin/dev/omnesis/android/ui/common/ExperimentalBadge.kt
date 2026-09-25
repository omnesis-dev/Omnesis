// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * An unobtrusive "Experimental" capsule, shared by every surface gated on
 * experimental mode — the Triggers menu entry, the experimental capability
 * cards on the Models screen. The Android analogue of the portal's
 * `experimental-tag`; one source of truth so it reads identically everywhere.
 */
@Composable
fun ExperimentalBadge() {
    val colors = OmTheme.colors
    Text(
        "Experimental",
        style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Medium),
        color = colors.textMuted,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(colors.bgSecondary)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
