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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.AwayFromHomeHint
import dev.omnesis.android.transport.dto.PairingAddressOption
import dev.omnesis.android.transport.dto.PairingAddressPlan
import dev.omnesis.android.transport.dto.PendingPairing
import dev.omnesis.android.transport.dto.DeviceRecord

/**
 * Pair-a-new-device surface — Android counterpart of the iOS `PairDeviceView`
 * and a port of the portal's "Pair a new device" section. The gateway mints a
 * one-time pairing code (`POST /admin/devices/pair`); we render the code AND a
 * scannable QR generated from the server-encoded payload
 * (`POST /admin/devices/pair-qr`). For a phone the gateway judges every address
 * it could put in the code (`POST /admin/devices/pair-addresses`): the screen
 * opens on its recommendation, offers the other usable addresses with where each
 * works, and names the ones that phone cannot use with the reason. The labels,
 * summaries and reasons are the gateway's. An agent's setup commands name an address
 * from the same plan.
 *
 * The form is the kind picker and the generate action: the gateway grants each
 * kind its canonical scopes, so nothing else is chosen here. Credentials with
 * custom scopes are issued from the CLI.
 */
@Composable
fun PairDeviceContent(
    pending: PendingPairing?,
    kind: String?,
    qrPayload: String?,
    qrError: String?,
    submitting: Boolean,
    error: String?,
    onPair: (kind: String) -> Unit,
    repairTarget: DeviceRecord? = null,
    /** The gateway's addresses for the device the code is for; null while it is being asked. */
    addressPlan: PairingAddressPlan? = null,
    planError: String? = null,
    selectedUrl: String? = null,
    onSelectAddress: (String) -> Unit = {},
    /** Opens both disclosures from the start, for a render that shows everything. */
    expanded: Boolean = false,
) {
    if (pending != null) {
        PairingResultContent(
            pending = pending,
            kind = kind,
            qrPayload = qrPayload,
            qrError = qrError,
            repairTarget = repairTarget,
            addressPlan = addressPlan,
            planError = planError,
            selectedUrl = selectedUrl,
            onSelectAddress = onSelectAddress,
            expanded = expanded,
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
internal fun RepairDeviceForm(
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
internal fun PairDeviceForm(
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

/** Only a phone or an agent is told which address to use. */
internal fun pairingChoosesAddress(kind: String?): Boolean = DeviceKindMeta.usesQr(kind) || kind == "agent"

@Composable
private fun PairingResultContent(
    pending: PendingPairing,
    kind: String?,
    qrPayload: String?,
    qrError: String?,
    repairTarget: DeviceRecord?,
    addressPlan: PairingAddressPlan?,
    planError: String?,
    selectedUrl: String?,
    onSelectAddress: (String) -> Unit,
    expanded: Boolean,
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

        if (pairingChoosesAddress(kind)) {
            PairAddressed(pending.pairingCode, kind, addressPlan, planError, selectedUrl, qrPayload, qrError, onSelectAddress, repairTarget, expanded)
        } else {
            CodeInstructions(kind, gatewayUrl = null, pending.pairingCode, repairTarget)
        }
    }
}

/**
 * The address the code is for, as the portal's dialog shows it: the gateway's recommended
 * address and where it works, its other usable addresses to choose from, and the ones this
 * device cannot use with the gateway's reason. A phone gets the QR for the chosen address; an
 * agent gets its setup commands for it. The address is always the gateway's own, never one
 * built from how this app reaches the gateway.
 */
@Composable
private fun PairAddressed(
    pairingCode: String,
    kind: String?,
    plan: PairingAddressPlan?,
    planError: String?,
    selectedUrl: String?,
    qrPayload: String?,
    qrError: String?,
    onSelectAddress: (String) -> Unit,
    repairTarget: DeviceRecord?,
    expanded: Boolean,
) {
    val c = OmTheme.colors
    val phone = DeviceKindMeta.usesQr(kind)
    val noun = pairingNoun(kind)
    if (planError != null) {
        Problem("Couldn't prepare the ${if (phone) "QR code" else "address"}: $planError")
        return
    }
    if (plan == null) {
        Text("Finding the addresses this $noun can use…", fontSize = 13.sp, color = c.textMuted, modifier = Modifier.fillMaxWidth())
        return
    }
    val selected = plan.selected(selectedUrl)
    if (selected == null) {
        val who = pairingWithArticle(noun)
        Problem(
            if (phone) "None of this gateway's addresses can be used by $who, so there is no QR code to scan."
            else "None of this gateway's addresses can be used by $who.",
        )
        RefusedAddresses(plan, noun)
        plan.awayFromHome?.let { AwayFromHome(it, plan.platform, noun) }
        return
    }
    if (phone) {
        Text(
            "Scan with the Omnesis app on ${repairTarget?.name ?: "your $noun"}",
            fontSize = 13.sp,
            color = c.textSecondary,
        )
        when {
            qrPayload != null -> QrCodeView(payload = qrPayload)
            qrError != null -> Box(Modifier.size(220.dp), contentAlignment = Alignment.Center) {
                Text("Couldn't make the QR code: $qrError", fontSize = 13.sp, color = c.danger, textAlign = TextAlign.Center)
            }
            else -> Box(Modifier.size(220.dp), contentAlignment = Alignment.Center) { OmSpinner(color = c.accent) }
        }
        Reach(selected)
        plan.awayFromHome?.let { AwayFromHome(it, plan.platform, noun) }
        Alternatives(plan, selected, noun, onSelectAddress, expanded)
        if (qrPayload != null) CantScan(qrPayload, selected, pairingCode, expanded)
    } else {
        Reach(selected)
        Alternatives(plan, selected, noun, onSelectAddress, expanded)
        CodeInstructions(kind, selected.gatewayUrl, pairingCode, repairTarget)
    }
}

@Composable
private fun Problem(text: String) {
    Text(text, fontSize = 13.sp, color = OmTheme.colors.danger, modifier = Modifier.fillMaxWidth())
}

/**
 * For kinds that scan nothing. Agent integrations have their own one-shot installer commands;
 * other kinds keep the generic exchange guidance.
 */
@Composable
private fun CodeInstructions(kind: String?, gatewayUrl: String?, pairingCode: String, repairTarget: DeviceRecord?) {
    val c = OmTheme.colors
    if (kind == "agent") {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Text(
                "Run one command on the agent host. The pairing code is single-use.",
                fontSize = 13.sp,
                color = c.textSecondary,
            )
            agentConnectCommands(gatewayUrl, pairingCode).forEach { command ->
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
                            .padding(OmSpacing.sm)
                            .testTag("pair.agentCommand"),
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

/** Where a device paired with the chosen address works, in the gateway's words. */
@Composable
private fun Reach(selected: PairingAddressOption) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.large))
            .background(c.bgSecondary)
            .padding(OmSpacing.md)
            .testTag("pair.reach"),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        selected.summary?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 14.sp, color = c.textPrimary) }
        SelectionContainer { Text("${selected.label} · ${selected.host}", fontSize = 12.sp, color = c.textSecondary) }
    }
}

/** What the pairing screen calls the heading over the other addresses, or null when there is nothing under it. */
internal fun pairAlternativesTitle(plan: PairingAddressPlan): String? = when {
    plan.usable.size > 1 -> "Use a different address"
    plan.refused.isNotEmpty() -> "Why other addresses aren't offered"
    else -> null
}

/** A heading that opens and closes what is under it. */
@Composable
private fun Disclosure(title: String, startExpanded: Boolean, tag: String, content: @Composable () -> Unit) {
    val c = OmTheme.colors
    var open by rememberSaveable(title) { mutableStateOf(startExpanded) }
    Column(Modifier.fillMaxWidth().testTag(tag)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(OmRadius.medium))
                .clickable(role = Role.Button, onClickLabel = if (open) "Collapse" else "Expand") { open = !open }
                .padding(vertical = OmSpacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = c.accent, modifier = Modifier.weight(1f))
            Icon(
                if (open) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
                contentDescription = null,
                tint = c.accent,
                modifier = Modifier.size(18.dp),
            )
        }
        if (open) {
            Spacer(Modifier.height(OmSpacing.sm))
            content()
        }
    }
}

