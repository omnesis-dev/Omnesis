// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Android
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Power
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material.icons.outlined.Web
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.AgentIntegrationCapability
import dev.omnesis.android.transport.dto.DeviceCapabilities
import dev.omnesis.android.transport.dto.DeviceRecord
import dev.omnesis.android.transport.dto.TokenRecord
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.PullToRefresh
import dev.omnesis.android.ui.common.TimeFormat

/**
 * Device-management screen — Android counterpart of the iOS `DevicesView` and a
 * port of the portal's Settings → Devices tab. Lists every paired device with
 * its kind, live-connection state, and paired / activity times; expanding a row reveals
 * the credentials (tokens) minted for it. Reached from the Settings Gateway card.
 *
 * Beyond listing, this surface mutates: revoke a token, revoke a device, forget
 * a revoked device (each behind a confirm), and pair a new device (one-time code +
 * generated QR). Credentials with custom scopes are issued from the CLI, so the
 * card only points there. Mutations follow the refresh-after-mutation +
 * last-action-wins notice pattern.
 */
@Composable
fun DevicesScreen(
    onBack: () -> Unit,
    onOpenSettings: () -> Unit = {},
    focusedDeviceId: String? = null,
    vm: DevicesViewModel = hiltViewModel(),
) {
    BackHandler(onBack = onBack)
    val devices by vm.devices.collectAsStateWithLifecycle()
    val tokens by vm.tokens.collectAsStateWithLifecycle()
    val notice by vm.notice.collectAsStateWithLifecycle()
    val pair by vm.pair.collectAsStateWithLifecycle()
    val thisDeviceId by vm.thisDeviceId.collectAsStateWithLifecycle()

    DevicesContent(
        devices = devices,
        thisDeviceId = thisDeviceId,
        tokens = tokens,
        notice = notice,
        onBack = onBack,
        onRetry = vm::load,
        onRefresh = vm::load,
        onExpand = vm::loadTokens,
        onRevokeToken = vm::revokeToken,
        onRevokeDevice = vm::revokeDevice,
        onForgetDevice = vm::forgetDevice,
        onRepairDevice = vm::openRepair,
        onPair = vm::openPair,
        onDismissNotice = vm::dismissNotice,
        onOpenSettings = onOpenSettings,
        focusedDeviceId = focusedDeviceId,
    )

    pair?.let { state ->
        PairDeviceSheet(
            state = state,
            onPair = vm::pairDevice,
            onSelectHost = vm::selectPairHost,
            onDismiss = vm::closePair,
            repairTarget = state.repairTarget,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesContent(
    devices: Loadable<List<DeviceRecord>>,
    thisDeviceId: String? = null,
    tokens: Map<String, Loadable<List<TokenRecord>>>,
    notice: DevicesViewModel.Notice? = null,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onRefresh: () -> Unit = onRetry,
    onExpand: (String) -> Unit = {},
    onRevokeToken: (String, String) -> Unit = { _, _ -> },
    onRevokeDevice: (DeviceRecord) -> Unit = {},
    onForgetDevice: (DeviceRecord) -> Unit = {},
    onRepairDevice: (DeviceRecord) -> Unit = {},
    onPair: () -> Unit = {},
    onDismissNotice: () -> Unit = {},
    onOpenSettings: () -> Unit = {},
    otherExpanded: Boolean = false,
    focusedDeviceId: String? = null,
) {
    val c = OmTheme.colors
    // Destructive-confirm targets (null = no dialog open).
    var revokeDeviceConfirm by remember { mutableStateOf<DeviceRecord?>(null) }
    var forgetDeviceConfirm by remember { mutableStateOf<DeviceRecord?>(null) }
    var revokeTokenConfirm by remember { mutableStateOf<Pair<String, String>?>(null) }

    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Outlined.ArrowBack,
                            contentDescription = "Back to Settings",
                            tint = c.accent,
                        )
                    }
                },
                title = { Text("Devices", style = MaterialTheme.typography.titleMedium, color = c.textPrimary) },
                actions = {
                    IconButton(onClick = onPair) {
                        Icon(Icons.Outlined.Add, contentDescription = "Pair a device", tint = c.textPrimary)
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = c.bgPrimary,
                    scrolledContainerColor = c.bgPrimary,
                ),
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().background(c.bgPrimary)) {
            when (devices) {
                Loadable.Loading -> LoadingView()
                is Loadable.Error -> GatewayErrorView(
                    context = "load devices",
                    error = devices.throwable,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                is Loadable.Content -> {
                    if (devices.value.isEmpty()) {
                        DevicesEmpty()
                    } else {
                        PullToRefresh(refreshing = devices.refreshing, onRefresh = onRefresh) {
                            DevicesList(
                                devices = devices.value,
                                thisDeviceId = thisDeviceId,
                                tokens = tokens,
                                notice = notice,
                                onExpand = onExpand,
                                onRevokeDevice = { revokeDeviceConfirm = it },
                                onForgetDevice = { forgetDeviceConfirm = it },
                                onRepairDevice = onRepairDevice,
                                onRevokeToken = { tokenId, deviceId -> revokeTokenConfirm = tokenId to deviceId },
                                onDismissNotice = onDismissNotice,
                                otherExpanded = otherExpanded,
                                focusedDeviceId = focusedDeviceId,
                            )
                        }
                    }
                }
            }
        }
    }

    revokeDeviceConfirm?.let { device ->
        ConfirmDialog(
            title = "Revoke device?",
            body = "This revokes ${device.name} and all of its tokens. It must be re-paired to talk to the gateway again.",
            confirmLabel = "Revoke",
            onConfirm = { onRevokeDevice(device); revokeDeviceConfirm = null },
            onDismiss = { revokeDeviceConfirm = null },
        )
    }
    forgetDeviceConfirm?.let { device ->
        ConfirmDialog(
            title = "Forget ${device.name}?",
            body = "Deletes the device for good. A device that still hosts sources is refused — remove those sources first.",
            confirmLabel = "Forget",
            onConfirm = { onForgetDevice(device); forgetDeviceConfirm = null },
            onDismiss = { forgetDeviceConfirm = null },
        )
    }
    revokeTokenConfirm?.let { (tokenId, deviceId) ->
        ConfirmDialog(
            title = "Revoke token?",
            body = "Any process still using this token will start getting 401s on its next request.",
            confirmLabel = "Revoke",
            onConfirm = { onRevokeToken(tokenId, deviceId); revokeTokenConfirm = null },
            onDismiss = { revokeTokenConfirm = null },
        )
    }
}

