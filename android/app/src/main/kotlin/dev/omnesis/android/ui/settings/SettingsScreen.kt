// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.AppVersionInfo
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.distribution.DistributionSettingsSection
import dev.omnesis.android.feature.activitysegments.ui.ActivitySegmentsSettingsSection
import dev.omnesis.android.feature.appusage.ui.AppUsageSettingsSection
import dev.omnesis.android.feature.health.ui.HealthSettingsSection
import dev.omnesis.android.feature.photos.ui.PhotosSettingsSection
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.setup.ui.LocalOpenPhoneSetupStep
import dev.omnesis.android.transport.PermissionHealthEntry
import dev.omnesis.android.transport.PushHealth
import dev.omnesis.android.transport.ws.DeviceSocket
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.common.NotificationHealthBanner
import dev.omnesis.android.ui.common.NotificationSetupBanner
import dev.omnesis.android.ui.common.NotificationSetupIssue
import dev.omnesis.android.ui.common.PermissionHealthBanner
import dev.omnesis.android.ui.common.PushHealthBanner
import dev.omnesis.android.ui.common.notificationSetupIssue
import dev.omnesis.android.ui.phonesetup.PhoneSetupSettingsSection

const val MOBILE_PRIVACY_POLICY_URL = "https://omnesis.dev/mobile-privacy-policy"
const val NOTIFICATION_SETUP_URL = "https://omnesis.dev/docs/notifications#setup"

fun openMobilePrivacyPolicy(context: Context) {
    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(MOBILE_PRIVACY_POLICY_URL)))
}