@Composable
private fun Alternatives(
    plan: PairingAddressPlan,
    selected: PairingAddressOption,
    noun: String,
    onSelectAddress: (String) -> Unit,
    expanded: Boolean,
) {
    val title = pairAlternativesTitle(plan) ?: return
    Disclosure(title, expanded, "pair.alternatives") {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            if (plan.usable.size > 1) {
                Column(Modifier.fillMaxWidth().testTag("pair.addresses")) {
                    for (option in plan.usable) {
                        val chosen = option.gatewayUrl == selected.gatewayUrl
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .selectable(selected = chosen, role = Role.RadioButton) { onSelectAddress(option.gatewayUrl) }
                                .padding(vertical = OmSpacing.xs),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = chosen, onClick = null)
                            Spacer(Modifier.size(OmSpacing.sm))
                            AddressText(pairAddressTitle(option, plan), option.summary)
                        }
                    }
                }
            }
            RefusedAddresses(plan, noun)
        }
    }
}

@Composable
private fun AddressText(title: String, detail: String?) {
    val c = OmTheme.colors
    Column {
        Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = c.textPrimary)
        if (!detail.isNullOrBlank()) Text(detail, fontSize = 12.sp, color = c.textSecondary)
    }
}

/** The addresses the gateway will not give this device, each with the gateway's reason. */
@Composable
private fun RefusedAddresses(plan: PairingAddressPlan, noun: String) {
    if (plan.refused.isEmpty()) return
    val c = OmTheme.colors
    Column(Modifier.fillMaxWidth().testTag("pair.refused"), verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        Text("Not offered for ${pairingWithArticle(noun)}", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.textSecondary)
        for (option in plan.refused) AddressText(pairAddressTitle(option, plan), option.reason)
    }
}

