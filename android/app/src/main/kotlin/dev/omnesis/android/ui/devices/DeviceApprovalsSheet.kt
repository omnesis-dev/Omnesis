// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import android.content.Intent
import android.net.Uri
import dev.omnesis.android.transport.dto.CloudRelayManaging
import dev.omnesis.android.ui.common.StepUpRefusal
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
import androidx.compose.ui.platform.LocalContext
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
import dev.omnesis.android.pairing.GatewayPasskeySigner
import dev.omnesis.android.ui.pairing.defaultGatewayPasskeySigner
import dev.omnesis.android.transport.dto.GatewayPairingApproving
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The words for a device that waits for the owner's OK. iOS and the portal use the same ones. */
internal const val PAIRING_APPROVAL_TITLE = "Waiting for your OK"
internal const val PAIRING_APPROVAL_EMPTY = "No devices are waiting for your OK."
internal const val PAIRING_APPROVAL_REVOKED = "You removed this device before. Approve only if it's back in your hands."
internal const val PAIRING_APPROVAL_REMEMBER_DETAIL = "Next time you sign in with it in the Omnesis app, your device connects without asking."
internal const val PAIRING_APPROVAL_DENIED = "Denied. If you didn't try to connect a device, someone may know your Google password."
internal const val PAIRING_APPROVAL_ASK_FIRST = "Make new devices always ask me"
internal const val PAIRING_APPROVAL_ASKING_FIRST = "New devices now always ask you first."
internal const val PAIRING_APPROVAL_OTHER_GOOGLE_ACCOUNT = "This isn't the Google account you connected with, so it can't be remembered."

internal fun pairingApprovalHeadline(name: String) = "$name wants to connect"

/** The question above the code, naming the device the owner should look at by its own name. */
internal fun pairingApprovalQuestion(name: String) = "Does $name show this code?"

/** "Remember this Google account" or "Remember this passkey": the sign-in, not the device. */
internal fun pairingApprovalRemember(signIn: String?) = if (signIn == "passkey") "Remember this passkey" else "Remember this Google account"

/** The named request first, the others in the gateway's order. */
internal fun pairingRequestsInOrder(requests: List<GatewayPairingApprovalRequest>, focus: String?) =
    requests.filter { it.requestId == focus } + requests.filter { it.requestId != focus }

/** Whether the Devices screen offers its approvals entry: sign-in requests, or a gateway that serves Tailscale joins. */
internal fun deviceApprovalsOffered(signIns: GatewayPairingApproving?, tailscaleAvailable: Boolean?): Boolean =
    signIns != null || tailscaleAvailable == true

/**
 * The Tailscale joins the approvals sheet shows. Beside sign-in requests only once the gateway
 * answered that it serves them, so on a gateway without the feature the sheet is exactly the
 * sign-in one; alone from the first read, so its loading and errors show.
 */
internal fun shownTailscaleJoins(
    signIns: GatewayPairingApprovalController.State?,
    joins: TailscaleJoinRequestsViewModel.State?,
): TailscaleJoinRequestsViewModel.State? =
    joins?.takeIf { it.available == true || (signIns == null && it.available != false) }