@Composable
fun SettingsScreen(
    onClose: () -> Unit,
    onUnpaired: () -> Unit,
    focusedSourceId: String? = null,
    onRepair: () -> Unit = {},
    onOpenModels: () -> Unit = {},
    onOpenDevices: () -> Unit = {},
    onOpenPolicies: () -> Unit = {},
    onOpenAccessAuthorization: () -> Unit = {},
    onOpenPhoneSetup: () -> Unit = {},
    onOpenPhoneSetupStep: (String) -> Unit = {},
    vm: SettingsViewModel = hiltViewModel(),
) {
    val mode by vm.appearanceMode.collectAsStateWithLifecycle()
    val gateway by vm.gateway.collectAsStateWithLifecycle()
    val connection by vm.connection.collectAsStateWithLifecycle()
    val pushHealth by vm.pushHealth.collectAsStateWithLifecycle()
    val permissionHealth by vm.permissionHealth.collectAsStateWithLifecycle()
    val notificationHealth by vm.notificationHealth.collectAsStateWithLifecycle()
    val phoneSetupSummary by vm.phoneSetupSummary.collectAsStateWithLifecycle()
    val phoneSetupReady by vm.phoneSetupReady.collectAsStateWithLifecycle()
    val backgroundSyncing by vm.backgroundSyncing.collectAsStateWithLifecycle()
    val pushPlan by vm.pushPlan.collectAsStateWithLifecycle()
    val pushRegistrationFailed by vm.pushRegistrationFailed.collectAsStateWithLifecycle()
    val notificationIssue = notificationSetupIssue(vm.pushConfigured, pushPlan, notificationHealth, pushRegistrationFailed)
    val context = LocalContext.current
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refreshPermissions() }
    val notificationPermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        vm.onNotificationPermissionAnswered()
    }
    // Android's unused-app restrictions screen must be started for a result; the answer is re-read on return.
    val backgroundSyncingLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        vm.refreshPermissions()
    }
    // A source card's "Set up" opens the phone setup flow on that source's page.
    CompositionLocalProvider(LocalOpenPhoneSetupStep provides onOpenPhoneSetupStep) {
        SettingsContent(
            gateway = gateway,
            connection = connection,
            mode = mode,
            appVersion = vm.appVersion,
            onClose = onClose,
            onSetAppearance = vm::setAppearance,
            onSaveUrl = vm::updateUrl,
            onUnpair = { vm.unpair(onUnpaired) },
            // repair() wipes the token and flips SessionManager to Unpaired; RootScreen then swaps
            // the pairing surface forward. onRepair lets the host dismiss any settings overlay.
            onRepair = { vm.repair(); onRepair() },
            onOpenModels = onOpenModels,
            onOpenDevices = onOpenDevices,
            onOpenPolicies = onOpenPolicies,
            onOpenAccessAuthorization = onOpenAccessAuthorization,
            onOpenPrivacyPolicy = { openMobilePrivacyPolicy(context) },
            // Undelivered data from this phone's own sources. The section is drawn
            // here rather than by the banner so a healthy phone shows no chrome at
            // all — no heading over an empty card.
            deliveryBanner = {
                if (notificationIssue != null) {
                    SectionLabel("Notifications")
                    if (notificationIssue == NotificationSetupIssue.PERMISSION) {
                        // Android's side of delivery: asks for the permission while Android still would, then opens its settings.
                        NotificationHealthBanner(
                            status = notificationHealth,
                            onTurnOn = if (vm.notificationPromptAvailable()) {
                                { notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) }
                            } else {
                                null
                            },
                        ) { vm.openNotificationSettings(context) }
                    } else {
                        NotificationSetupBanner(
                            issue = notificationIssue,
                            appId = vm.pushAppId,
                            onRetry = vm::retryPushSetup,
                            onHelp = {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(NOTIFICATION_SETUP_URL)))
                            },
                        )
                    }
                    Spacer(Modifier.height(OmSpacing.md))
                }
                val visiblePermissionHealth = permissionHealthForFocus(permissionHealth, focusedSourceId)
                if (visiblePermissionHealth.any { it.actionable.isNotEmpty() }) {
                    SectionLabel("Permissions")
                    PermissionHealthBanner(
                        entries = visiblePermissionHealth,
                        labelForSourceId = vm::sourceLabel,
                        onRepair = { sourceId, capabilityId -> vm.repairPermission(context, sourceId, capabilityId) },
                    )
                    Spacer(Modifier.height(OmSpacing.md))
                } else if (focusedSourceId != null) {
                    SectionLabel("Permissions")
                    OmnesisCard(padding = OmSpacing.lg) {
                        Text(
                            "This source no longer reports the permission problem that opened Settings.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.height(OmSpacing.md))
                }
                if (!PushHealth.isHealthy(pushHealth.snapshot)) {
                    SectionLabel("Delivery")
                    OmnesisCard(padding = OmSpacing.lg) {
                        PushHealthBanner(
                            snapshot = pushHealth.snapshot,
                            retryPhase = pushHealth.retryPhase,
                            labelForSourceId = vm::sourceLabel,
                            unitLabelForSourceId = vm::sourceUnitLabel,
                            onRetry = vm::retryDelivery,
                            onDiscardUndelivered = vm::discardUndelivered,
                        )
                    }
                    Spacer(Modifier.height(OmSpacing.md))
                }
            },
            phoneSection = {
                PhoneSetupSettingsSection(
                    summary = phoneSetupSummary,
                    setupReady = phoneSetupReady,
                    backgroundSyncing = backgroundSyncing,
                    onOpenSetup = onOpenPhoneSetup,
                    onOpenBackgroundSettings = {
                        vm.backgroundSyncingIntent()?.let { intent -> backgroundSyncingLauncher.launch(intent) }
                    },
                )
            },
            // All health specifics live in :feature-health; the app just mounts the section.
            healthSection = { HealthSettingsSection() },
            // Distribution-specific sources are supplied only by the artifact that ships them.
            distributionSection = { DistributionSettingsSection() },
            // And for app usage — everything specific lives in :feature-app-usage.
            appUsageSection = { AppUsageSettingsSection() },
            // And for activity segments — everything specific lives in :feature-activity-segments.
            activitySegmentsSection = { ActivitySegmentsSettingsSection() },
            // And for photos — everything specific lives in :feature-photos.
            photosSection = { PhotosSettingsSection() },
        )
    }
}

