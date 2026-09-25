// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.BugReport
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.PauseCircle
import androidx.compose.material.icons.outlined.PlayCircle
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.NoticeButton
import dev.omnesis.android.designsystem.components.NoticeGroup
import dev.omnesis.android.designsystem.components.NoticeSeverity
import dev.omnesis.android.designsystem.components.NoticeSheet
import dev.omnesis.android.designsystem.components.NoticeUi
import dev.omnesis.android.designsystem.components.OmnesisStatePill
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable

@Composable
fun SourceDetailScreen(
    onBack: () -> Unit,
    onOpenRecent: (String) -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: SourceDetailViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    SourceDetailContent(
        state = state,
        onBack = onBack,
        onRetry = vm::load,
        onOpenRecent = { onOpenRecent(vm.sourceId) },
        onOpenSettings = onOpenSettings,
        onSyncNow = vm::syncNow,
        onTogglePause = vm::togglePause,
        onResync = vm::resync,
        onRemove = vm::remove,
        onLoadDebug = vm::loadDebug,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SourceDetailContent(
    state: Loadable<SourceDetailUi>,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onOpenRecent: () -> Unit,
    onOpenSettings: () -> Unit = {},
    onSyncNow: () -> Unit = {},
    onTogglePause: () -> Unit = {},
    onResync: () -> Unit = {},
    onRemove: () -> Unit = {},
    onLoadDebug: () -> Unit = {},
) {
    val c = OmTheme.colors
    val title = (state as? Loadable.Content)?.value?.label ?: "Source"
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back", tint = c.accent)
                    }
                },
                title = {
                    Text(title, style = MaterialTheme.typography.titleMedium, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = c.bgPrimary,
                    navigationIconContentColor = c.accent,
                    titleContentColor = c.textPrimary,
                ),
            )
        },
    ) { padding ->
        when (state) {
            Loadable.Loading -> LoadingView(Modifier.padding(padding))
            is Loadable.Error -> if (state.throwable is SourceNoLongerAvailable) {
                Column(Modifier.padding(padding).padding(OmSpacing.lg), verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
                    Text("Source removed", color = c.textPrimary, style = MaterialTheme.typography.titleMedium)
                    Text("Managed gateway data is being deleted or cleanup has finished. Re-add is blocked while cleanup runs. Originals, backups and exports remain.", color = c.textSecondary)
                    TextButton(onClick = onBack) { Text("Back to sources") }
                }
            } else GatewayErrorView(
                context = "load this source",
                error = state.throwable,
                onRetry = onRetry,
                onOpenSettings = onOpenSettings,
                modifier = Modifier.padding(padding),
            )
            is Loadable.Content -> DetailBody(
                state.value,
                Modifier.padding(padding),
                onOpenRecent = onOpenRecent,
                onSyncNow = onSyncNow,
                onTogglePause = onTogglePause,
                onResync = onResync,
                onRemove = onRemove,
                onLoadDebug = onLoadDebug,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DetailBody(
    detail: SourceDetailUi,
    modifier: Modifier,
    onOpenRecent: () -> Unit,
    onSyncNow: () -> Unit,
    onTogglePause: () -> Unit,
    onResync: () -> Unit,
    onRemove: () -> Unit,
    onLoadDebug: () -> Unit,
) {
    val c = OmTheme.colors
    var showRemoveConfirm by remember { mutableStateOf(false) }
    var showResyncConfirm by remember { mutableStateOf(false) }
    var showDebug by remember { mutableStateOf(false) }
    var noticesFor by remember { mutableStateOf<NoticeSheetKey?>(null) }

    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        // Header
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            SourceIcon(detail.icon, size = 44.dp)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(detail.label, fontSize = 20.sp, fontWeight = FontWeight.Bold, color = c.textPrimary)
                Text(
                    detail.accountId,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = c.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.weight(1f))
        }

        StatusSection(detail, onOpenSourceNotices = { noticesFor = NoticeSheetKey.Source })

        ActionsSection(
            paused = detail.paused,
            inFlight = detail.actionInFlight,
            isInternal = detail.isInternal,
            onSyncNow = onSyncNow,
            onTogglePause = onTogglePause,
            onDebug = { showDebug = true; onLoadDebug() },
            onResync = { showResyncConfirm = true },
            onRemove = { showRemoveConfirm = true },
            onOpenRecent = onOpenRecent,
        )

        detail.actionError?.let { ErrorLabel(it) }

        AboutSection(detail, onOpenDeviceNotices = { noticesFor = NoticeSheetKey.Device(it) })
    }

    if (showRemoveConfirm) {
        RemoveSourceDialog(
            label = detail.label,
            onConfirm = { showRemoveConfirm = false; onRemove() },
            onDismiss = { showRemoveConfirm = false },
        )
    }
    if (showResyncConfirm) {
        ConfirmDialog(
            title = "Resync this source?",
            body = "This deletes the source's documents and refetches everything from scratch.",
            confirmLabel = "Resync",
            onConfirm = { showResyncConfirm = false; onResync() },
            onDismiss = { showResyncConfirm = false },
        )
    }
    if (showDebug) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = { showDebug = false },
            sheetState = sheetState,
            containerColor = c.bgPrimary,
        ) {
            DebugSheetBody(detail.debug)
        }
    }
    noticeSheetContent(detail, noticesFor)?.let { (title, notices) ->
        NoticeSheet(
            title = title,
            groups = listOf(NoticeGroup(deviceLabel = null, notices = notices)),
            onDismiss = { noticesFor = null },
        )
    }
}

