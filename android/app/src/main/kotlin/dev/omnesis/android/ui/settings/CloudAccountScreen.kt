// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_MANAGE
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_PROBLEMS_HELP
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_TURN_OFF_FOOTNOTE
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_TURN_ON_FOOTNOTE
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_UNLINK
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_UNLINKING
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_UNLINK_CONFIRM
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_UNLINK_TEXT
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_UNLINK_TITLE
import dev.omnesis.android.pairing.cloudAccountHints
import dev.omnesis.android.pairing.cloudAccountLine
import dev.omnesis.android.pairing.cloudAccountLinked
import dev.omnesis.android.pairing.cloudAccountProblemsTitle
import dev.omnesis.android.pairing.CloudAccountPhase
import dev.omnesis.android.pairing.CloudAccountSettingsController
import dev.omnesis.android.pairing.cloudAccountAddressState
import dev.omnesis.android.pairing.cloudAccountDiagnostics
import dev.omnesis.android.pairing.cloudAccountElsewhere
import dev.omnesis.android.pairing.cloudAccountErrorText
import dev.omnesis.android.pairing.cloudAccountHttpsUrl
import dev.omnesis.android.pairing.cloudAccountPageUrl
import dev.omnesis.android.pairing.cloudAccountPollMillis
import dev.omnesis.android.pairing.cloudAccountProblems
import dev.omnesis.android.pairing.cloudAccountShown
import dev.omnesis.android.pairing.cloudAccountTroubled
import dev.omnesis.android.pairing.cloudAccountUsesAccount
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.CloudRelayManaging
import dev.omnesis.android.transport.dto.CloudRelayStatus
import dev.omnesis.android.transport.dto.DeviceEnrollmentSettings
import dev.omnesis.android.ui.common.GatewayErrorView
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import java.util.TimeZone
import javax.inject.Inject

/**
 * Opens [url] in a Custom Tab, so a sign-in stays visibly attached to the app and Back returns
 * here. The session extra is the whole Custom Tabs contract a caller without a warmed-up
 * session needs; a browser that does not offer Custom Tabs opens the address as a normal tab.
 */
internal fun openInCustomTab(context: Context, url: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .putExtras(Bundle().apply { putBinder("android.support.customtabs.extra.SESSION", null) })
    runCatching { context.startActivity(intent) }
}

@HiltViewModel
class CloudAccountViewModel @Inject constructor(
    private val session: SessionManager,
) : ViewModel() {
    private val controller = CloudAccountSettingsController()
    val state = controller.state
    private var polling: Job? = null

    /** Never read from the gateway unless the build enables cloud connectivity. */
    private fun client(): CloudRelayManaging? = session.session?.takeIf { BuildConfig.CLOUD_RELAY_ENABLED }?.admin

    /**
     * Re-reads the status for as long as the screen is in front. A sign-in finishes on the
     * relay's page, so the gateway's status is the only thing that says it did.
     */
    fun startPolling() {
        polling?.cancel()
        polling = viewModelScope.launch {
            while (true) {
                client()?.let { controller.refresh(it) }
                delay(cloudAccountPollMillis(state.value.status))
            }
        }
    }

    fun stopPolling() {
        polling?.cancel()
        polling = null
    }

    fun refresh() = act { controller.refresh(it) }
    fun connect(intent: String) = act { controller.connect(it, intent) }
    fun cancelConnect() = act { controller.cancelConnect(it) }
    fun run(operation: String) = act { controller.run(it, operation) }
    fun setPolicy(policy: String) = act { controller.setPolicy(it, policy) }
    fun launched() = controller.launched()

    private fun act(block: suspend (CloudRelayManaging) -> Unit) {
        val client = client() ?: return
        viewModelScope.launch { block(client) }
    }
}

/** What the screen can ask for. Defaults do nothing, for renders that only show a state. */
data class CloudAccountActions(
    val retry: () -> Unit = {},
    val connect: (intent: String) -> Unit = {},
    val cancelConnect: () -> Unit = {},
    val run: (operation: String) -> Unit = {},
    val setPolicy: (String) -> Unit = {},
    val openSignIn: (url: String) -> Unit = {},
    val openPage: (url: String) -> Unit = {},
)