private const val AWAY_FROM_HOME_DOCS_URL = "https://omnesis.dev/docs/setup#away-from-home"

/**
 * Both phones need the gateway host and the phone on one tailnet; an iPhone also needs a
 * Tailscale certificate, which needs the host's Tailscale name.
 */
internal fun awayFromHomeSteps(hint: AwayFromHomeHint, platform: String?, noun: String): List<String> = buildList {
    val needsCertificate = platform == "ios"
    if (!hint.onTailnet) add("Install Tailscale on the gateway computer and on the $noun, and sign both in to the same tailnet.")
    if (needsCertificate && hint.onTailnet && hint.tailscaleName == null) add("Turn on MagicDNS for your tailnet in the Tailscale admin console.")
    if (needsCertificate) {
        add(
            "Turn on HTTPS certificates for your tailnet, then run omnesis tls provision on the gateway computer. " +
                "It gets a certificate${hint.tailscaleName?.let { " for $it" } ?: ""} from Tailscale. " +
                "Any phone you paired before this step will need to pair again.",
        )
    }
    add("Create a new pairing code here and scan it.")
}

/** Shown when no offered address reaches beyond the gateway's own network. */
@Composable
private fun AwayFromHome(hint: AwayFromHomeHint, platform: String?, noun: String) {
    val c = OmTheme.colors
    val uris = LocalUriHandler.current
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.large))
            .background(c.bgSecondary)
            .padding(OmSpacing.md)
            .testTag("pair.awayFromHome"),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Text("To use this $noun away from home", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
        awayFromHomeSteps(hint, platform, noun).forEachIndexed { index, step -> Text("${index + 1}. $step", fontSize = 12.sp, color = c.textSecondary) }
        Text(
            "Set up access away from home",
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.accent,
            modifier = Modifier.clickable(role = Role.Button) { runCatching { uris.openUri(AWAY_FROM_HOME_DOCS_URL) } },
        )
    }
}

/**
 * The same pairing by hand. Typing the address and the code is offered only where the phone's
 * own trust accepts the gateway; anywhere else the JSON carries the pin.
 */
@Composable
private fun CantScan(payload: String, selected: PairingAddressOption, pairingCode: String, expanded: Boolean) {
    val c = OmTheme.colors
    val clipboard = LocalClipboardManager.current
    var copied by remember(payload) { mutableStateOf(false) }
    Disclosure("Can't scan the code?", expanded, "pair.cantScan") {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    buildAnnotatedString {
                        append("In the Omnesis app, choose ")
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("Paste JSON") }
                        append(" and paste:")
                    },
                    fontSize = 12.sp,
                    color = c.textSecondary,
                    modifier = Modifier.weight(1f),
                )
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
                        contentDescription = "Copy pairing JSON",
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
            // A pinned address needs what only the QR or its JSON carries, so it is never typed by hand.
            if (manualEntryOffered(selected)) {
                SelectionContainer {
                    Text(
                        buildAnnotatedString {
                            append("Or choose ")
                            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append("Manual entry") }
                            append(" and type the gateway URL ")
                            withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(selected.gatewayUrl) }
                            append(" and the pairing code ")
                            withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(pairingCode) }
                            append(".")
                        },
                        fontSize = 12.sp,
                        color = c.textSecondary,
                        modifier = Modifier.fillMaxWidth().testTag("pair.manualEntry"),
                    )
                }
            }
        }
    }
}
