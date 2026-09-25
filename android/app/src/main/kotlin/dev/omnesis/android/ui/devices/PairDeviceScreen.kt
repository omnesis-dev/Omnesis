// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.NetworkIdentity
import dev.omnesis.android.transport.dto.PendingPairing
import dev.omnesis.android.transport.dto.DeviceRecord

/**
 * Pair-a-new-device surface — Android counterpart of the iOS `PairDeviceView`
 * and a port of the portal's "Pair a new device" section. The gateway mints a
 * one-time pairing code (`POST /admin/devices/pair`); we render the code AND a
 * scannable QR generated from the server-encoded payload
 * (`POST /admin/devices/pair-qr`). The user picks which network identity bakes
 * into the QR's `gatewayUrl` from `GET /admin/network-identities`.
 *
 * The form is the kind picker and the generate action: the gateway grants each
 * kind its canonical scopes, so nothing else is chosen here. Credentials with
 * custom scopes are issued from the CLI.
 */
@Composable
fun PairDeviceContent(
    pending: PendingPairing?,
    kind: String?,
    gatewayUrl: String? = null,
    identities: List<NetworkIdentity>,
    selectedHostIdx: Int,
    qrPayload: String?,
    qrError: String?,
    submitting: Boolean,
    error: String?,
    onPair: (kind: String) -> Unit,
    onSelectHost: (Int) -> Unit,
    repairTarget: DeviceRecord? = null,
) {
    if (pending != null) {
        PairingResultContent(
            pending = pending,
            kind = kind,
            gatewayUrl = gatewayUrl,
            identities = identities,
            selectedHostIdx = selectedHostIdx,
            qrPayload = qrPayload,
            qrError = qrError,
            onSelectHost = onSelectHost,
            repairTarget = repairTarget,
        )
    } else {
        if (repairTarget != null) {
            RepairDeviceForm(
                device = repairTarget,
                submitting = submitting,
                error = error,
                onRepair = { onPair(repairTarget.kind) },
            )
        } else PairDeviceForm(
            submitting = submitting,
            error = error,
            onPair = onPair,
        )
    }
}

@Composable
private fun RepairDeviceForm(
    device: DeviceRecord,
    submitting: Boolean,
    error: String?,
    onRepair: () -> Unit,
) {
    val c = OmTheme.colors
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.lg),
    ) {
        Text(
            "Repair ${device.name}",
            style = MaterialTheme.typography.titleMedium,
            color = c.textPrimary,
        )
        Text(
            "This code is bound to ${device.name}. Re-pairing keeps its device identity, " +
                "sources, memberships, cursors, and existing data.",
            fontSize = 13.sp,
            color = c.textSecondary,
        )
        if (error != null) Text(error, fontSize = 12.sp, color = c.danger)
        Button(
            onClick = onRepair,
            enabled = !submitting,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
        ) {
            if (submitting) {
                OmSpinner(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White)
                Spacer(Modifier.size(8.dp))
            }
            Text(if (submitting) "Generating…" else "Generate repair code", fontWeight = FontWeight.SemiBold)
        }
    }
}

/**
 * Kinds the app offers to pair: the portal's list, less `integration` — an
 * integration's access level is chosen with its code, which only a portal
 * session may do.
 */
internal val PAIR_KINDS: List<String> =
    listOf("collector", "cli", "portal", "ios", "android", "agent", "browser")

internal fun agentConnectCommands(gatewayUrl: String?, pairingCode: String): List<String> {
    val gateway = gatewayUrl?.trim()?.trimEnd('/')?.takeIf(String::isNotEmpty) ?: "<gateway-url>"
    return listOf("openclaw", "hermes").map {
        "omnesis connect $it --gateway-url $gateway --code $pairingCode"
    }
}

@Composable
private fun PairDeviceForm(
    submitting: Boolean,
    error: String?,
    onPair: (kind: String) -> Unit,
) {
    val c = OmTheme.colors
    var kind by remember { mutableStateOf("ios") }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.lg),
    ) {
        Text(
            "The gateway returns a one-time pairing code (10-min TTL) and a QR. The new device scans the QR — " +
                "or exchanges the code via POST /devices/pair — for a real token.",
            fontSize = 13.sp,
            color = c.textSecondary,
        )

        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text("Kind", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.textSecondary)
            KindDropdown(kind = kind, enabled = !submitting, kinds = PAIR_KINDS) {
                kind = it
            }
        }

        if (error != null) {
            Text(error, fontSize = 12.sp, color = c.danger)
        }

        Button(
            onClick = { onPair(kind) },
            enabled = !submitting,
            modifier = Modifier.fillMaxWidth().height(48.dp),
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
        ) {
            if (submitting) {
                OmSpinner(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = Color.White)
                Spacer(Modifier.size(8.dp))
            }
            Text(if (submitting) "Generating…" else "Generate pairing code", fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun KindDropdown(
    kind: String,
    enabled: Boolean,
    kinds: List<String>,
    onSelect: (String) -> Unit,
) {
    val c = OmTheme.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(OmRadius.medium))
                .background(c.bgSecondary)
                .border(1.dp, c.border, RoundedCornerShape(OmRadius.medium))
                .then(if (enabled) Modifier.clickable { open = true } else Modifier)
                .padding(horizontal = OmSpacing.sm, vertical = 12.dp),
        ) {
            Text(DeviceKindMeta.label(kind), fontSize = 14.sp, color = c.textPrimary, modifier = Modifier.weight(1f))
            Icon(Icons.Outlined.ArrowDropDown, contentDescription = null, tint = c.textMuted)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            kinds.forEach { k ->
                DropdownMenuItem(
                    text = { Text(DeviceKindMeta.label(k), color = c.textPrimary) },
                    onClick = { onSelect(k); open = false },
                )
            }
        }
    }
}