@Composable
private fun ConfirmDialog(
    title: String,
    body: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = OmTheme.colors
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.bgSecondary,
        title = { Text(title, color = c.textPrimary) },
        text = { Text(body, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) },
        confirmButton = {
            androidx.compose.material3.TextButton(onClick = onConfirm) { Text(confirmLabel, color = c.danger) }
        },
        dismissButton = {
            androidx.compose.material3.TextButton(onClick = onDismiss) { Text("Cancel", color = c.accent) }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PairDeviceSheet(
    state: DevicesViewModel.PairState,
    onPair: (String) -> Unit,
    onSelectHost: (Int) -> Unit,
    onDismiss: () -> Unit,
    repairTarget: DeviceRecord?,
) {
    val sheetState = androidx.compose.material3.rememberModalBottomSheetState(skipPartiallyExpanded = true)
    androidx.compose.material3.ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = OmTheme.colors.bgPrimary,
    ) {
        PairDeviceContent(
            pending = state.pending,
            kind = state.kind,
            gatewayUrl = state.gatewayUrl,
            identities = state.identities,
            selectedHostIdx = state.selectedHostIdx,
            qrPayload = state.qrPayload,
            qrError = state.qrError,
            submitting = state.submitting,
            error = state.error,
            onPair = onPair,
            onSelectHost = onSelectHost,
            repairTarget = repairTarget,
        )
    }
}

@Composable
private fun DevicesList(
    devices: List<DeviceRecord>,
    thisDeviceId: String?,
    tokens: Map<String, Loadable<List<TokenRecord>>>,
    notice: DevicesViewModel.Notice?,
    onExpand: (String) -> Unit,
    onRevokeDevice: (DeviceRecord) -> Unit,
    onForgetDevice: (DeviceRecord) -> Unit,
    onRepairDevice: (DeviceRecord) -> Unit,
    onRevokeToken: (String, String) -> Unit,
    onDismissNotice: () -> Unit,
    otherExpanded: Boolean,
    focusedDeviceId: String?,
) {
    var showOther by remember { mutableStateOf(otherExpanded || focusedDeviceId != null) }
    val grouped = remember(devices, thisDeviceId) { DeviceGrouping.group(devices, thisDeviceId) }
    LaunchedEffect(focusedDeviceId, devices) {
        if (focusedDeviceId != null && devices.any { it.id == focusedDeviceId }) {
            onExpand(focusedDeviceId)
        }
    }

    LazyColumn(
        Modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item("stats") { DevicesStatsBar(devices) }
        // A notice about one device is rendered in that device's card instead:
        // the only affordance that can refuse — Forget, on a revoked device —
        // lives in a group the user had to scroll to and expand, so a banner
        // pinned to the top of the list would paint off-screen.
        notice?.takeIf { it.deviceId == null }?.let { n ->
            item("notice") { NoticeBanner(n, onDismissNotice) }
        }

        grouped.thisDevice?.let { device ->
            item("h-this") { GroupHeader("This device", null) }
            item("c-${device.id}") {
                DeviceCardItem(device, true, tokens[device.id], notice, onExpand, onRevokeDevice, onForgetDevice, onRepairDevice, onRevokeToken)
            }
        }

        item("h-live") { GroupHeader("Live connections", grouped.live.size) }
        if (grouped.live.isEmpty()) {
            item("connected-empty") {
                Text("No other live connections right now.", fontSize = 12.sp, color = OmTheme.colors.textMuted)
            }
        } else {
            items(grouped.live, key = { "l-${it.id}" }) { device ->
                DeviceCardItem(device, false, tokens[device.id], notice, onExpand, onRevokeDevice, onForgetDevice, onRepairDevice, onRevokeToken)
            }
        }

        if (grouped.other.isNotEmpty()) {
            item("h-other") {
                OtherDevicesToggle(grouped.other.size, showOther) { showOther = !showOther }
            }
            if (showOther) {
                items(grouped.other, key = { "o-${it.id}" }) { device ->
                    DeviceCardItem(device, false, tokens[device.id], notice, onExpand, onRevokeDevice, onForgetDevice, onRepairDevice, onRevokeToken)
                }
            }
        }

        item("footer") {
            Text(
                "Tap a device to see its credentials.",
                fontSize = 11.sp,
                color = OmTheme.colors.textMuted,
                modifier = Modifier.padding(top = OmSpacing.sm),
            )
        }
    }
}

@Composable
private fun DeviceCardItem(
    device: DeviceRecord,
    isThis: Boolean,
    tokens: Loadable<List<TokenRecord>>?,
    notice: DevicesViewModel.Notice?,
    onExpand: (String) -> Unit,
    onRevokeDevice: (DeviceRecord) -> Unit,
    onForgetDevice: (DeviceRecord) -> Unit,
    onRepairDevice: (DeviceRecord) -> Unit,
    onRevokeToken: (String, String) -> Unit,
) {
    DeviceCard(
        device = device,
        isThis = isThis,
        tokens = tokens,
        failure = notice?.takeIf { it.deviceId == device.id && !it.ok }?.text,
        onExpand = { onExpand(device.id) },
        onRevokeDevice = { onRevokeDevice(device) },
        onForgetDevice = { onForgetDevice(device) },
        onRepairDevice = { onRepairDevice(device) },
        onRevokeToken = { tokenId -> onRevokeToken(tokenId, device.id) },
    )
}

@Composable
private fun GroupHeader(title: String, count: Int?) {
    val c = OmTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(top = OmSpacing.sm),
    ) {
        Text(
            title.uppercase(),
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.5.sp,
            color = c.textMuted,
        )
        if (count != null) CountPill(count)
    }
}