/**
 * Every device waiting for the owner's OK, however it asked: devices that signed in with the
 * Omnesis account ([client]; null where this build or phone does not review them), and devices on
 * the owner's Tailscale network that asked to join ([tailscale]; null where this phone does not
 * review them). Each kind keeps its own reads and decisions; the sheet lists them together.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeviceApprovalsSheet(
    client: GatewayPairingApproving?,
    onOpenSettings: () -> Unit = {},
    /** Told what sign-in requests still wait after every read or decision, so a banner elsewhere stays current. */
    onRequests: (List<GatewayPairingApprovalRequest>) -> Unit = {},
    /** Signs the gateway's passkey ceremony in this app; null in a build that can't. */
    passkey: GatewayPasskeySigner? = LocalContext.current.let { context -> remember(context) { defaultGatewayPasskeySigner(context) } },
    /** The sign-in request a notification named, listed first. */
    focus: String? = null,
    tailscale: TailscaleJoinRequestsViewModel? = null,
    /** Told what Tailscale joins still wait after every read or decision, for the same banner. */
    onTailscaleRequests: (List<TailscaleJoinRequest>) -> Unit = {},
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val controller = remember(client, passkey) { GatewayPairingApprovalController(passkey = passkey) }
    val state by controller.state.collectAsStateWithLifecycle()
    val joins = tailscale?.state?.collectAsStateWithLifecycle()?.value
    val scope = rememberCoroutineScope()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(controller) { client?.let { controller.refresh(it) } }
    LaunchedEffect(tailscale) { tailscale?.open() }
    LaunchedEffect(controller) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    LaunchedEffect(state.requests, state.busy, state.error) { if (client != null && !state.busy && state.error == null) onRequests(state.requests) }
    LaunchedEffect(joins) { if (joins != null && joins.loaded && !joins.busy && joins.error == null) onTailscaleRequests(joins.requests) }
    DisposableEffect(controller) { onDispose { controller.stop() } }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        DeviceApprovalsContent(state.takeIf { client != null }, now,
            onRefresh = {
                client?.let { scope.launch { controller.refresh(it) } }
                tailscale?.refresh()
            },
            onDecide = { request, approve ->
                client?.let { scope.launch { if (approve) controller.confirmAndApprove(request, it) else controller.decide(request, false, it) } }
            },
            onDismiss = onDismiss, onOpenSettings = { onDismiss(); onOpenSettings() },
            onTrustSignIn = controller::setTrustSignIn,
            onApproveWithPasskey = { request -> client?.let { scope.launch { controller.confirmAndApproveWithPasskey(request, it) } } },
            focus = focus,
            stepUpPage = { requestId -> client?.approvalPage(requestId) },
            onOpenPage = { url -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
            onAskFirst = (client as? CloudRelayManaging)?.let { policy -> fun() { scope.launch { controller.askFirst(policy) } } },
            joins = joins,
            onDecideJoin = { request, approve -> tailscale?.decide(request, approve) })
    }
}

/**
 * The approvals list. [state] is the sign-in requests, null where this phone does not review
 * them; [joins] the Tailscale ones, null likewise. With [joins] null or not served, it is exactly
 * the sign-in list.
 */