/**
 * Settings → Omnesis account: the account link and remote access through the optional cloud
 * relay, with the portal page's states, wording and actions. One state headline, a box that
 * appears only when something is wrong, then three short sections: the account, remote access
 * and new devices. The portal's manual setup form is not here; a state only that form can
 * resolve points at the portal.
 */
@Composable
fun CloudAccountScreen(onBack: () -> Unit, vm: CloudAccountViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LifecycleResumeEffect(Unit) {
        vm.startPolling()
        onPauseOrDispose { vm.stopPolling() }
    }
    LaunchedEffect(state.launchUrl) {
        state.launchUrl?.let {
            openInCustomTab(context, it)
            vm.launched()
        }
    }
    // A gateway that stopped offering these settings has nothing to show here.
    LaunchedEffect(state.absent) { if (state.absent) onBack() }
    CloudAccountContent(
        state = state,
        onBack = onBack,
        actions = CloudAccountActions(
            retry = vm::refresh,
            connect = vm::connect,
            cancelConnect = vm::cancelConnect,
            run = vm::run,
            setPolicy = vm::setPolicy,
            openSignIn = { openInCustomTab(context, it) },
            openPage = { url -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
        ),
    )
}

/** Dates and times in the phone's own format. [zone] is a parameter so a render does not depend on its machine. */
private class RelayDates(zone: TimeZone) {
    private val day = DateFormat.getDateInstance(DateFormat.MEDIUM).apply { timeZone = zone }
    private val clock = DateFormat.getTimeInstance(DateFormat.SHORT).apply { timeZone = zone }
    fun date(millis: Long): String = day.format(Date(millis))
    fun clock(millis: Long): String = clock.format(Date(millis))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CloudAccountContent(
    state: CloudAccountSettingsController.State,
    onBack: () -> Unit,
    actions: CloudAccountActions = CloudAccountActions(),
    zone: TimeZone = TimeZone.getDefault(),
    now: () -> Long = System::currentTimeMillis,
) {
    val c = OmTheme.colors
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back to Settings", tint = c.accent)
                    }
                },
                title = { Text("Omnesis account", style = MaterialTheme.typography.titleMedium, color = c.textPrimary) },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.bgPrimary, scrolledContainerColor = c.bgPrimary),
            )
        },
    ) { padding ->
        val status = state.status
        if (status == null && state.loading) {
            LoadingView(Modifier.padding(padding).fillMaxSize().background(c.bgPrimary))
            return@Scaffold
        }
        if (status == null) {
            GatewayErrorView(
                context = "load your Omnesis account",
                error = state.loadError,
                onRetry = actions.retry,
                onOpenSettings = onBack,
                modifier = Modifier.padding(padding).testTag("cloudAccount.unreachable"),
            )
            return@Scaffold
        }
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .background(c.bgPrimary)
                .verticalScroll(rememberScrollState())
                .padding(OmSpacing.lg)
                .testTag("cloudAccount.screen"),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            val phase = state.phase ?: return@Column
            val dates = RelayDates(zone)
            // One change at a time.
            val canAct = state.busy == null
            PhaseHero(status, phase, state, canAct, dates, actions)
            state.error?.let { Notice(it, c.danger, Modifier.testTag("cloudAccount.error")) }
            val problems = cloudAccountProblems(status, phase, dates::date)
            if (cloudAccountTroubled(problems, phase)) {
                ProblemsBox(problems) { cloudAccountDiagnostics(status, phase, now()) }
            }
            if (phase.established) {
                AccountSection(status, state.busy, canAct, actions)
                RemoteAccessSection(status, state.busy, canAct, actions)
                // Devices sign in through a linked account, so without one the setting decides nothing.
                status.deviceEnrollment?.takeIf { status.account?.linked == true }?.let {
                    NewDevicesSection(it, canAct, actions)
                }
            }
        }
    }
}