@Composable
private fun CountPill(n: Int) {
    val c = OmTheme.colors
    Text(
        n.toString(),
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        color = c.textSecondary,
        modifier = Modifier
            .clip(CircleShape)
            .background(c.bgTertiary)
            .padding(horizontal = 7.dp, vertical = 1.dp),
    )
}

@Composable
private fun OtherDevicesToggle(count: Int, expanded: Boolean, onToggle: () -> Unit) {
    val c = OmTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .clickable { onToggle() }
            .padding(top = OmSpacing.sm),
    ) {
        Icon(
            if (expanded) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.size(16.dp),
        )
        Text(
            "OTHER DEVICES",
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.5.sp,
            color = c.textMuted,
        )
        CountPill(count)
    }
}

@Composable
private fun NoticeBanner(notice: DevicesViewModel.Notice, onDismiss: () -> Unit) {
    val c = OmTheme.colors
    val tint = if (notice.ok) c.success else c.danger
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(tint.copy(alpha = 0.10f))
            .border(1.dp, tint.copy(alpha = 0.4f), RoundedCornerShape(OmRadius.medium))
            .clickable { onDismiss() }
            .padding(OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(notice.text, fontSize = 12.sp, color = tint, modifier = Modifier.weight(1f))
    }
}

/** The refusal, in the card that produced it. */
@Composable
private fun CardFailure(text: String) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(c.danger.copy(alpha = 0.10f))
            .border(1.dp, c.danger.copy(alpha = 0.4f), RoundedCornerShape(OmRadius.medium))
            .padding(OmSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            Icons.Outlined.Warning,
            contentDescription = null,
            tint = c.danger,
            modifier = Modifier.size(14.dp),
        )
        Text(text, fontSize = 12.sp, color = c.danger, modifier = Modifier.weight(1f))
    }
}

