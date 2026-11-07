// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.gatewayErrorKind
import dev.omnesis.android.pairing.GatewayPairingApprovalController
import dev.omnesis.android.transport.dto.GatewayPairingApproving
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GatewayPairingApprovalSheet(client: GatewayPairingApproving, onOpenSettings: () -> Unit = {}, onDismiss: () -> Unit) {
    val controller = remember(client) { GatewayPairingApprovalController() }
    val state by controller.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(controller) { controller.refresh(client) }
    LaunchedEffect(controller) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    DisposableEffect(controller) { onDispose { controller.stop() } }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        GatewayPairingApprovalContent(state, now, onCompare = controller::setCompared,
            onRefresh = { scope.launch { controller.refresh(client) } },
            onDecide = { request, approve -> scope.launch { controller.decide(request, approve, client) } },
            onDismiss = onDismiss, onOpenSettings = { onDismiss(); onOpenSettings() })
    }
}

@Composable
fun GatewayPairingApprovalContent(
    state: GatewayPairingApprovalController.State,
    now: Long,
    onCompare: (String, Boolean) -> Unit,
    onRefresh: () -> Unit,
    onDecide: (GatewayPairingApprovalRequest, Boolean) -> Unit,
    onDismiss: () -> Unit,
    onOpenSettings: () -> Unit = {},
) {
    LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 24.dp).testTag("pairingApproval.list"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Pairing requests", style = MaterialTheme.typography.titleLarge)
            Text("Compare every code group with the new device through an already trusted connection to your gateway. You can also use the gateway’s local portal or terminal. Approve only a device you are pairing now.")
            Row {
                TextButton(onClick = onRefresh, enabled = !state.busy) { Text("Refresh") }
                TextButton(onClick = onDismiss) { Text("Done") }
            }
        }
        state.error?.let { error -> item {
            if (state.requests.isEmpty()) GatewayErrorView("manage pairing requests", error, onRefresh, onOpenSettings,
                modifier = Modifier.fillMaxWidth().height(360.dp))
            else Text(gatewayErrorKind(error).title(), color = MaterialTheme.colorScheme.error)
        } }
        if (state.busy) item { Text("Updating…") }
        if (state.requests.isEmpty() && !state.busy && state.error == null) item { Text("No pending pairing requests.") }
        items(state.requests, key = { it.requestId }) { request ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(request.name, style = MaterialTheme.typography.titleMedium)
                Text(request.kind)
                Text(request.verificationCode, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("pairingApproval.code"))
                if (request.status == "pending" && request.expiresAt > now) {
                    val compared = state.compared[request.requestId] == request.verificationCode
                    Row {
                        Checkbox(checked = compared, enabled = !state.busy, onCheckedChange = { onCompare(request.requestId, it) },
                            modifier = Modifier.testTag("pairingApproval.compare"))
                        Text("I compared every group with the new device and they match", Modifier.weight(1f))
                    }
                    Button(onClick = { onDecide(request, true) }, enabled = compared && !state.busy,
                        modifier = Modifier.testTag("pairingApproval.approve")) { Text("Approve device") }
                    TextButton(onClick = { onDecide(request, false) }, enabled = !state.busy) { Text("Reject request") }
                } else Text(if (request.expiresAt <= now) "Expired" else request.status.replaceFirstChar { it.uppercase() })
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}