internal fun permissionHealthForFocus(
    entries: List<PermissionHealthEntry>,
    focusedSourceId: String?,
): List<PermissionHealthEntry> =
    if (focusedSourceId == null) entries else entries.filter { it.sourceId == focusedSourceId }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsContent(
    gateway: SettingsViewModel.GatewayInfo?,
    connection: ConnectionState,
    mode: AppearanceMode,
    /**
     * What this build reports about itself. Passed in rather than read from
     * `BuildConfig` here so the screen stays free of the application module's
     * generated identity — and so a golden render quotes a fixed sample
     * instead of whatever version the machine recording it happened to build.
     */
    appVersion: AppVersionInfo,
    onClose: () -> Unit,
    onSetAppearance: (AppearanceMode) -> Unit,
    onSaveUrl: (String) -> String?,
    onUnpair: () -> Unit,
    onRepair: () -> Unit = {},
    onOpenModels: () -> Unit = {},
    onOpenDevices: () -> Unit = {},
    onOpenPolicies: () -> Unit = {},
    onOpenAccessAuthorization: () -> Unit = {},
    onOpenPrivacyPolicy: () -> Unit = {},
    /**
     * Undelivered data from this phone's own sources. A slot rather than a set
     * of fields, so this screen carries no knowledge of what "undelivered" means.
     */
    deliveryBanner: @Composable () -> Unit = {},
    /** The top of the phone-source area: reopening phone setup, and background syncing. */
    phoneSection: @Composable () -> Unit = {},
    healthSection: @Composable () -> Unit = {},
    distributionSection: @Composable () -> Unit = {},
    appUsageSection: @Composable () -> Unit = {},
    activitySegmentsSection: @Composable () -> Unit = {},
    photosSection: @Composable () -> Unit = {},
) {
    val c = OmTheme.colors
    var showUnpairConfirm by remember { mutableStateOf(false) }
    var showRepairConfirm by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Settings", style = MaterialTheme.typography.titleMedium, color = c.textPrimary) },
                actions = {
                    TextButton(onClick = onClose) {
                        Text("Done", style = MaterialTheme.typography.bodyLarge, color = c.accent)
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.bgPrimary),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .background(c.bgPrimary)
                .padding(OmSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            deliveryBanner()
            SectionLabel("Appearance")
            OmnesisCard(padding = OmSpacing.lg) {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    val modes = AppearanceMode.entries
                    modes.forEachIndexed { i, m ->
                        SegmentedButton(
                            selected = mode == m,
                            onClick = { onSetAppearance(m) },
                            shape = SegmentedButtonDefaults.itemShape(i, modes.size),
                            // No leading checkmark: iOS's native segmented picker shows only the
                            // label. The default `icon` slot draws a '✓' on the active segment.
                            icon = {},
                            // Match the iOS white-thumb selected look: the active segment fills
                            // with bgPrimary (white in light, a subtle lift in dark) and inactive
                            // segments stay transparent over the card — not Material's pale
                            // secondaryContainer tint.
                            colors = SegmentedButtonDefaults.colors(
                                activeContainerColor = c.bgPrimary,
                                activeContentColor = c.textPrimary,
                                activeBorderColor = c.border,
                                inactiveContainerColor = Color.Transparent,
                                inactiveContentColor = c.textSecondary,
                                inactiveBorderColor = c.border,
                            ),
                        ) { Text(m.label) }
                    }
                }
            }
            Text(
                "Light, Dark, or follow the system setting. Dark is the default.",
                style = MaterialTheme.typography.labelMedium,
                color = c.textSecondary,
                modifier = Modifier.padding(top = OmSpacing.sm),
            )

            if (gateway != null) {
                Spacer(Modifier.height(OmSpacing.md))
                SectionLabel("Gateway")
                // All gateway rows live on one card with hairline separators, matching the iOS
                // grouped Form section: identity and connection state, management drill-ins,
                // then Re-pair / Unpair as compact actions (not standalone page links).
                OmnesisCard(padding = OmSpacing.lg) {
                    KeyValue("Name", gateway.name)
                    UrlEditor(gateway.url, onSaveUrl)
                    Spacer(Modifier.height(OmSpacing.sm))
                    ConnectionRowLabel(connection)
                    RowDivider()
                    NavigationRow("Configure Models", onOpenModels)
                    RowDivider()
                    NavigationRow("Configure Devices", onOpenDevices)
                    RowDivider()
                    // The rules an answer is judged by sit beside the grants that name them.
                    NavigationRow("Policies", onOpenPolicies)
                    RowDivider()
                    NavigationRow("Authorize an MCP connection", onOpenAccessAuthorization)
                    RowDivider()
                    ActionRow("Re-pair with gateway", c.accent) { showRepairConfirm = true }
                    RowDivider()
                    ActionRow("Unpair", c.danger) { showUnpairConfirm = true }
                }
                Spacer(Modifier.height(OmSpacing.sm))
                Text(
                    if (gateway.tlsMode == PairingTlsMode.SYSTEM) {
                        "This pairing uses system HTTPS verification. Re-pair to change its " +
                            "hostname or authority. Re-pair wipes the token and scans a new code."
                    } else {
                        "Edit the URL if the same gateway moved to a new hostname / IP, or to reach " +
                            "it over Tailscale. Re-pair if the gateway was replaced or the token was revoked."
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = c.textSecondary,
                )
            }

            phoneSection()
            healthSection()
            distributionSection()
            appUsageSection()
            activitySegmentsSection()
            photosSection()

            Spacer(Modifier.height(OmSpacing.md))
            SectionLabel("Legal")
            OmnesisCard(padding = OmSpacing.lg) {
                NavigationRow("Mobile privacy policy", onOpenPrivacyPolicy)
            }

            Spacer(Modifier.height(OmSpacing.md))
            AboutSection(appVersion)
        }
    }

    if (showUnpairConfirm) {
        AlertDialog(
            onDismissRequest = { showUnpairConfirm = false },
            containerColor = c.bgSecondary,
            title = { Text("Unpair this device?", color = c.textPrimary) },
            text = {
                Text(
                    "You'll need to re-scan the pairing code from the gateway to reconnect. " +
                        "Indexed data on the gateway is untouched.",
                    color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = { showUnpairConfirm = false; onUnpair() }) {
                    Text("Unpair", color = c.danger)
                }
            },
            dismissButton = { TextButton(onClick = { showUnpairConfirm = false }) { Text("Cancel", color = c.accent) } },
        )
    }

    if (showRepairConfirm) {
        AlertDialog(
            onDismissRequest = { showRepairConfirm = false },
            containerColor = c.bgSecondary,
            title = { Text("Re-pair with gateway?", color = c.textPrimary) },
            text = {
                Text(
                    "This wipes the current token and starts a fresh pairing. Indexed data on " +
                        "the gateway is untouched.",
                    color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = { showRepairConfirm = false; onRepair() }) {
                    Text("Re-pair", color = c.accent)
                }
            },
            dismissButton = { TextButton(onClick = { showRepairConfirm = false }) { Text("Cancel", color = c.accent) } },
        )
    }
}

