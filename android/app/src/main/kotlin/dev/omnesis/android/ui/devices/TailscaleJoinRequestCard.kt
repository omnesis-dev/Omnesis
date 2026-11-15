// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import dev.omnesis.android.ui.common.TimeFormat

/**
 * One device on the owner's Tailscale network that asked to join, as the Devices approvals sheet
 * lists it beside the devices that signed in: what it is and how it asked, the machine it runs
 * on, when it asked and until when, and Deny / Approve. An expired request keeps its card without
 * the actions until the next read drops it.
 */
@Composable
internal fun TailscaleJoinRequestCard(
    request: TailscaleJoinRequest,
    now: Long,
    /** The request whose decision is being sent; every card waits for it. */
    deciding: String?,
    onDecide: (TailscaleJoinRequest, Boolean) -> Unit,
) {
    val c = OmTheme.colors
    val expired = request.expired(now)
    val enabled = deciding == null && !expired
    OmnesisCard(Modifier.fillMaxWidth().testTag("tailscaleJoin.request"), padding = OmSpacing.lg) {
        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text(pairingApprovalHeadline(request.name), style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
            Text(
                tailscaleJoinViaLine(request),
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
                modifier = Modifier.testTag("tailscaleJoin.via"),
            )
            tailscaleJoinMachineLine(request)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary) }
            Text(tailscaleJoinTimingLine(request, now), style = MaterialTheme.typography.bodySmall, color = c.textMuted)
            if (!expired) {
                Spacer(Modifier.height(OmSpacing.sm))
                Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                    OutlinedButton(
                        onClick = { onDecide(request, false) },
                        enabled = enabled,
                        modifier = Modifier.weight(1f).testTag("tailscaleJoin.deny"),
                    ) { Text("Deny", color = if (enabled) c.danger else c.textMuted) }
                    Button(
                        onClick = { onDecide(request, true) },
                        enabled = enabled,
                        colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
                        modifier = Modifier.weight(1f).testTag("tailscaleJoin.approve"),
                    ) {
                        if (deciding == request.id) OmSpinner(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White)
                        else Text("Approve")
                    }
                }
            }
        }
    }
}

/** "Collector · via Tailscale · maya@example.com": what will join, how it asked, and the Tailscale account it asked as. */
internal fun tailscaleJoinViaLine(request: TailscaleJoinRequest): String =
    listOfNotNull(
        request.kind?.takeIf { it.isNotBlank() }?.let(DeviceKindMeta::label),
        "via Tailscale",
        request.login?.takeIf { it.isNotBlank() },
    ).joinToString(" · ").replaceFirstChar { it.uppercase() }

/** "On studio-mac (macOS)", from whatever the gateway knows of the Tailscale machine. */
internal fun tailscaleJoinMachineLine(request: TailscaleJoinRequest): String? {
    val machine = request.machine?.takeIf { it.isNotBlank() }
    val os = request.os?.takeIf { it.isNotBlank() }
    return when {
        machine != null && os != null -> "On $machine ($os)"
        machine != null -> "On $machine"
        else -> os
    }
}

/** "Asked 5m ago · expires in 5 min", or "Expired" once it ran out. */
internal fun tailscaleJoinTimingLine(request: TailscaleJoinRequest, now: Long): String {
    if (request.expired(now)) return "Expired"
    val asked = request.requestedAtMillis?.let { "Asked ${TimeFormat.relative(it, now)}" } ?: "Asked"
    val expiry = request.expiresAtMillis?.let { expiresAt ->
        val left = expiresAt - now
        val minutes = (left + 59_999) / 60_000
        when {
            left < 60_000 -> "expires in under a minute"
            minutes < 60 -> "expires in $minutes min"
            else -> "expires in ${(minutes + 59) / 60} h"
        }
    }
    return listOfNotNull(asked, expiry).joinToString(" · ")
}