/** Whose notices the open sheet lists: one host device, or those no host device claims. */
private sealed interface NoticeSheetKey {
    data object Source : NoticeSheetKey
    data class Device(val id: String) : NoticeSheetKey
}

/**
 * Title and notices for the open sheet, resolved against the current [detail] so a live
 * update shows the latest notices; `null` when [key] names nothing with notices.
 */
private fun noticeSheetContent(detail: SourceDetailUi, key: NoticeSheetKey?): Pair<String, List<NoticeUi>>? {
    val (title, notices) = when (key) {
        null -> return null
        NoticeSheetKey.Source -> detail.label to detail.notices
        is NoticeSheetKey.Device ->
            detail.hostDevices.firstOrNull { it.id == key.id }?.let { hostDeviceLabel(it) to it.notices } ?: return null
    }
    return if (notices.isEmpty()) null else title to notices
}

private fun hostDeviceLabel(device: SourceHostDeviceUi): String = device.name ?: shortDeviceId(device.id)

// MARK: - Status

@Composable
private fun StatusSection(detail: SourceDetailUi, onOpenSourceNotices: () -> Unit) {
    val c = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        SectionHeaderRule("STATUS") {
            // Notices no host device claims sit beside the pill; per-device ones sit
            // beside their device under ABOUT.
            NoticeButton(detail.notices, target = detail.label, onOpen = onOpenSourceNotices)
            OmnesisStatePill(
                state = detail.syncState,
                paused = detail.paused,
                label = stateLabel(detail.syncState, detail.paused),
            )
        }
        detail.lastSyncAt?.let { KV("Last sync", formatTimeAgo(it) ?: it) }
        detail.unit?.let { KV("Unit", it) }
        if (detail.syncState == "syncing") {
            val progressText = when {
                detail.progressTotal != null && detail.progressDone != null -> "${detail.progressDone} / ${detail.progressTotal}"
                detail.progressDone != null -> "${detail.progressDone} processed"
                else -> null
            }
            progressText?.let { KV("Progress", it) }
            detail.progressPercent?.let { OmProgressBar(it) }
            detail.progressMessage?.let {
                Text(it, fontSize = 11.sp, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        detail.percentIndexed?.let { pct ->
            val p = pct.coerceIn(0.0, 100.0)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Indexed", fontSize = 12.sp, color = c.textSecondary)
                Spacer(Modifier.weight(1f))
                Text(
                    "${p.toInt()}%",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (p >= 100.0) c.success else c.warning,
                    style = MaterialTheme.typography.bodySmall.copy(fontFeatureSettings = "tnum"),
                )
            }
        }
    }
}

// MARK: - Actions

@Composable
private fun ActionsSection(
    paused: Boolean,
    inFlight: Boolean,
    isInternal: Boolean = false,
    onSyncNow: () -> Unit,
    onTogglePause: () -> Unit,
    onDebug: () -> Unit,
    onResync: () -> Unit,
    onRemove: () -> Unit,
    onOpenRecent: () -> Unit,
) {
    val c = OmTheme.colors
    // Gateway-internal sources have no sync engine, registration or host
    // device to act on — Recent items is the whole section. Document
    // deletion lives on that screen.
    Column {
        if (!isInternal) {
            ActionRow(
                icon = Icons.Outlined.Sync,
                label = if (inFlight) "Working…" else "Sync now",
                labelColor = c.accent,
                iconColor = c.accent,
                showChevron = !inFlight,
                enabled = !inFlight,
                onClick = onSyncNow,
            )
            ActionDivider()
            ActionRow(
                icon = if (paused) Icons.Outlined.PlayCircle else Icons.Outlined.PauseCircle,
                label = if (paused) "Resume all devices" else "Pause all devices · keep data",
                labelColor = c.textPrimary,
                iconColor = c.textPrimary,
                showChevron = !inFlight,
                enabled = !inFlight,
                onClick = onTogglePause,
            )
            ActionDivider()
            ActionRow(
                icon = Icons.Outlined.BugReport,
                label = "Debug",
                labelColor = c.textPrimary,
                iconColor = c.textPrimary,
                showChevron = !inFlight,
                enabled = !inFlight,
                onClick = onDebug,
            )
            ActionDivider()
            ActionRow(
                icon = Icons.Outlined.RestartAlt,
                label = "Resync",
                labelColor = c.danger,
                iconColor = c.danger,
                showChevron = !inFlight,
                enabled = !inFlight,
                onClick = onResync,
            )
            ActionDivider()
            ActionRow(
                icon = Icons.Outlined.Delete,
                label = "Remove whole source",
                labelColor = c.danger,
                iconColor = c.danger,
                showChevron = !inFlight,
                enabled = !inFlight,
                onClick = onRemove,
            )
            ActionDivider()
        }

        ActionRow(
            icon = Icons.Outlined.Description,
            label = "Recent items",
            labelColor = c.textPrimary,
            iconColor = c.accent,
            showChevron = true,
            enabled = true,
            onClick = onOpenRecent,
        )
    }
}

@Composable
private fun ActionDivider() {
    HorizontalDivider(color = OmTheme.colors.borderLight)
}

@Composable
private fun ActionRow(
    icon: ImageVector,
    label: String,
    labelColor: Color,
    iconColor: Color,
    showChevron: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = OmSpacing.md, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Box(Modifier.width(20.dp), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = iconColor, modifier = Modifier.size(16.dp))
        }
        Text(label, fontSize = 14.sp, color = labelColor)
        Spacer(Modifier.weight(1f))
        if (showChevron) {
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(13.dp))
        }
    }
}