@Composable
private fun UrlEditor(currentUrl: String, onSave: (String) -> String?) {
    val c = OmTheme.colors
    var editing by remember { mutableStateOf(false) }
    var draft by remember(currentUrl) { mutableStateOf(currentUrl) }
    var error by remember { mutableStateOf<String?>(null) }
    if (!editing) {
        Row(Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs), verticalAlignment = Alignment.CenterVertically) {
            Text("URL", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
            Spacer(Modifier.width(OmSpacing.lg))
            Text(
                currentUrl,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { draft = currentUrl; error = null; editing = true }) { Text("Edit", color = c.accent) }
        }
    } else {
        Column(Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs)) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                placeholder = { Text("https://gateway.local:7600") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            error?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = c.danger,
                    modifier = Modifier.padding(top = OmSpacing.xs),
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { editing = false }) { Text("Cancel", color = c.accent) }
                TextButton(onClick = {
                    error = onSave(draft)
                    if (error == null) editing = false
                }, enabled = draft.isNotBlank()) {
                    Text("Save", color = c.accent)
                }
            }
        }
    }
}

/**
 * Every version this build can state about itself: the product version it was
 * cut from, the store's counter that separates two uploads of that version,
 * and the socket protocol a gateway either speaks or refuses. Last on the
 * screen, where a settings screen conventionally puts what it is rather than
 * what it does.
 *
 * Its own composable so a golden can render it alone: at the foot of a screen
 * this long it would otherwise never reach the captured viewport.
 */
@Composable
internal fun AboutSection(appVersion: AppVersionInfo) {
    SectionLabel("About")
    OmnesisCard(padding = OmSpacing.lg) {
        KeyValue("Version", appVersion.version)
        RowDivider()
        KeyValue("Build", appVersion.build)
        RowDivider()
        KeyValue("Wire protocol", appVersion.wireProtocol.toString())
    }
}