@Composable
private fun PairingResultContent(
    pending: PendingPairing,
    kind: String?,
    gatewayUrl: String?,
    identities: List<NetworkIdentity>,
    selectedHostIdx: Int,
    qrPayload: String?,
    qrError: String?,
    onSelectHost: (Int) -> Unit,
    repairTarget: DeviceRecord?,
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Text("PAIRING CODE", fontSize = 10.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp, color = c.textMuted)
            Text(pending.pairingCode, fontSize = 22.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = c.textPrimary)
            // The countdown derives from the live wall clock, which would make a
            // screenshot golden non-deterministic (the rendered seconds tick
            // between a record and a verify run). Under LocalInspectionMode
            // (Roborazzi / @Preview) freeze it to a representative value so the
            // tracked golden is stable; production shows the real countdown.
            val remaining =
                if (LocalInspectionMode.current) {
                    540L
                } else {
                    ((pending.expiresAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
                }
            Text(
                if (remaining > 0) "expires in ${remaining}s" else "expired — generate a new code",
                fontSize = 12.sp,
                color = if (remaining > 0) c.textMuted else c.danger,
            )
        }

        if (DeviceKindMeta.usesQr(kind)) {
            if (identities.size > 1) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
                    Text(
                        if (repairTarget == null) "Address the new device will connect to" else "Address ${repairTarget.name} will connect to",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = c.textSecondary,
                    )
                    HostDropdown(identities, selectedHostIdx, onSelectHost)
                }
            }

            Text(
                repairTarget?.let { "Scan with the Omnesis app on ${it.name}" }
                    ?: "Scan with the Omnesis app on the new device",
                fontSize = 13.sp,
                color = c.textSecondary,
            )
            when {
                qrPayload != null -> {
                    QrCodeView(payload = qrPayload)
                    ManualPayload(payload = qrPayload)
                }
                qrError != null -> Box(Modifier.size(220.dp), contentAlignment = Alignment.Center) {
                    Text("Couldn't build QR: $qrError", color = c.danger, textAlign = TextAlign.Center)
                }
                else -> Box(Modifier.size(220.dp), contentAlignment = Alignment.Center) {
                    OmSpinner(color = c.accent)
                }
            }
        } else if (kind == "agent") {
            Column(
                Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            ) {
                if (identities.size > 1) {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
                        Text("Address the agent host will connect to", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.textSecondary)
                        HostDropdown(identities, selectedHostIdx, onSelectHost)
                    }
                }
                Text(
                    "Run one command on the agent host. The pairing code is single-use.",
                    fontSize = 13.sp,
                    color = c.textSecondary,
                )
                agentConnectCommands(
                    agentGatewayUrl(gatewayUrl, identities.map { it.address }, selectedHostIdx),
                    pending.pairingCode,
                ).forEach { command ->
                    SelectionContainer {
                        Text(
                            command,
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            color = c.textPrimary,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(OmRadius.medium))
                                .background(c.bgSecondary)
                                .padding(OmSpacing.sm),
                        )
                    }
                }
            }
        } else {
            Text(
                repairTarget?.let {
                    "On ${it.name}, use the normal repair or pairing screen to redeem this bound code."
                } ?: "On the new device, exchange this code for a token — e.g. run `omnesis devices pair` " +
                    "and enter the code, or POST it to /devices/pair.",
                fontSize = 13.sp,
                color = c.textSecondary,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** The raw pairing payload (the QR's contents) with a tap-to-copy affordance, for manual entry. */
@Composable
private fun ManualPayload(payload: String) {
    val c = OmTheme.colors
    val clipboard = LocalClipboardManager.current
    var copied by remember(payload) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Or paste this payload manually", fontSize = 12.sp, color = c.textSecondary, modifier = Modifier.weight(1f))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier
                    .clip(RoundedCornerShape(OmRadius.medium))
                    .clickable {
                        clipboard.setText(AnnotatedString(payload))
                        copied = true
                    }
                    .padding(horizontal = OmSpacing.sm, vertical = 4.dp),
            ) {
                Icon(
                    if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
                    contentDescription = "Copy pairing payload",
                    tint = c.accent,
                    modifier = Modifier.size(14.dp),
                )
                Text(if (copied) "Copied" else "Copy", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = c.accent)
            }
        }
        Text(
            payload,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            color = c.textMuted,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// See #2758 — planned: take the address from /admin/devices/pair-addresses.
@Composable
private fun HostDropdown(identities: List<NetworkIdentity>, selectedIdx: Int, onSelect: (Int) -> Unit) {
    val c = OmTheme.colors
    var open by remember { mutableStateOf(false) }
    val chosen = identities[selectedIdx.coerceIn(0, identities.size - 1)]
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(OmRadius.medium))
                .background(c.bgSecondary)
                .border(1.dp, c.border, RoundedCornerShape(OmRadius.medium))
                .clickable { open = true }
                .padding(horizontal = OmSpacing.sm, vertical = 12.dp),
        ) {
            Text(
                "${chosen.address} — ${chosen.label}${if (chosen.offLan) " (off-LAN)" else ""}",
                fontSize = 13.sp,
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
            )
            Icon(Icons.Outlined.ArrowDropDown, contentDescription = null, tint = c.textMuted)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            identities.forEachIndexed { idx, h ->
                DropdownMenuItem(
                    text = {
                        Text(
                            "${h.address} — ${h.label}${if (h.offLan) " (off-LAN)" else ""}",
                            color = c.textPrimary,
                        )
                    },
                    onClick = { onSelect(idx); open = false },
                )
            }
        }
    }
}
