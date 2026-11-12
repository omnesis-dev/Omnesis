// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.MiddleEllipsisText
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.pairing.AccountGatewayChoice
import java.net.URI

@Composable
fun AccountCloudPairingPane(
    state: AccountPairingState,
    googleAvailable: Boolean,
    passkeyAvailable: Boolean,
    onGoogle: () -> Unit,
    onPasskey: () -> Unit,
    onChoose: (String) -> Unit,
    onPair: () -> Unit,
    onScan: () -> Unit = {},
    onManual: () -> Unit = {},
) {
    val colors = OmTheme.colors
    Column(Modifier.fillMaxSize().background(colors.bgPrimary).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        when (state.phase) {
            AccountPairingPhase.Idle, AccountPairingPhase.Failed -> {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionHeader(ACCOUNT_PAIRING_TITLE, ACCOUNT_PAIRING_DETAIL)
                    // Both sign-in buttons share one shape and size; each keeps its own colours.
                    if (googleAvailable) GoogleSignInButton(onClick = onGoogle, modifier = Modifier.fillMaxWidth().testTag("pairing.entry.google"))
                    if (passkeyAvailable) OutlinedButton(
                        onClick = onPasskey,
                        shape = SignInButtonShape,
                        border = BorderStroke(1.dp, colors.border),
                        colors = ButtonDefaults.outlinedButtonColors(containerColor = colors.bgSecondary, contentColor = colors.accent),
                        contentPadding = SignInButtonPadding,
                        modifier = Modifier.fillMaxWidth().heightIn(min = SignInButtonMinHeight).testTag("pairing.entry.passkey"),
                    ) {
                        Icon(Icons.Filled.Key, contentDescription = null, modifier = Modifier.size(20.dp))
                        Spacer(Modifier.width(10.dp)); Text("Sign in with Passkey", style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
                    }
                    val notice = state.notice
                    if (notice != null) EntryMessage(notice, Icons.Outlined.Info, colors.textSecondary, "pairing.account.notice")
                    else state.error?.let { EntryMessage(it, Icons.Outlined.Warning, colors.danger, "account-pairing-error") }
                }
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SectionHeader("Pair directly", "Use a pairing code from your gateway. No account needed.")
                    Column(Modifier.fillMaxWidth().clip(CardShape).background(colors.bgSecondary)) {
                        EntryRow("Scan the gateway's QR code", Icons.Outlined.QrCodeScanner, onScan, Modifier.testTag("pairing.entry.scan"))
                        HorizontalDivider(Modifier.padding(start = 58.dp), thickness = 1.dp, color = colors.borderLight)
                        EntryRow("Enter code manually", Icons.Outlined.Keyboard, onManual, Modifier.testTag("pairing.entry.manual"))
                    }
                }
            }
            else -> {
                if (state.phase == AccountPairingPhase.Choosing) SectionHeader("Choose a gateway", "Your Omnesis account has more than one. Pick the one this device joins.")
                else SectionHeader(ACCOUNT_PAIRING_TITLE, ACCOUNT_PAIRING_DETAIL)
                Progress(state, onChoose, onPair)
                state.error?.let { Text(it, color = colors.danger, modifier = Modifier.testTag("account-pairing-error")) }
            }
        }
    }
}

@Composable
private fun Progress(state: AccountPairingState, onChoose: (String) -> Unit, onPair: () -> Unit) {
    val colors = OmTheme.colors
    when (state.phase) {
        AccountPairingPhase.Idle, AccountPairingPhase.Failed -> Unit
        AccountPairingPhase.Connecting -> Working("Connecting securely…")
        AccountPairingPhase.SigningIn -> Working("Complete sign-in in the system dialog.")
        AccountPairingPhase.Finding -> Working("Finding your gateways…")
        AccountPairingPhase.Choosing -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for (gateway in state.gateways) GatewayRow(gateway) { onChoose(gateway.gatewayId) }
        }
        AccountPairingPhase.WaitingForGateway -> Column(Modifier.testTag("pairing.account.waiting"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OmSpinner()
            Text("Waiting for your gateway to come online", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
            Text("Keep this screen open. This continues on its own when your gateway is back.", style = MaterialTheme.typography.bodySmall, color = colors.textSecondary)
        }
        AccountPairingPhase.Pairing, AccountPairingPhase.Comparing -> if (state.joined) {
            Working("Connecting this device…")
        } else {
            state.host?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = colors.textSecondary) }
            Text(PAIRING_CODE_CHECK_TEXT, color = colors.textSecondary)
            state.code?.let { VerificationCode(it, Modifier.testTag("pairing.account.code")) }
            Text(if (state.approved) "Approved by your gateway." else "Waiting for approval on a trusted device…", color = colors.textSecondary)
            Button(
                onClick = onPair,
                enabled = state.approved && state.phase != AccountPairingPhase.Pairing,
                modifier = Modifier.fillMaxWidth().testTag("pairing.account.confirm"),
            ) {
                Text(if (state.phase == AccountPairingPhase.Pairing) "Pairing…" else "Codes match, pair this device")
            }
        }
    }
}