@Composable
private fun PhaseHero(
    status: CloudRelayStatus,
    phase: CloudAccountPhase,
    state: CloudAccountSettingsController.State,
    canAct: Boolean,
    dates: RelayDates,
    actions: CloudAccountActions,
) {
    val c = OmTheme.colors
    val busy = state.busy
    val connectError = status.connect?.error ?: status.enrollment?.error
    when (phase) {
        CloudAccountPhase.NotConnected -> Hero(
            dot = null,
            title = "Enroll this gateway in your Omnesis Account",
            lede = "An Omnesis account lets you reach your gateway from your phone and laptop outside your home network " +
                "and pair new devices by signing in. Traffic is encrypted end to end, and the keys never leave this gateway. " +
                "Connecting gives this gateway a public address and a certificate.",
        ) { ConnectChoices(state, canAct, actions) }
        CloudAccountPhase.Waiting -> Hero(
            dot = c.accent,
            progress = true,
            title = "Sign in to your Omnesis account",
            lede = "Continue in the sign-in page to finish connecting. This screen updates by itself.",
        ) {
            cloudAccountHttpsUrl(status.connect?.authorizeUrl)?.let { url ->
                PrimaryButton("Open sign-in", enabled = canAct, modifier = Modifier.testTag("cloudAccount.openSignIn")) { actions.openSignIn(url) }
            }
            SecondaryButton(if (busy == "connect/cancel") "Cancelling…" else "Cancel", enabled = canAct, modifier = Modifier.testTag("cloudAccount.cancel"), onClick = actions.cancelConnect)
            Elsewhere(status, dates)
        }
        CloudAccountPhase.Registering -> Hero(
            dot = c.accent,
            progress = true,
            title = "Registering this gateway…",
            lede = "Getting its address and certificate. This usually takes less than a minute.",
        )
        CloudAccountPhase.Linking -> Hero(c.accent, "Connecting to your Omnesis account…", "Almost done.", progress = true)
        CloudAccountPhase.Failed -> Hero(
            dot = c.danger,
            title = "Couldn't connect",
            lede = cloudAccountErrorText(connectError) ?: "The connection could not be set up. Nothing on this gateway changed.",
        ) {
            // Whoever got this far has an account or declined to make one, so a retry signs in.
            PrimaryButton(if (busy == "connect") "Connecting…" else "Try again", enabled = canAct) { actions.connect("existing") }
        }
        CloudAccountPhase.Connected -> Hero(
            dot = c.success,
            title = "Connected as",
            hostname = status.hostname ?: "your gateway",
            lede = "Your devices can reach this gateway from anywhere. Traffic is encrypted end to end, and the keys never leave this gateway.",
        )
        CloudAccountPhase.Reconnecting -> Hero(
            dot = c.warning,
            title = "Reconnecting…",
            lede = "Devices on your home network keep working. Devices away from home reconnect when the connection returns.",
        )
        CloudAccountPhase.Disconnected -> Hero(
            dot = c.warning,
            title = "Disconnected",
            lede = cloudAccountErrorText(status.tunnel?.lastError) ?: "Remote access dropped. Devices on your home network keep working.",
        ) {
            PrimaryButton(
                if (busy == "reconnect") "Reconnecting…" else "Reconnect",
                enabled = canAct && status.can?.reconnect == true,
            ) { actions.run("reconnect") }
        }
        CloudAccountPhase.Off -> Hero(
            dot = c.textMuted,
            title = "Remote access is off",
            lede = "This gateway keeps its address. Turn remote access back on to reach it from anywhere.",
        ) {
            PrimaryButton(
                if (busy == "enable") "Turning on…" else "Turn on",
                enabled = canAct && status.can?.enable == true,
                modifier = Modifier.testTag("cloudAccount.turnOn"),
            ) { actions.run("enable") }
            Hint(CLOUD_ACCOUNT_TURN_ON_FOOTNOTE)
        }
        CloudAccountPhase.Unavailable -> Hero(
            dot = c.textMuted,
            title = "Remote access isn't available",
            lede = cloudAccountErrorText(status.serviceError)
                ?: "This installation is not set up for Omnesis accounts. Direct connections and QR pairing keep working.",
        )
    }
}

