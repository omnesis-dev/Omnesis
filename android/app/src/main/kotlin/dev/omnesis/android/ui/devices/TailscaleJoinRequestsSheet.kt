// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.TimeFormat
import dev.omnesis.android.ui.common.gatewayErrorKind
import java.time.Instant
import kotlinx.coroutines.delay

/** What the sheet says about the list before any request. */
internal const val TAILSCALE_JOIN_EXPLANATION =
    "These devices on your Tailscale network asked to join this gateway. Approve only devices you recognize."

internal const val TAILSCALE_JOIN_EMPTY = "No devices are waiting."

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TailscaleJoinRequestsSheet(
    onDismiss: () -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: TailscaleJoinRequestsViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(vm) { vm.open() }
    // Keeps "5m ago" and the expiry current while the sheet stays open.
    LaunchedEffect(Unit) { while (true) { delay(15_000); now = System.currentTimeMillis() } }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        TailscaleJoinRequestsContent(
            state = state,
            now = now,
            onRefresh = vm::refresh,
            onDecide = vm::decide,
            onDismiss = onDismiss,
            onOpenSettings = { onDismiss(); onOpenSettings() },
        )
    }
}

@Composable
fun TailscaleJoinRequestsContent(
    state: TailscaleJoinRequestsViewModel.State,
    now: Long,
    onRefresh: () -> Unit,
    onDecide: (TailscaleJoinRequest, Boolean) -> Unit,
    onDismiss: () -> Unit,
    onOpenSettings: () -> Unit = {},
) {
    val c = OmTheme.colors
    LazyColumn(
        Modifier.fillMaxWidth().background(c.bgPrimary).padding(horizontal = OmSpacing.lg).testTag("tailscaleJoin.list"),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Waiting to join",
                    style = MaterialTheme.typography.titleLarge,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
                TextButton(onClick = onRefresh, enabled = !state.busy) { Text("Refresh", color = if (state.busy) c.textMuted else c.accent) }
                TextButton(onClick = onDismiss) { Text("Done", color = c.accent) }
            }
        }
        if (state.requests.isNotEmpty()) item {
            Text(TAILSCALE_JOIN_EXPLANATION, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
        }
        state.notice?.let { notice ->
            item { Text(notice, style = MaterialTheme.typography.bodyMedium, color = c.warning, modifier = Modifier.testTag("tailscaleJoin.notice")) }
        }
        val error = state.error
        if (error != null) item {
            if (state.requests.isEmpty()) {
                GatewayErrorView("review devices waiting to join", error, onRefresh, onOpenSettings, modifier = Modifier.fillMaxWidth().heightIn(min = 320.dp))
            } else {
                Text(gatewayErrorKind(error).title(), color = c.danger)
            }
        }
        if (!state.loaded && state.loading) item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                OmSpinner(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = c.accent)
                Text("Loading…", color = c.textSecondary)
            }
        }
        if (state.loaded && state.requests.isEmpty() && error == null) item {
            Text(TAILSCALE_JOIN_EMPTY, color = c.textSecondary, modifier = Modifier.testTag("tailscaleJoin.empty"))
        }
        items(state.requests, key = { it.id }) { request ->
            TailscaleJoinRequestCard(request, now, deciding = state.deciding, onDecide = onDecide)
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
private fun TailscaleJoinRequestCard(
    request: TailscaleJoinRequest,
    now: Long,
    deciding: String?,
    onDecide: (TailscaleJoinRequest, Boolean) -> Unit,
) {
    val c = OmTheme.colors
    val expired = isoMillis(request.expiresAt)?.let { it <= now } == true
    val enabled = deciding == null && !expired
    OmnesisCard(Modifier.fillMaxWidth().testTag("tailscaleJoin.request"), padding = OmSpacing.lg) {
        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                request.kind?.let { Icon(DeviceKindMeta.icon(it), contentDescription = null, tint = c.textSecondary, modifier = Modifier.size(20.dp)) }
                Text(request.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
            }
            tailscaleJoinMachineLine(request)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary) }
            request.login?.let { Text("Tailscale account $it", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary) }
            Text(
                if (expired) "Expired" else tailscaleJoinRequestedLine(request, now),
                style = MaterialTheme.typography.bodySmall,
                color = c.textMuted,
            )
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

/** "Collector · on maya-laptop (macOS)", from whatever the gateway knows of the device. */
internal fun tailscaleJoinMachineLine(request: TailscaleJoinRequest): String? {
    val machine = request.machine?.takeIf { it.isNotBlank() }
    val os = request.os?.takeIf { it.isNotBlank() }
    val where = when {
        machine != null && os != null -> "on $machine ($os)"
        machine != null -> "on $machine"
        else -> os
    }
    return listOfNotNull(request.kind?.takeIf { it.isNotBlank() }?.let(DeviceKindMeta::label), where)
        .joinToString(" · ")
        .ifEmpty { null }
}

internal fun tailscaleJoinRequestedLine(request: TailscaleJoinRequest, now: Long): String =
    isoMillis(request.requestedAt)?.let { "Requested ${TimeFormat.relative(it, now)}" } ?: "Requested"

private fun isoMillis(value: String): Long? = runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