@Composable
fun DeviceApprovalsContent(
    state: GatewayPairingApprovalController.State?,
    now: Long,
    onRefresh: () -> Unit,
    onDecide: (GatewayPairingApprovalRequest, Boolean) -> Unit,
    onDismiss: () -> Unit,
    onOpenSettings: () -> Unit = {},
    onTrustSignIn: (String, Boolean) -> Unit = { _, _ -> },
    onApproveWithPasskey: (GatewayPairingApprovalRequest) -> Unit = {},
    focus: String? = null,
    /** The gateway's own approval page for a request, for a phone asked to confirm it's the owner. */
    stepUpPage: (String) -> String? = { null },
    onOpenPage: (String) -> Unit = {},
    /** Makes every new device ask first; null where this client can't change it. */
    onAskFirst: (() -> Unit)? = null,
    joins: TailscaleJoinRequestsViewModel.State? = null,
    onDecideJoin: (TailscaleJoinRequest, Boolean) -> Unit = { _, _ -> },
) {
    val c = OmTheme.colors
    val shownJoins = shownTailscaleJoins(state, joins)
    val joinRequests = shownJoins?.requests.orEmpty()
    val busy = state?.busy == true || shownJoins?.busy == true
    val noRows = state?.requests.orEmpty().isEmpty() && joinRequests.isEmpty()
    // Both reads failing, as when the gateway is unreachable, says so once.
    val joinsError = shownJoins?.error?.takeIf { state?.error == null }
    LazyColumn(
        Modifier.fillMaxWidth().background(c.bgPrimary).padding(horizontal = OmSpacing.lg).testTag("pairingApproval.list"),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(PAIRING_APPROVAL_TITLE, style = MaterialTheme.typography.titleLarge, color = c.textPrimary, modifier = Modifier.weight(1f).semantics { heading() })
                TextButton(onClick = onRefresh, enabled = !busy) { Text("Refresh", color = if (busy) c.textMuted else c.accent) }
                TextButton(onClick = onDismiss) { Text("Done", color = c.accent) }
            }
        }
        state?.error?.let { error -> item {
            if (noRows) GatewayErrorView("manage pairing requests", error, onRefresh, onOpenSettings,
                modifier = Modifier.fillMaxWidth().height(360.dp))
            else Text(gatewayErrorKind(error).title(), color = c.danger)
        } }
        joinsError?.let { error -> item {
            if (noRows) GatewayErrorView("review devices waiting to join", error, onRefresh, onOpenSettings,
                modifier = Modifier.fillMaxWidth().height(360.dp))
            else Text(gatewayErrorKind(error).title(), color = c.danger, modifier = Modifier.testTag("tailscaleJoin.error"))
        } }
        if (busy) item { Text("Updating…", color = c.textSecondary) }
        state?.denied?.let { denied -> item { DeniedFollowUp(denied, state, onAskFirst) } }
        shownJoins?.notice?.let { notice -> item {
            Text(notice, style = MaterialTheme.typography.bodyMedium, color = c.warning, modifier = Modifier.testTag("tailscaleJoin.notice"))
        } }
        if (noRows && !busy && state?.error == null && joinsError == null) item { Text(PAIRING_APPROVAL_EMPTY, color = c.textSecondary) }
        if (state != null) items(pairingRequestsInOrder(state.requests, focus), key = { it.requestId }) { request ->
            SignInRequestCard(request, state, now, onDecide, onTrustSignIn, onApproveWithPasskey, stepUpPage, onOpenPage)
        }
        items(joinRequests, key = { "tailscale:${it.id}" }) { request ->
            TailscaleJoinRequestCard(request, now, deciding = shownJoins?.deciding, onDecide = onDecideJoin)
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

/** A device that signed in with the Omnesis account: its code to compare, and the decision. */
@Composable
private fun SignInRequestCard(
    request: GatewayPairingApprovalRequest,
    state: GatewayPairingApprovalController.State,
    now: Long,
    onDecide: (GatewayPairingApprovalRequest, Boolean) -> Unit,
    onTrustSignIn: (String, Boolean) -> Unit,
    onApproveWithPasskey: (GatewayPairingApprovalRequest) -> Unit,
    stepUpPage: (String) -> String?,
    onOpenPage: (String) -> Unit,
) {
    val c = OmTheme.colors
    OmnesisCard(Modifier.fillMaxWidth().testTag("pairingApproval.request"), padding = OmSpacing.lg) {
        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Text(pairingApprovalHeadline(request.name), style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
            Text(
                listOfNotNull(DeviceKindMeta.label(request.kind), deviceSignInMethod(request.signIn)?.let { "signed in with $it" }, request.signInEmail).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
            if (request.revokedDevice) Text(PAIRING_APPROVAL_REVOKED, style = MaterialTheme.typography.bodyMedium, color = c.danger, modifier = Modifier.testTag("pairingApproval.revoked"))
            if (request.status == "pending" && request.expiresAt > now) {
                Text(pairingApprovalQuestion(request.name), style = MaterialTheme.typography.bodyMedium, color = c.textPrimary, modifier = Modifier.testTag("pairingApproval.explanation"))
                VerificationCode(request.verificationCode, Modifier.fillMaxWidth().padding(vertical = OmSpacing.sm).testTag("pairingApproval.code"), TextAlign.Center, large = true)
                if (request.otherGoogleAccount) Text(PAIRING_APPROVAL_OTHER_GOOGLE_ACCOUNT, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                else if (request.canTrustSignIn) {
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
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(pairingApprovalRemember(request.signIn), color = c.textPrimary)
                            // The address Google verified for the gateway, large: the owner checks it is theirs.
                            request.signInEmail?.let { Text(it, style = MaterialTheme.typography.titleMedium, color = c.textPrimary) }
                            Text(PAIRING_APPROVAL_REMEMBER_DETAIL, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                        }
                        Switch(checked = trusted, onCheckedChange = null, enabled = !state.busy)
                    }
                }
                Button(
                    onClick = { onDecide(request, true) },
                    enabled = !state.busy,
                    colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
                    modifier = Modifier.fillMaxWidth().testTag("pairingApproval.approve"),
                ) { Text(if (state.stepUpRequired) "Yes, approve with fingerprint" else "Yes, approve") }
                // As on the portal: the owner's passkey, confirmed on this gateway, approves
                // exactly this request. A portal's request is approved only in its browser.
                if (state.passkeyApproval && request.kind != "portal") OutlinedButton(
                    onClick = { onApproveWithPasskey(request) },
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth().testTag("pairingApproval.approveWithPasskey"),
                ) { Text("Approve with fingerprint", color = if (state.busy) c.textMuted else c.accent) }
                OutlinedButton(
                    onClick = { onDecide(request, false) },
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth().testTag("pairingApproval.deny"),
                ) { Text("No, deny", color = if (state.busy) c.textMuted else c.danger) }
                state.stepUp?.takeIf { it.requestId == request.requestId }?.let { stepUp ->
                    StepUpNotice(stepUp, request, state, stepUpPage(request.requestId), onOpenPage, onApproveWithPasskey)
                }
            } else {
                VerificationCode(request.verificationCode, Modifier.fillMaxWidth().padding(vertical = OmSpacing.sm).testTag("pairingApproval.code"), TextAlign.Center)
                Text(if (request.expiresAt <= now) "Expired" else request.status.replaceFirstChar { it.uppercase() }, color = c.textSecondary)
            }
        }
    }
}
/**
 * The gateway wants the owner's passkey before it takes this approval from this phone. The app
 * signs the gateway's own approval ceremony when it can; otherwise the gateway's page in the
 * browser takes it. During a security lock nothing on this phone can.
 */
@Composable
private fun StepUpNotice(
    stepUp: GatewayPairingApprovalController.StepUp,
    request: GatewayPairingApprovalRequest,
    state: GatewayPairingApprovalController.State,
    page: String?,
    onOpenPage: (String) -> Unit,
    onApproveWithPasskey: (GatewayPairingApprovalRequest) -> Unit,
) {
    val c = OmTheme.colors
    val refusal = if (stepUp.unavailable) StepUpRefusal.UNAVAILABLE else StepUpRefusal.REQUIRED
    Column(Modifier.fillMaxWidth().testTag("pairingApproval.stepUp"), verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        Text(refusal.title, style = MaterialTheme.typography.titleSmall, color = c.warning)
        Text(refusal.message, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
        if (refusal == StepUpRefusal.REQUIRED) {
            if (state.passkeyApproval && request.kind != "portal") Button(
                onClick = { onApproveWithPasskey(request) },
                enabled = !state.busy,
                colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
                modifier = Modifier.fillMaxWidth().testTag("pairingApproval.stepUp.passkey"),
            ) { Text("Confirm with fingerprint") }
            else if (page != null) OutlinedButton(
                onClick = { onOpenPage(page) },
                modifier = Modifier.fillMaxWidth().testTag("pairingApproval.stepUp.open"),
            ) { Text(refusal.action ?: "", color = c.accent) }
        }
    }
}

/** Right after a denial: the owner may not have started that sign-in at all. */
@Composable
private fun DeniedFollowUp(denied: GatewayPairingApprovalRequest, state: GatewayPairingApprovalController.State, onAskFirst: (() -> Unit)?) {
    val c = OmTheme.colors
    OmnesisCard(Modifier.fillMaxWidth().testTag("pairingApproval.denied"), padding = OmSpacing.lg) {
        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Text(if (denied.signIn == "google") PAIRING_APPROVAL_DENIED else "Denied.", color = c.textPrimary)
            if (state.askingFirst) Text(PAIRING_APPROVAL_ASKING_FIRST, color = c.success)
            else if (onAskFirst != null) OutlinedButton(
                onClick = onAskFirst,
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth().testTag("pairingApproval.askFirst"),
            ) { Text(PAIRING_APPROVAL_ASK_FIRST, color = c.accent) }
        }
    }
}