/** The two ways into a connect. Both start the same sign-in; the relay's page opens on the matching form. */
@Composable
private fun ConnectChoices(state: CloudAccountSettingsController.State, canAct: Boolean, actions: CloudAccountActions) {
    val connecting = state.busy == "connect"
    PrimaryButton(
        if (connecting && state.connectIntent == "create") "Connecting…" else "Create an Omnesis account",
        enabled = canAct,
        modifier = Modifier.testTag("cloudAccount.create"),
    ) { actions.connect("create") }
    SecondaryButton(
        if (connecting && state.connectIntent == "existing") "Connecting…" else "I already have one",
        enabled = canAct,
        modifier = Modifier.testTag("cloudAccount.existing"),
    ) { actions.connect("existing") }
}

/** Finishing the sign-in on another device: the relay's address and the code to enter there. */
@Composable
private fun Elsewhere(status: CloudRelayStatus, dates: RelayDates) {
    val c = OmTheme.colors
    val elsewhere = cloudAccountElsewhere(status) ?: return
    val clipboard = LocalClipboardManager.current
    HorizontalDivider(Modifier.padding(vertical = OmSpacing.xs), thickness = 1.dp, color = c.borderLight)
    Text(
        buildAnnotatedString {
            append("Or on another device, visit ")
            withStyle(SpanStyle(color = c.textPrimary, fontWeight = FontWeight.SemiBold)) { append(elsewhere.shownAddress) }
            append(" and enter")
        },
        style = MaterialTheme.typography.bodyMedium,
        color = c.textSecondary,
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            elsewhere.code,
            style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Monospace, letterSpacing = 2.sp),
            color = c.textPrimary,
            modifier = Modifier.testTag("cloudAccount.code"),
        )
        IconButton(onClick = { clipboard.setText(AnnotatedString(elsewhere.code)) }) {
            Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy code", tint = c.accent, modifier = Modifier.size(20.dp))
        }
    }
    elsewhere.expiresAtMillis?.let {
        Text("The code works until ${dates.clock(it)}.", style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
    }
}

/**
 * What is wrong, in one box: a plain sentence per problem and the details to paste when asking
 * for help. [messages] may be empty when the headline already says what is wrong.
 */
@Composable
private fun ProblemsBox(messages: List<String>, details: () -> String) {
    val c = OmTheme.colors
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(2_000)
            copied = false
        }
    }
    OmnesisCard(Modifier.fillMaxWidth().testTag("cloudAccount.problems"), padding = OmSpacing.lg) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Warning, contentDescription = null, tint = c.warning, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(OmSpacing.sm))
            Text(
                cloudAccountProblemsTitle(messages.size),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = c.textPrimary,
                modifier = Modifier.semantics { heading() },
            )
        }
        for (message in messages) {
            Text(
                message,
                style = MaterialTheme.typography.bodyMedium,
                color = c.textPrimary,
                modifier = Modifier.padding(top = OmSpacing.sm),
            )
        }
        Text(
            CLOUD_ACCOUNT_PROBLEMS_HELP,
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            modifier = Modifier.padding(top = OmSpacing.sm),
        )
        Spacer(Modifier.height(OmSpacing.sm))
        SecondaryButton(if (copied) "Copied" else "Copy details", enabled = true, modifier = Modifier.testTag("cloudAccount.copyDetails")) {
            clipboard.setText(AnnotatedString(details()))
            copied = true
        }
    }
}