@Composable
private fun DevicesStatsBar(devices: List<DeviceRecord>) {
    val live = DeviceGrouping.liveConnectionCount(devices)
    val revoked = DeviceGrouping.revokedCount(devices)
    Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        StatChip(devices.size, if (devices.size == 1) "device" else "devices")
        StatChip(live, if (live == 1) "live connection" else "live connections")
        if (revoked > 0) StatChip(revoked, "revoked")
    }
}

@Composable
private fun StatChip(value: Int, label: String) {
    val c = OmTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            value.toString(),
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
            style = TextStyle(fontFeatureSettings = "tnum"),
        )
        Text(label, fontSize = 12.sp, color = c.textMuted)
    }
}

// --- Device card (header + expandable token list) --------------------------

@Composable
fun DeviceCard(
    device: DeviceRecord,
    tokens: Loadable<List<TokenRecord>>?,
    isThis: Boolean = false,
    /**
     * Why the last action on this device failed, rendered under the header so
     * the message lands where the action was taken rather than at the top of a
     * list the card may be scrolled far below.
     */
    failure: String? = null,
    onExpand: () -> Unit = {},
    onRevokeDevice: () -> Unit = {},
    onForgetDevice: () -> Unit = {},
    onRepairDevice: () -> Unit = {},
    onRevokeToken: (String) -> Unit = {},
    startExpanded: Boolean = false,
) {
    val c = OmTheme.colors
    var expanded by remember { mutableStateOf(startExpanded) }

    // Trigger the lazy token fetch the first time the row opens.
    LaunchedEffect(expanded) {
        if (expanded) onExpand()
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.large))
            .background(c.bgSecondary)
            .border(
                if (isThis) 1.5.dp else 1.dp,
                if (isThis) c.accent else c.border,
                RoundedCornerShape(OmRadius.large),
            )
            .clickable { expanded = !expanded }
            .padding(OmSpacing.md),
    ) {
        DeviceHeader(
            device,
            expanded,
            isThis = isThis,
            onRevokeDevice = onRevokeDevice,
            onForgetDevice = onForgetDevice,
            onRepairDevice = onRepairDevice,
        )
        failure?.let {
            Spacer(Modifier.height(OmSpacing.sm))
            CardFailure(it)
        }
        AnimatedVisibility(visible = expanded) {
            Column {
                Spacer(Modifier.height(OmSpacing.md))
                androidx.compose.material3.HorizontalDivider(thickness = 1.dp, color = c.borderLight)
                Spacer(Modifier.height(OmSpacing.md))
                DeviceTimesRow(device, isThis = isThis)
                Spacer(Modifier.height(OmSpacing.sm))
                Text(
                    device.id,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    color = c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(OmSpacing.sm))
                TokenSection(tokens, onRevokeToken = onRevokeToken)
                // The pointer sits under the loaded list, never beside the
                // spinner or an error; a revoked device can take no new
                // credential, so it gets no pointer at all.
                if (!device.revoked && tokens is Loadable.Content) {
                    Spacer(Modifier.height(OmSpacing.sm))
                    CliCredentialsFootnote()
                }
            }
        }
    }
}