@Composable
private fun Working(text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OmSpinner()
        Text(text, color = OmTheme.colors.textSecondary)
    }
}

/**
 * The code two devices compare during pairing: large and monospaced, on one line when it fits
 * and wrapped when it does not. It assumes nothing about the code's length or grouping.
 */
@Composable
internal fun VerificationCode(code: String, modifier: Modifier = Modifier, align: TextAlign = TextAlign.Start) {
    // Read character by character, so TalkBack never turns a group into a word or a number.
    val spoken = code.filter(Char::isLetterOrDigit).toList().joinToString(" ")
    Text(
        code,
        style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold),
        color = OmTheme.colors.textPrimary,
        textAlign = align,
        modifier = modifier.semantics { contentDescription = "Verification code $spoken" },
    )
}

private val CardShape = RoundedCornerShape(12.dp)

/** Why the last sign-in ended, under the buttons it belongs to. */
@Composable
private fun EntryMessage(text: String, icon: ImageVector, tint: Color, tag: String) {
    val colors = OmTheme.colors
    Row(
        Modifier.fillMaxWidth().clip(CardShape).background(colors.bgSecondary).padding(12.dp).testTag(tag),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.padding(top = 2.dp).size(18.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = colors.textPrimary)
    }
}

@Composable
private fun EntryRow(title: String, icon: ImageVector, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = OmTheme.colors
    Row(
        modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, contentDescription = null, tint = colors.accent, modifier = Modifier.size(24.dp))
        Text(title, color = colors.textPrimary, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = colors.textMuted, modifier = Modifier.size(18.dp))
    }
}

/** One gateway in the chooser. A relay address is one long word, so it gets a single line cut in the middle. */
@Composable
private fun GatewayRow(gateway: AccountGatewayChoice, onClick: () -> Unit) {
    val colors = OmTheme.colors
    val host = runCatching { URI(gateway.publicOrigin).host }.getOrNull() ?: gateway.publicOrigin
    Row(
        Modifier.fillMaxWidth().clip(CardShape).background(colors.bgSecondary).clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp).testTag("pairing.account.gateway.${gateway.gatewayId}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Icons.Outlined.Dns, contentDescription = null, tint = colors.accent, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            // A gateway linked before names existed has none; its address stays on the second line.
            Text(gateway.displayName?.trim().takeUnless { it.isNullOrEmpty() } ?: "Gateway", style = MaterialTheme.typography.titleMedium, color = colors.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            MiddleEllipsisText(host, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = colors.textSecondary, modifier = Modifier.fillMaxWidth())
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = colors.textMuted, modifier = Modifier.size(18.dp))
    }
}

/** What the new device says above its code while it waits. */
internal const val PAIRING_CODE_CHECK_TEXT = "Check that this code matches the one shown on your other device, then approve it there."

internal const val ACCOUNT_PAIRING_TITLE = "Pair using your Omnesis Account"
internal const val ACCOUNT_PAIRING_DETAIL =
    "Sign in to your Omnesis account to enroll this device to your gateway. Access your gateway from anywhere outside your home network " +
        "via Omnesis Relay. Traffic is encrypted end-to-end and Omnesis Relay cannot see your data."

/** A section's bold title over the paragraph that explains it. Both sections of the entry use it. */
@Composable
private fun SectionHeader(title: String, detail: String) {
    val colors = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = colors.textPrimary, modifier = Modifier.semantics { heading() })
        Text(detail, style = MaterialTheme.typography.bodyMedium, color = colors.textSecondary)
    }
}

fun accountPairingPreviewState(phase: AccountPairingPhase): AccountPairingState = AccountPairingState(
    phase = phase,
    gateways = listOf(AccountGatewayChoice("00000000-0000-4000-8000-000000000001", "https://home.example.test", "Fictional home"), AccountGatewayChoice("00000000-0000-4000-8000-000000000002", "https://studio.example.test", "Fictional studio gateway with a long display name")),
    code = "465 774", host = "home.example.test",
    approved = phase == AccountPairingPhase.Pairing,
    error = if (phase == AccountPairingPhase.Failed) "This Omnesis account has no gateway yet. Connect your gateway to it first, or pair directly with a QR code." else null,
)
@Preview @Composable private fun AccountSignInPreview() { OmnesisTheme { AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Idle), true, true, {}, {}, {}, {}) } }
@Preview @Composable private fun AccountGatewaysPreview() { OmnesisTheme(darkTheme = true) { AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Choosing), true, true, {}, {}, {}, {}) } }
