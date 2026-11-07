// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.routing.GatewayConnectionPath

@Composable
fun GatewayConnectionPill(path: GatewayConnectionPath) {
    Text(when (path) {
        GatewayConnectionPath.LOCAL -> "Local"
        GatewayConnectionPath.RELAY -> "Relay"
        GatewayConnectionPath.RECONNECTING -> "Reconnecting"
    }, style = MaterialTheme.typography.labelSmall, color = OmTheme.colors.textSecondary,
        modifier = Modifier.background(OmTheme.colors.bgTertiary, RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 4.dp).testTag("gateway.connectionPath"))
}