@Composable
private fun DeviceHeader(
    device: DeviceRecord,
    expanded: Boolean,
    isThis: Boolean = false,
    onRevokeDevice: () -> Unit = {},
    onForgetDevice: () -> Unit = {},
    onRepairDevice: () -> Unit = {},
) {
    val c = OmTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        Icon(
            DeviceKindMeta.icon(device.kind),
            contentDescription = null,
            tint = c.textSecondary,
            modifier = Modifier.size(20.dp),
        )
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    device.name,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (isThis) ThisDeviceBadge()
                if (device.revoked) RevokedBadge()
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(DeviceKindMeta.label(device.kind), fontSize = 11.sp, color = c.textMuted)
                val integration = device.capabilities?.agentIntegration
                val host = device.capabilities?.hostname
                if (integration != null) {
                    Text(
                        "· ${agentHarnessLabel(integration.harness)}",
                        fontSize = 11.sp,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                } else if (!host.isNullOrBlank()) {
                    Text(
                        "· $host",
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        color = c.textMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            StatusLabel(device, isThis = isThis)
        }
        DeviceMenu(
            repairable = device.kind != "portal",
            repairEnabled = !isThis && device.online != true,
            revoked = device.revoked,
            onRepairDevice = onRepairDevice,
            onRevokeDevice = onRevokeDevice,
            onForgetDevice = onForgetDevice,
        )
        Icon(
            if (expanded) Icons.Outlined.KeyboardArrowUp else Icons.Outlined.KeyboardArrowDown,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun ThisDeviceBadge() {
    val c = OmTheme.colors
    Text(
        "THIS DEVICE",
        fontSize = 9.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.3.sp,
        color = c.accent,
        modifier = Modifier
            .clip(CircleShape)
            .border(1.dp, c.accent.copy(alpha = 0.5f), CircleShape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

/** Revocation keeps the row: the only thing left to do with it is forget it. */
@Composable
private fun RevokedBadge() {
    val c = OmTheme.colors
    Text(
        "REVOKED",
        fontSize = 9.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.3.sp,
        color = c.danger,
        modifier = Modifier
            .clip(CircleShape)
            .border(1.dp, c.danger.copy(alpha = 0.5f), CircleShape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

/** Offline non-portal devices can be repaired; revoked devices can also be forgotten. */
@Composable
private fun DeviceMenu(
    repairable: Boolean,
    repairEnabled: Boolean,
    revoked: Boolean,
    onRepairDevice: () -> Unit,
    onRevokeDevice: () -> Unit,
    onForgetDevice: () -> Unit,
) {
    val c = OmTheme.colors
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.size(28.dp)) {
            Icon(Icons.Outlined.MoreVert, contentDescription = "Device actions", tint = c.textMuted, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (repairable) {
                DropdownMenuItem(
                    text = { Text("Repair device") },
                    enabled = repairEnabled,
                    onClick = { open = false; onRepairDevice() },
                )
            }
            if (revoked) {
                DropdownMenuItem(
                    text = { Text("Forget device", color = c.danger) },
                    onClick = { open = false; onForgetDevice() },
                )
            } else {
                DropdownMenuItem(
                    text = { Text("Revoke device", color = c.danger) },
                    onClick = { open = false; onRevokeDevice() },
                )
            }
        }
    }
}

/** Revocation first, then current-client activity, live transport for others, then last activity. */
@Composable
private fun StatusLabel(device: DeviceRecord, isThis: Boolean) {
    val c = OmTheme.colors
    val activeNow = !device.revoked && (isThis || device.online == true)
    val fg = when {
        device.revoked -> c.danger
        activeNow -> c.success
        else -> c.textMuted
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(fg))
        Text(
            DeviceGrouping.statusLine(device, isCurrent = isThis),
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            color = fg,
            maxLines = 1,
        )
    }
}

@Composable
private fun DeviceTimesRow(device: DeviceRecord, isThis: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        MetaPair("Paired", TimeFormat.relative(device.pairedAt))
        MetaPair(
            "Last activity",
            if (isThis) "now" else device.lastSeenAt?.let { TimeFormat.relative(it) } ?: "not recorded",
        )
    }
}

@Composable
private fun MetaPair(label: String, value: String) {
    val c = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label, fontSize = 10.sp, color = c.textMuted)
        Text(value, fontSize = 12.sp, color = c.textSecondary)
    }
}

// --- Token section ---------------------------------------------------------

@Composable
private fun TokenSection(tokens: Loadable<List<TokenRecord>>?, onRevokeToken: (String) -> Unit = {}) {
    val c = OmTheme.colors
    when (tokens) {
        null, Loadable.Loading -> Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            OmSpinner(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = c.textMuted)
            Text("Loading tokens…", fontSize = 12.sp, color = c.textMuted)
        }
        is Loadable.Error -> Text(
            "Couldn't load tokens",
            fontSize = 12.sp,
            color = c.warning,
        )
        is Loadable.Content -> {
            if (tokens.value.isEmpty()) {
                Text("No tokens", fontSize = 12.sp, color = c.textMuted)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                    Text(
                        "CREDENTIALS",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 0.6.sp,
                        color = c.textMuted,
                    )
                    tokens.value.forEach { TokenRow(it, onRevoke = { onRevokeToken(it.id) }) }
                }
            }
        }
    }
}

/**
 * Where to get another credential. The app only lists and revokes them;
 * credentials with custom scopes are issued from the CLI.
 */
@Composable
private fun CliCredentialsFootnote() {
    val c = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("Extra credentials are issued from the CLI:", fontSize = 11.sp, color = c.textMuted)
        Text(
            "omnesis tokens create --device <device> --scopes …",
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            color = c.textMuted,
        )
    }
}

@Composable
private fun TokenRow(token: TokenRecord, onRevoke: () -> Unit = {}) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(c.bgTertiary)
            .padding(OmSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Outlined.VpnKey, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(12.dp))
            val labelled = !token.name.isNullOrBlank()
            Text(
                if (labelled) token.name!! else "unlabeled",
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = if (labelled) c.textPrimary else c.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(
                "Revoke",
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.danger,
                modifier = Modifier.clickable { onRevoke() }.padding(start = 6.dp),
            )
        }
        if (token.scopes.isNotEmpty()) {
            ScopeChipRow(token.scopes)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            Text("created ${TimeFormat.relative(token.createdAt)}", fontSize = 10.sp, color = c.textMuted)
            Text("used ${TimeFormat.relative(token.lastUsedAt ?: 0L)}", fontSize = 10.sp, color = c.textMuted)
        }
    }
}