@Composable
private fun AccountSection(status: CloudRelayStatus, busy: String?, canAct: Boolean, actions: CloudAccountActions) {
    if (!cloudAccountShown(status)) return
    val omnesis = cloudAccountUsesAccount(status)
    val accountPage = cloudAccountPageUrl(status.config?.relayUrl)
    Spacer(Modifier.height(OmSpacing.sm))
    SectionLabel("Account")
    OmnesisCard(Modifier.fillMaxWidth().testTag("cloudAccount.account"), padding = OmSpacing.lg) {
        Value(cloudAccountLine(status))
        for (hint in cloudAccountHints(status)) Hint(hint)
        if (!cloudAccountLinked(status)) return@OmnesisCard
        if (accountPage != null) {
            Spacer(Modifier.height(OmSpacing.sm))
            OutlinedButton(onClick = { actions.openPage(accountPage) }, modifier = Modifier.testTag("cloudAccount.manage")) {
                Text(CLOUD_ACCOUNT_MANAGE, color = OmTheme.colors.accent)
            }
        }
        val operation = if (omnesis) "account/unlink" else "google/unlink"
        if (if (omnesis) status.account?.canUnlink == true else status.google?.canUnlink == true) {
            Unlink(busy == operation, canAct) { actions.run(operation) }
        }
    }
}

/** Leaving the account is asked twice: it is the one change here that is not undone with a tap. */
@Composable
private fun Unlink(unlinking: Boolean, canAct: Boolean, onConfirm: () -> Unit) {
    val c = OmTheme.colors
    var asking by remember { mutableStateOf(false) }
    QuietButton(
        if (unlinking) CLOUD_ACCOUNT_UNLINKING else CLOUD_ACCOUNT_UNLINK,
        enabled = canAct,
        tone = c.danger,
        modifier = Modifier.testTag("cloudAccount.unlink"),
    ) { asking = true }
    if (!asking) return
    AlertDialog(
        onDismissRequest = { asking = false },
        containerColor = c.bgSecondary,
        title = { Text(CLOUD_ACCOUNT_UNLINK_TITLE, color = c.textPrimary) },
        text = { Text(CLOUD_ACCOUNT_UNLINK_TEXT, color = c.textSecondary) },
        confirmButton = {
            TextButton(onClick = { asking = false; onConfirm() }) { Text(CLOUD_ACCOUNT_UNLINK_CONFIRM, color = c.danger) }
        },
        dismissButton = { TextButton(onClick = { asking = false }) { Text("Cancel", color = c.accent) } },
    )
}

/**
 * The public address, whether it answers, and the control that stops access from outside.
 * While remote access is off the headline's own button turns it back on.
 */
@Composable
private fun RemoteAccessSection(status: CloudRelayStatus, busy: String?, canAct: Boolean, actions: CloudAccountActions) {
    val c = OmTheme.colors
    val clipboard = LocalClipboardManager.current
    val enabled = status.enabled == true
    val address = status.publicMcp?.url?.takeIf { it.isNotBlank() }
    if (address == null && !enabled) return
    Spacer(Modifier.height(OmSpacing.sm))
    SectionLabel("Remote access")
    OmnesisCard(Modifier.fillMaxWidth().testTag("cloudAccount.remoteAccess"), padding = OmSpacing.lg) {
        if (address != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    address,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f).testTag("cloudAccount.address"),
                )
                IconButton(onClick = { clipboard.setText(AnnotatedString(address)) }) {
                    Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy address", tint = c.accent, modifier = Modifier.size(20.dp))
                }
            }
            cloudAccountAddressState(status)?.let { Hint(it, Modifier.testTag("cloudAccount.addressState")) }
        }
        if (enabled) {
            Spacer(Modifier.height(OmSpacing.sm))
            OutlinedButton(
                onClick = { actions.run("disable") },
                enabled = canAct && status.can?.disable == true,
                modifier = Modifier.testTag("cloudAccount.turnOff"),
            ) {
                Text(
                    if (busy == "disable") "Turning off…" else "Turn off",
                    color = if (canAct && status.can?.disable == true) c.accent else c.textMuted,
                )
            }
            Hint(CLOUD_ACCOUNT_TURN_OFF_FOOTNOTE)
        }
    }
}