// MARK: - About

@Composable
private fun AboutSection(detail: SourceDetailUi, onOpenDeviceNotices: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        SectionHeaderRule("ABOUT")
        KV("Type", detail.type, mono = true)
        KV("Account", detail.accountId, mono = true)
        if (detail.isInternal) {
            KV("Host", "Gateway")
        } else {
            HostDevices(detail.hostDevices, onOpenDeviceNotices)
        }
        KV("Source ID", detail.sourceId, mono = true)
    }
}

// MARK: - Shared rows

/**
 * Section header: an uppercase tracked label, a 1dp [border] rule filling the gap, then an
 * optional trailing slot (the STATUS pill). Ports the iOS `FlatSectionHeader`.
 */
@Composable
private fun SectionHeaderRule(title: String, trailing: (@Composable () -> Unit)? = null) {
    val c = OmTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(top = OmSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Text(
            title.uppercase(),
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.5.sp,
            color = c.textSecondary,
        )
        Box(Modifier.weight(1f).height(1.dp).background(c.border))
        trailing?.invoke()
    }
}

@Composable
private fun KV(key: String, value: String, mono: Boolean = false) {
    val c = OmTheme.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(key, fontSize = 12.sp, color = c.textSecondary)
        Spacer(Modifier.weight(1f).widthIn(min = 12.dp))
        Text(
            value,
            fontSize = 12.sp,
            color = c.textPrimary,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.End,
        )
    }
}