/**
 * Wrapped row of scope chips. Scope strings are the gateway's canonical
 * vocabulary (`read`, `admin`, `write:*`, `write:<type>`, …) — rendered
 * verbatim so the labels match the portal's `ScopeChip`.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ScopeChipRow(scopes: List<String>) {
    val c = OmTheme.colors
    FlowRow(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        scopes.forEach { scope ->
            val admin = scope == "admin" || scope.startsWith("admin:")
            Text(
                scope,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Medium,
                color = if (admin) c.accentHover else c.textSecondary,
                modifier = Modifier
                    .clip(RoundedCornerShape(OmRadius.small))
                    .background(if (admin) c.accent.copy(alpha = 0.15f) else c.bgSecondary)
                    .border(1.dp, c.border, RoundedCornerShape(OmRadius.small))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
    }
}

// --- Device-kind display metadata ------------------------------------------

/**
 * Generic device-kind → (label, icon) mapping. Device kinds are a gateway
 * concept (`collector`, `cli`, `portal`, `ios`, `android`, `agent`), not
 * source-specific, so this lives in shared UI; it mirrors the portal's
 * `KIND_LABELS` / `KindIcon`.
 */
object DeviceKindMeta {
    fun label(kind: String): String = when (kind) {
        "collector" -> "Collector"
        "cli" -> "CLI"
        "portal" -> "Portal"
        "ios" -> "iOS app"
        "android" -> "Android app"
        "agent" -> "Agent integration"
        "integration" -> "Integration"
        "browser" -> "Browser extension"
        else -> kind
    }

