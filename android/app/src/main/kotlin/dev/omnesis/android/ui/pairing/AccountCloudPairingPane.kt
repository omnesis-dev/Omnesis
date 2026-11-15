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
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalInspectionMode
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
import kotlinx.coroutines.delay
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
    onCancel: () -> Unit = {},
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
                val waiting = (state.phase == AccountPairingPhase.Comparing || state.phase == AccountPairingPhase.Pairing) && !state.joined
                if (state.phase == AccountPairingPhase.Choosing) SectionHeader("Choose a gateway", "Your Omnesis account has more than one. Pick the one this device joins.")
                else if (!waiting) SectionHeader(ACCOUNT_PAIRING_TITLE, ACCOUNT_PAIRING_DETAIL)
                Progress(state, onChoose, onPair, onCancel)
                state.error?.let { Text(it, color = colors.danger, modifier = Modifier.testTag("account-pairing-error")) }
            }
        }
    }
}

@Composable
private fun Progress(state: AccountPairingState, onChoose: (String) -> Unit, onPair: () -> Unit, onCancel: () -> Unit) {
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
            WaitingForOk(state, onPair, onCancel)
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
internal fun VerificationCode(code: String, modifier: Modifier = Modifier, align: TextAlign = TextAlign.Start, large: Boolean = false) {
    // Read character by character, so TalkBack never turns a group into a word or a number.
    val spoken = code.filter(Char::isLetterOrDigit).toList().joinToString(" ")
    Text(
        code,
        style = (if (large) MaterialTheme.typography.headlineLarge else MaterialTheme.typography.headlineSmall)
            .copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold),
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

/**
 * This phone signed in and the gateway holds it until the owner says yes. One state: where to
 * approve, the code that place will show, how long it waits, and a way out. An approval from a
 * gateway this phone verified continues on its own; an unverified one asks this person to
 * confirm the codes matched.
 */
@Composable
private fun WaitingForOk(state: AccountPairingState, onPair: () -> Unit, onCancel: () -> Unit) {
    val colors = OmTheme.colors
    val pairing = state.phase == AccountPairingPhase.Pairing
    Column(Modifier.fillMaxWidth().testTag("pairing.account.waitingForOk"), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Icon(if (state.approved) Icons.Outlined.CheckCircle else Icons.Outlined.Schedule, contentDescription = null, tint = colors.accent, modifier = Modifier.size(36.dp))
        Text(if (state.approved) "Approved" else PAIRING_WAITING_TITLE, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = colors.textPrimary, modifier = Modifier.semantics { heading() })
        when {
            state.approved && state.continues -> Text(PAIRING_WAITING_APPROVED, color = colors.textPrimary)
            state.approved -> Text(PAIRING_WAITING_COMPARE, color = colors.textPrimary)
            else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(PAIRING_WAITING_FROM_ANOTHER_DEVICE, color = colors.textPrimary)
                for (place in PAIRING_WAITING_PLACES) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("•", color = colors.textPrimary)
                    Text(place, color = colors.textPrimary)
                }
                Text(PAIRING_WAITING_CODE_LEAD, color = colors.textPrimary)
            }
        }
        state.code?.let { VerificationCode(it, Modifier.fillMaxWidth().testTag("pairing.account.code"), TextAlign.Center, large = true) }
        if (!state.approved) state.expiresAt?.let { ExpiryCountdown(it) }
        if (!state.continues && (state.approved || pairing)) Button(
            onClick = onPair,
            enabled = !pairing,
            modifier = Modifier.fillMaxWidth().testTag("pairing.account.confirm"),
        ) {
            Text(if (pairing) "Connecting…" else PAIRING_WAITING_CONFIRM)
        }
        if (!pairing) TextButton(onClick = onCancel, modifier = Modifier.fillMaxWidth().testTag("pairing.account.cancel")) {
            Text("Cancel", color = colors.accent)
        }
    }
}

/** The clock the countdown reads; screenshots fix it so the golden shows one moment. */
internal val LocalPairingClock = staticCompositionLocalOf<() -> Long> { System::currentTimeMillis }

@Composable
private fun ExpiryCountdown(expiresAt: Long) {
    val clock = LocalPairingClock.current
    var now by remember { mutableLongStateOf(clock()) }
    // A ticking loop never idles, so a screenshot renders the first moment only.
    if (!LocalInspectionMode.current) LaunchedEffect(expiresAt) { while (true) { delay(1000); now = clock() } }
    Text(
        pairingExpiryText(expiresAt - now),
        style = MaterialTheme.typography.bodySmall,
        color = OmTheme.colors.textSecondary,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().testTag("pairing.account.expiry"),
    )
}

/** "Expires in 4:32", or a way on once the gateway stopped waiting. */
internal fun pairingExpiryText(remainingMillis: Long): String {
    val seconds = remainingMillis / 1000
    if (seconds <= 0) return "Expired. Cancel and sign in again."
    return "Expires in %d:%02d".format(seconds / 60, seconds % 60)
}

/** What the legacy Google pairing says above its code while it waits. */
internal const val PAIRING_CODE_CHECK_TEXT = "Approve this device from a device you already use. Make sure it shows this same code."

internal const val PAIRING_WAITING_TITLE = "Waiting for your OK"
internal const val PAIRING_WAITING_FROM_ANOTHER_DEVICE = "Approve this phone from a device you already use:"
internal val PAIRING_WAITING_PLACES = listOf("the Omnesis portal on your computer, or", "the Omnesis app on another phone.")
internal const val PAIRING_WAITING_CODE_LEAD = "It will show this code:"
internal const val PAIRING_WAITING_COMPARE = "Continue only if the device you approved on showed this same code."
internal const val PAIRING_WAITING_CONFIRM = "Codes match, connect this phone"
internal const val PAIRING_WAITING_APPROVED = "Approved. Connecting this phone…"

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

/** The moment previews and screenshots render at, four and a half minutes before a request expires. */
const val PREVIEW_PAIRING_NOW = 1_800_000_000_000L

fun accountPairingPreviewState(phase: AccountPairingPhase): AccountPairingState = AccountPairingState(
    phase = phase,
    gateways = listOf(AccountGatewayChoice("00000000-0000-4000-8000-000000000001", "https://home.example.test", "Fictional home"), AccountGatewayChoice("00000000-0000-4000-8000-000000000002", "https://studio.example.test", "Fictional studio gateway with a long display name")),
    code = "465 774", host = "home.example.test",
    approved = phase == AccountPairingPhase.Pairing,
    expiresAt = if (phase == AccountPairingPhase.Comparing) PREVIEW_PAIRING_NOW + 272_000 else null,
    error = if (phase == AccountPairingPhase.Failed) "This Omnesis account has no gateway yet. Connect your gateway to it first, or pair directly with a QR code." else null,
)
@Preview @Composable private fun AccountSignInPreview() { OmnesisTheme { AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Idle), true, true, {}, {}, {}, {}) } }
@Preview @Composable private fun AccountGatewaysPreview() { OmnesisTheme(darkTheme = true) { AccountCloudPairingPane(accountPairingPreviewState(AccountPairingPhase.Choosing), true, true, {}, {}, {}, {}) } }
