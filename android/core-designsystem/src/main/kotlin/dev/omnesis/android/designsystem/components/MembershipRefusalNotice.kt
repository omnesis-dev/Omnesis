// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * Why the gateway will not have this phone host a source, shown above the
 * source's card once its switch has been put back off. Every phone-hosted
 * source can be refused for the same few reasons, and the switch it flips back
 * looks identical whichever source it belongs to, so the notice lives here
 * rather than in each source's section.
 */
@Composable
fun MembershipRefusalNotice(text: String) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(c.warning.copy(alpha = 0.10f))
            .border(1.dp, c.warning.copy(alpha = 0.4f), RoundedCornerShape(OmRadius.medium))
            .padding(OmSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Icon(Icons.Outlined.WarningAmber, null, tint = c.warning, modifier = Modifier.size(18.dp))
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = c.warning,
            modifier = Modifier.weight(1f),
        )
    }
}