    fun icon(kind: String): ImageVector = when (kind) {
        // The collector is the physical host machine running the sync engine,
        // not a data store — a laptop, matching the portal + iOS collector icon.
        "collector" -> Icons.Outlined.Laptop
        "cli" -> Icons.Outlined.Terminal
        // The portal is the web UI in a browser — a browser window, matching the
        // portal's own window glyph and iOS's `macwindow`.
        "portal" -> Icons.Outlined.Web
        "ios" -> Icons.Outlined.Smartphone
        // The Android robot marks an Android device, matching the portal's
        // bugdroid glyph; a generic phone wouldn't tell it apart from an iPhone.
        "android" -> Icons.Outlined.Android
        "agent" -> Icons.Outlined.Hub
        // Third-party code plugged into Omnesis, matching the portal's plug glyph.
        "integration" -> Icons.Outlined.Power
        "browser" -> Icons.Outlined.Extension
        else -> Icons.Outlined.Devices
    }

    /**
     * Whether pairing this kind is done by scanning a QR with an Omnesis app.
     * Only the mobile apps consume the QR payload; a CLI/portal/collector pairs
     * by exchanging the raw code, so showing them a "scan with the app" QR is
     * misleading. Mirrors the portal gating the QR on `kind === "ios"`.
     */
    fun usesQr(kind: String?): Boolean = kind == "ios" || kind == "android"
}

private fun agentHarnessLabel(harness: String): String = when (harness.lowercase()) {
    "openclaw" -> "OpenClaw"
    "hermes" -> "Hermes"
    else -> harness
}

@Composable
private fun DevicesEmpty() {
    val c = OmTheme.colors
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Outlined.Devices, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(36.dp))
        Spacer(Modifier.height(10.dp))
        Text("No devices", style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
        Spacer(Modifier.height(4.dp))
        Text(
            "Paired phones, collectors, and CLI sessions show up here once they connect to the gateway.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

// --- Previews --------------------------------------------------------------

private fun sampleDevices(): List<DeviceRecord> = listOf(
    DeviceRecord(
        id = "dev-collector-1",
        name = "Studio Desktop",
        kind = "collector",
        pairedAt = System.currentTimeMillis() - 86_400_000L * 30,
        lastSeenAt = System.currentTimeMillis() - 45_000L,
        capabilities = DeviceCapabilities(hostname = "studio-desktop.local"),
        online = true,
    ),
    DeviceRecord(
        id = "dev-android-1",
        name = "Maya's Phone",
        kind = "android",
        pairedAt = System.currentTimeMillis() - 86_400_000L * 5,
        lastSeenAt = System.currentTimeMillis() - 600_000L,
        online = false,
    ),
    DeviceRecord(
        id = "dev-agent-1",
        name = "Northstar Agent",
        kind = "agent",
        pairedAt = System.currentTimeMillis() - 86_400_000L * 2,
        lastSeenAt = System.currentTimeMillis() - 120_000L,
        capabilities = DeviceCapabilities(
            agentIntegration = AgentIntegrationCapability(
                harness = "openclaw",
                maxConcurrentRuns = 2,
            ),
        ),
        online = true,
    ),
)

private fun sampleTokens(): Map<String, Loadable<List<TokenRecord>>> = mapOf(
    "dev-collector-1" to Loadable.Content(
        listOf(
            TokenRecord(
                id = "tok-1",
                deviceId = "dev-collector-1",
                name = "initial",
                scopes = listOf("admin", "write:*"),
                createdAt = System.currentTimeMillis() - 86_400_000L * 30,
                lastUsedAt = System.currentTimeMillis() - 45_000L,
            ),
            TokenRecord(
                id = "tok-2",
                deviceId = "dev-collector-1",
                name = null,
                scopes = listOf("read"),
                createdAt = System.currentTimeMillis() - 86_400_000L * 12,
                lastUsedAt = null,
            ),
        ),
    ),
)

@Preview(name = "Devices · list · dark")
@Composable
private fun DevicesPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        DevicesContent(
            devices = Loadable.Content(sampleDevices()),
            tokens = sampleTokens(),
            onBack = {}, onRetry = {},
        )
    }
}

@Preview(name = "Devices · empty · dark")
@Composable
private fun DevicesEmptyPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        DevicesContent(
            devices = Loadable.Content(emptyList()),
            tokens = emptyMap(),
            onBack = {}, onRetry = {},
        )
    }
}