@Composable
private fun HostDevices(devices: List<SourceHostDeviceUi>, onOpenNotices: (String) -> Unit) {
    if (devices.isEmpty()) return
    val c = OmTheme.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        // Every line is at least one notice icon tall, so the label lines up with the
        // first device and devices without notices keep the same rhythm.
        Box(Modifier.heightIn(min = NOTICE_LINE_HEIGHT), contentAlignment = Alignment.CenterStart) {
            Text(
                if (devices.size == 1) "Host device" else "Host devices",
                fontSize = 12.sp,
                color = c.textSecondary,
            )
        }
        Spacer(Modifier.weight(1f).widthIn(min = 12.dp))
        Column(horizontalAlignment = Alignment.End) {
            devices.forEach { device ->
                // Icons lead the name so names stay right-aligned whether or not a
                // device has notices.
                Row(
                    Modifier.heightIn(min = NOTICE_LINE_HEIGHT),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    NoticeButton(device.notices, target = hostDeviceLabel(device), onOpen = { onOpenNotices(device.id) })
                    Text(
                        hostDeviceLabel(device),
                        fontSize = 12.sp,
                        color = c.textPrimary,
                        fontFamily = if (device.name == null) FontFamily.Monospace else FontFamily.Default,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.End,
                    )
                }
            }
        }
    }
}

private val NOTICE_LINE_HEIGHT = 24.dp

@Composable
private fun ErrorLabel(message: String) {
    val c = OmTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = c.danger, modifier = Modifier.size(14.dp).padding(top = 1.dp))
        Text(message, fontSize = 13.sp, color = c.danger)
    }
}

@Composable
internal fun RemoveSourceDialog(label: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    ConfirmDialog(
        title = "Remove $label from all devices?",
        body = "Removes the whole logical source, including every member's contribution, " +
            "and queues deletion of its managed gateway data (documents, index and analytics). " +
            "Re-add is blocked until cleanup finishes.\n\n" +
            "Originals on the provider or phone, retained backups and exported copies are not deleted. " +
            "This is not physical secure erasure.",
        confirmLabel = "Remove whole source",
        onConfirm = onConfirm,
        onDismiss = onDismiss,
    )
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
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.bgSecondary,
        title = { Text(title, color = c.textPrimary) },
        text = { Text(body, color = c.textSecondary, style = MaterialTheme.typography.bodySmall) },
        confirmButton = {
            TextButton(onClick = onConfirm) { Text(confirmLabel, color = c.danger) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = c.accent) }
        },
    )
}

@Composable
private fun DebugSheetBody(debug: Loadable<String>?) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.xl),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Text("Debug", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        when (debug) {
            null, Loadable.Loading -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            ) {
                OmSpinner(modifier = Modifier.size(18.dp), color = c.accent)
                Text("Fetching debug info…", fontSize = 13.sp, color = c.textSecondary)
            }
            is Loadable.Error -> ErrorLabel(debug.throwable.message ?: "Couldn't fetch debug info.")
            is Loadable.Content -> Text(
                debug.value,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                color = c.textPrimary,
            )
        }
    }
}

// MARK: - Previews