@Composable
private fun NewDevicesSection(enrollment: DeviceEnrollmentSettings, canAct: Boolean, actions: CloudAccountActions) {
    Spacer(Modifier.height(OmSpacing.sm))
    SectionLabel("New devices")
    Hint("What happens when a new device signs in to your Omnesis account.")
    OmnesisCard(Modifier.fillMaxWidth().testTag("cloudAccount.newDevices"), padding = OmSpacing.lg) {
        PolicyChoice(
            "Join automatically",
            "A device joins once you sign in to your Omnesis account with a sign-in this gateway trusts. You're notified and can remove it any time.",
            selected = enrollment.policy == "automatic",
            enabled = canAct,
        ) { actions.setPolicy("automatic") }
        PolicyChoice(
            "Ask me first",
            "A device waits until you approve it on a device you already use, and the codes match. Someone with your Google password still can't get in.",
            selected = enrollment.policy == "ask",
            enabled = canAct,
        ) { actions.setPolicy("ask") }
    }
}

@Composable
private fun PolicyChoice(title: String, text: String, selected: Boolean, enabled: Boolean, onSelect: () -> Unit) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onSelect)
            .padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Spacer(Modifier.width(OmSpacing.sm))
        Column {
            Text(title, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
            Text(text, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        }
    }
}

/** The state headline: a tone, one sentence of what is true and one of what it means, then its actions. */
@Composable
private fun Hero(
    dot: Color?,
    title: String,
    lede: String,
    progress: Boolean = false,
    /** Set apart from the title: the address this gateway is connected as. */
    hostname: String? = null,
    actions: @Composable ColumnScope.() -> Unit = {},
) {
    val c = OmTheme.colors
    OmnesisCard(Modifier.fillMaxWidth().testTag("cloudAccount.hero"), padding = OmSpacing.lg) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (progress) {
                OmSpinner(Modifier.size(16.dp), color = c.accent, strokeWidth = 2.dp)
                Spacer(Modifier.width(OmSpacing.sm))
            } else if (dot != null) {
                Box(Modifier.size(10.dp).background(dot, CircleShape))
                Spacer(Modifier.width(OmSpacing.sm))
            }
            Column {
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    color = c.textPrimary,
                    modifier = Modifier.semantics { heading() },
                )
                if (hostname != null) {
                    Text(
                        hostname,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium),
                        color = c.textPrimary,
                        modifier = Modifier.testTag("cloudAccount.hostname"),
                    )
                }
            }
        }
        Spacer(Modifier.height(OmSpacing.sm))
        Text(lede, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
        Column(
            Modifier.fillMaxWidth().padding(top = OmSpacing.sm),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
            content = actions,
        )
    }
}

@Composable
private fun Notice(text: String, tone: Color, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    OmnesisCard(modifier.fillMaxWidth(), padding = OmSpacing.md) {
        Row(verticalAlignment = Alignment.Top) {
            Box(Modifier.padding(top = 6.dp).size(8.dp).background(tone, CircleShape))
            Spacer(Modifier.width(OmSpacing.sm))
            Text(text, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary)
        }
    }
}

@Composable
private fun Value(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = OmTheme.colors.textPrimary)
}

@Composable
private fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = OmTheme.colors.textSecondary,
        modifier = modifier.padding(top = 2.dp),
    )
}

@Composable
private fun PrimaryButton(label: String, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth(),
        colors = ButtonDefaults.buttonColors(containerColor = OmTheme.colors.accent, contentColor = Color.White),
    ) { Text(label) }
}

@Composable
private fun SecondaryButton(label: String, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.fillMaxWidth()) {
        Text(label, color = if (enabled) OmTheme.colors.accent else OmTheme.colors.textMuted)
    }
}

@Composable
private fun QuietButton(label: String, enabled: Boolean, tone: Color = OmTheme.colors.accent, modifier: Modifier = Modifier, onClick: () -> Unit) {
    // No side padding, so the label lines up with the text above it.
    TextButton(onClick = onClick, enabled = enabled, modifier = modifier, contentPadding = PaddingValues(0.dp)) {
        Text(label, color = if (enabled) tone else OmTheme.colors.textMuted)
    }
}