/**
 * Grey-caps section label (no horizontal rule — unlike the Models flat section). Uppercased,
 * 12sp semibold, 0.5sp tracking. Ports the iOS grouped-Form section header.
 */
@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium.copy(letterSpacing = 0.5.sp),
        fontWeight = FontWeight.SemiBold,
        color = OmTheme.colors.textSecondary,
        modifier = Modifier.padding(top = OmSpacing.sm, bottom = OmSpacing.xs),
    )
}

@Composable
private fun KeyValue(key: String, value: String) {
    val c = OmTheme.colors
    Row(Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(key, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
        Spacer(Modifier.width(OmSpacing.lg))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = c.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** Hairline separator between grouped card rows, echoing an iOS Form row divider. */
@Composable
private fun RowDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(vertical = OmSpacing.xs),
        thickness = 1.dp,
        color = OmTheme.colors.borderLight,
    )
}

/**
 * A tappable action row (Re-pair / Unpair) sized to the same body rhythm as [KeyValue], so it
 * reads as a list row inside the Gateway card rather than a large standalone link. Mirrors the
 * iOS Form button rows.
 */
@Composable
private fun ActionRow(label: String, tint: Color, onClick: () -> Unit) {
    Text(
        label,
        style = MaterialTheme.typography.bodyMedium,
        color = tint,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = OmSpacing.xs),
    )
}

/** A Settings drill-in row with a familiar trailing disclosure indicator. */
@Composable
private fun NavigationRow(label: String, onClick: () -> Unit) {
    val c = OmTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(onClick = onClick)
            .padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = c.accent,
            modifier = Modifier.weight(1f),
        )
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.size(20.dp),
        )
    }
}

/**
 * Connection state as an icon + word label, ported from the iOS `connectionRow`. Connected →
 * green check; Connecting/Authenticating → spinner + grey; Failed → amber triangle + reason.
 */
@Composable
private fun ConnectionRowLabel(connection: ConnectionState) {
    val c = OmTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        when (connection) {
            is ConnectionState.Connected -> {
                Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = c.success, modifier = Modifier.size(18.dp))
                Text("Connected", style = MaterialTheme.typography.bodyMedium, color = c.success)
            }
            // iOS folds disconnected/connecting/authenticating into one "Connecting…" arm — match
            // it so there's no settled grey "Disconnected" state the iOS shell never shows.
            ConnectionState.Disconnected, ConnectionState.Connecting, ConnectionState.Authenticating -> {
                OmSpinner(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = c.textSecondary)
                Text("Connecting…", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
            }
            is ConnectionState.Failed -> {
                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = c.warning, modifier = Modifier.size(18.dp))
                Text(
                    "Can't reach gateway: ${connection.message}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.warning,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * A version identity for previews and golden renders. The product version and
 * build are invented and fixed, so a release bump does not change what a
 * golden renders; the protocol number is the real one the socket speaks,
 * because that is a number a reader may check against a gateway.
 */
internal fun sampleAppVersion() = AppVersionInfo(
    version = "1.0.0",
    build = "100",
    wireProtocol = DeviceSocket.PROTOCOL_VERSION,
)

// --- previews ---

private fun sampleGateway() = SettingsViewModel.GatewayInfo(
    name = "Studio Northstar", url = "https://gateway.example.com", deviceId = "dev-abc123", scopes = listOf("read", "admin"),
)

@Preview(name = "Settings · light")
@Composable
private fun SettingsPreviewLight() {
    OmnesisTheme(darkTheme = false) {
        SettingsContent(
            gateway = sampleGateway(),
            connection = ConnectionState.Connected("d", "Studio Northstar", listOf("read", "admin")),
            mode = AppearanceMode.LIGHT,
            appVersion = sampleAppVersion(),
            onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {},
        )
    }
}

@Preview(name = "Settings · dark")
@Composable
private fun SettingsPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        SettingsContent(
            gateway = sampleGateway().copy(url = "https://gateway.tailnet.ts.net:7600"),
            connection = ConnectionState.Failed("timeout after 5s"),
            mode = AppearanceMode.DARK,
            appVersion = sampleAppVersion(),
            onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {},
        )
    }
}
