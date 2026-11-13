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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.ui.pairing.VerificationCode
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.gatewayErrorKind
import dev.omnesis.android.pairing.GatewayPairingApprovalController
import dev.omnesis.android.transport.dto.GatewayPairingApproving
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Everything said about a waiting device before its code. */
internal const val PAIRING_APPROVAL_TEXT =
    "A device signed in to your Omnesis account and is waiting for your approval to pair to this gateway. " +
        "Approve if the code below matches the code shown on the device."

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GatewayPairingApprovalSheet(
    client: GatewayPairingApproving,
    onOpenSettings: () -> Unit = {},
    /** Told what is still waiting after every read or decision, so a banner elsewhere stays current. */
    onRequests: (List<GatewayPairingApprovalRequest>) -> Unit = {},
    onDismiss: () -> Unit,
) {
    val controller = remember(client) { GatewayPairingApprovalController() }
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(controller) { controller.refresh(client) }
    LaunchedEffect(controller) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    LaunchedEffect(state.requests, state.busy, state.error) { if (!state.busy && state.error == null) onRequests(state.requests) }
    DisposableEffect(controller) { onDispose { controller.stop() } }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        GatewayPairingApprovalContent(state, now,
            onRefresh = { scope.launch { controller.refresh(client) } },
            onDecide = { request, approve -> scope.launch { if (approve) controller.confirmAndApprove(request, client) else controller.decide(request, false, client) } },
            onDismiss = onDismiss, onOpenSettings = { onDismiss(); onOpenSettings() },
            onTrustSignIn = controller::setTrustSignIn)
    }
}

@Composable
fun GatewayPairingApprovalContent(
    state: GatewayPairingApprovalController.State,
    now: Long,
    onRefresh: () -> Unit,
    onDecide: (GatewayPairingApprovalRequest, Boolean) -> Unit,
    onDismiss: () -> Unit,
    onOpenSettings: () -> Unit = {},
    onTrustSignIn: (String, Boolean) -> Unit = { _, _ -> },
) {
    val c = OmTheme.colors
    LazyColumn(
        Modifier.fillMaxWidth().background(c.bgPrimary).padding(horizontal = OmSpacing.lg).testTag("pairingApproval.list"),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Pairing requests", style = MaterialTheme.typography.titleLarge, color = c.textPrimary, modifier = Modifier.weight(1f).semantics { heading() })
                TextButton(onClick = onRefresh, enabled = !state.busy) { Text("Refresh", color = if (state.busy) c.textMuted else c.accent) }
                TextButton(onClick = onDismiss) { Text("Done", color = c.accent) }
            }
        }
        state.error?.let { error -> item {
            if (state.requests.isEmpty()) GatewayErrorView("manage pairing requests", error, onRefresh, onOpenSettings,
                modifier = Modifier.fillMaxWidth().height(360.dp))
            else Text(gatewayErrorKind(error).title(), color = c.danger)
        } }
        if (state.busy) item { Text("Updating…", color = c.textSecondary) }
        if (state.requests.isEmpty() && !state.busy && state.error == null) item { Text("No pending pairing requests.", color = c.textSecondary) }
        items(state.requests, key = { it.requestId }) { request ->
            OmnesisCard(Modifier.fillMaxWidth().testTag("pairingApproval.request"), padding = OmSpacing.lg) {
                Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                    Text(request.name, style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                    Text(
                        listOfNotNull(DeviceKindMeta.label(request.kind), deviceSignInMethod(request.signIn)).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textSecondary,
                    )
                    if (request.status == "pending" && request.expiresAt > now) {
                        Text(PAIRING_APPROVAL_TEXT, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary, modifier = Modifier.testTag("pairingApproval.explanation"))
                        VerificationCode(request.verificationCode, Modifier.fillMaxWidth().padding(vertical = OmSpacing.sm).testTag("pairingApproval.code"), TextAlign.Center)
                        if (request.canTrustSignIn) {
                            val trusted = request.requestId in state.trustSignIn
                            Row(
                                Modifier.fillMaxWidth().testTag("pairingApproval.trust").toggleable(
                                    value = trusted,
                                    enabled = !state.busy,
                                    role = Role.Switch,
                                    onValueChange = { onTrustSignIn(request.requestId, it) },
                                ),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("Trust this sign-in from now on", Modifier.weight(1f), color = c.textPrimary)
                                Switch(checked = trusted, onCheckedChange = null, enabled = !state.busy)
                            }
                        }
                        Button(
                            onClick = { onDecide(request, true) },
                            enabled = !state.busy,
                            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
                            modifier = Modifier.fillMaxWidth().testTag("pairingApproval.approve"),
                        ) { Text("Approve") }
                        OutlinedButton(
                            onClick = { onDecide(request, false) },
                            enabled = !state.busy,
                            modifier = Modifier.fillMaxWidth().testTag("pairingApproval.deny"),
                        ) { Text("Deny", color = if (state.busy) c.textMuted else c.danger) }
                    } else {
                        VerificationCode(request.verificationCode, Modifier.fillMaxWidth().padding(vertical = OmSpacing.sm).testTag("pairingApproval.code"), TextAlign.Center)
                        Text(if (request.expiresAt <= now) "Expired" else request.status.replaceFirstChar { it.uppercase() }, color = c.textSecondary)
                    }
                }
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}