private fun sampleSynced() = SourceDetailUi(
    sourceId = "apple-notes:user@example.com", label = "Apple Notes", accountId = "user@example.com",
    icon = SourceIconModel(fallbackInitial = "N"), type = "apple-notes",
    hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-desktop")),
    syncState = "synced", lastSyncAt = "2026-01-06T09:00:00Z",
    percentIndexed = 100.0, progressPercent = null, progressMessage = null,
)

private fun sampleMultipleHosts() = SourceDetailUi(
    sourceId = "agent-sessions:local", label = "Agent Sessions", accountId = "local",
    icon = SourceIconModel(fallbackInitial = "A"), type = "agent-sessions",
    hostDevices = listOf(
        SourceHostDeviceUi(
            "dev-studio", "studio-mac",
            notices = listOf(NoticeUi(NoticeSeverity.INFO, "Only recent history is reachable")),
        ),
        SourceHostDeviceUi(
            "dev-laptop", "travel-laptop",
            notices = listOf(
                NoticeUi(NoticeSeverity.WARNING, "One folder could not be read"),
                NoticeUi(NoticeSeverity.INFO, "Some items were restored here"),
            ),
        ),
        SourceHostDeviceUi("dev-server", "home-server"),
    ),
    syncState = "synced", lastSyncAt = "2026-01-06T09:00:00Z",
    percentIndexed = 100.0, progressPercent = null, progressMessage = null,
)

private fun sampleSyncing() = SourceDetailUi(
    sourceId = "gmail:user@example.com", label = "Gmail", accountId = "user@example.com",
    icon = SourceIconModel(fallbackInitial = "G"), type = "gmail",
    hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-desktop")),
    syncState = "syncing", lastSyncAt = "2026-01-06T08:57:00Z",
    percentIndexed = 100.0, progressPercent = 48.0, progressMessage = "Page 6 of 12",
    unit = "emails", progressTotal = 500, progressDone = 240,
)

private fun sampleError() = SourceDetailUi(
    sourceId = "whatsapp-messages:+15550100000", label = "WhatsApp", accountId = "+15550100000",
    icon = SourceIconModel(fallbackInitial = "W"), type = "whatsapp-messages",
    hostDevices = listOf(
        SourceHostDeviceUi(
            "dev-host-0001", "studio-mac",
            notices = listOf(
                NoticeUi(
                    NoticeSeverity.ERROR, "The last sync failed",
                    detail = "The connection was refused.",
                    steps = listOf("Check that the app is running.", "Sync again."),
                    since = "2026-01-05T12:00:00Z",
                ),
            ),
        ),
    ),
    syncState = "error", lastSyncAt = "2026-01-06T08:00:00Z",
    percentIndexed = null, progressPercent = null, progressMessage = null,
)

@Preview(name = "Source detail · synced · dark")
@Composable
private fun SourceDetailSyncedDark() {
    OmnesisTheme(darkTheme = true) {
        SourceDetailContent(state = Loadable.Content(sampleSynced()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }
}

@Preview(name = "Source detail · multiple hosts · dark")
@Composable
private fun SourceDetailMultipleHostsDark() {
    OmnesisTheme(darkTheme = true) {
        SourceDetailContent(state = Loadable.Content(sampleMultipleHosts()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }
}

@Preview(name = "Source detail · syncing · dark")
@Composable
private fun SourceDetailSyncingDark() {
    OmnesisTheme(darkTheme = true) {
        SourceDetailContent(state = Loadable.Content(sampleSyncing()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }
}

@Preview(name = "Source detail · error · dark")
@Composable
private fun SourceDetailErrorDark() {
    OmnesisTheme(darkTheme = true) {
        SourceDetailContent(state = Loadable.Content(sampleError()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }
}

@Preview(name = "Source detail · synced · light")
@Composable
private fun SourceDetailSyncedLight() {
    OmnesisTheme(darkTheme = false) {
        SourceDetailContent(state = Loadable.Content(sampleSynced()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }
}
