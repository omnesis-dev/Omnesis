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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.isReloading
import dev.omnesis.android.ui.common.PullToRefresh
import dev.omnesis.android.ui.common.PushHealthBanner
import dev.omnesis.android.ui.common.inlineRefreshErrorText

@Composable
fun SourcesScreen(
    connection: ConnectionState,
    onOpenMenu: () -> Unit,
    onOpenSource: (String) -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: SourcesViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val pushHealth by vm.pushHealth.collectAsStateWithLifecycle()
    SourcesContent(
        state = state,
        connection = connection,
        onOpenMenu = onOpenMenu,
        onRetry = vm::load,
        onRefresh = vm::refresh,
        onOpenSource = onOpenSource,
        onOpenSettings = onOpenSettings,
        deliveryBanner = {
            PushHealthBanner(
                snapshot = pushHealth.snapshot,
                retryPhase = pushHealth.retryPhase,
                labelForSourceId = vm::sourceLabel,
                unitLabelForSourceId = vm::sourceUnitLabel,
                onRetry = vm::retryDelivery,
                onDiscardUndelivered = vm::discardUndelivered,
                modifier = Modifier.padding(horizontal = OmSpacing.lg).padding(top = OmSpacing.md),
            )
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SourcesContent(
    state: Loadable<SourcesContent>,
    connection: ConnectionState,
    onOpenMenu: () -> Unit,
    onRetry: () -> Unit,
    onRefresh: () -> Unit = onRetry,
    onOpenSource: (String) -> Unit,
    onOpenSettings: () -> Unit = {},
    /**
     * Delivery health for this phone's own sources. A slot rather than a set of
     * fields, so this screen carries no knowledge of what "undelivered" means.
     */
    deliveryBanner: @Composable () -> Unit = {},
) {
    val c = OmTheme.colors
    // The source whose notice sheet is open, by id so a refresh shows its latest notices.
    var noticesFor by rememberSaveable { mutableStateOf<String?>(null) }
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Outlined.Menu, contentDescription = "Menu", tint = c.accent)
                    }
                },
                title = {
                    Text(
                        "Sources",
                        style = MaterialTheme.typography.titleMedium,
                        color = c.textPrimary,
                    )
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
            is Loadable.Error -> GatewayErrorView(
                context = "load sources",
                error = state.throwable,
                onRetry = onRetry,
                onOpenSettings = onOpenSettings,
                modifier = Modifier.padding(padding),
            )
            is Loadable.Content -> {
                val content = state.value
                if (content.sources.isEmpty() && content.pendingRemovals.isEmpty()) {
                    SourcesEmptyState(onRefresh = onRetry, modifier = Modifier.padding(padding))
                } else {
                    PullToRefresh(
                        refreshing = state.isReloading,
                        onRefresh = onRefresh,
                        modifier = Modifier.padding(padding),
                    ) {
                    LazyColumn(
                        Modifier
                            .fillMaxSize()
                            .background(c.bgPrimary),
                    ) {
                        item {
                            OverviewHero(
                                content.overview,
                                Modifier.padding(start = OmSpacing.lg, end = OmSpacing.lg, top = OmSpacing.sm),
                            )
                        }
                        item { deliveryBanner() }
                        content.refreshError?.let { err ->
                            item {
                                InlineRefreshBanner(
                                    inlineRefreshErrorText(err),
                                    Modifier.padding(horizontal = OmSpacing.lg).padding(top = OmSpacing.sm),
                                )
                            }
                        }
                        itemsIndexed(content.pendingRemovals, key = { _, row -> "removing:${row.id}" }) { _, row ->
                            Column(
                                Modifier.fillMaxWidth().padding(horizontal = OmSpacing.lg, vertical = OmSpacing.sm),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Text("Removing ${row.id}", color = c.warning, style = MaterialTheme.typography.bodyMedium)
                                Text("Managed gateway data is being deleted. Re-add is blocked until cleanup finishes. Pull to refresh status.", color = c.textSecondary, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        itemsIndexed(content.sources, key = { _, row -> row.sourceId }) { i, row ->
                            SourceRow(
                                row,
                                onClick = { onOpenSource(row.sourceId) },
                                onOpenNotices = { noticesFor = row.sourceId },
                                modifier = Modifier.padding(horizontal = OmSpacing.lg),
                            )
                            if (i < content.sources.lastIndex) {
                                HorizontalDivider(
                                    color = c.borderLight,
                                    modifier = Modifier.padding(start = 44.dp + OmSpacing.lg),
                                )
                            }
                        }
                        item { Spacer(Modifier.height(OmSpacing.lg)) }
                    }
                    }
                }
                content.sources
                    .firstOrNull { it.sourceId == noticesFor && it.noticeGroups.isNotEmpty() }
                    ?.let { row ->
                        NoticeSheet(
                            title = row.label,
                            groups = row.noticeGroups,
                            onDismiss = { noticesFor = null },
                            deviceHeadings = true,
                        )
                    }
            }
        }
    }
}

/** Borderless overview block (iOS `OverviewCard`): indexing pill, stat grid, embedding model. */
@Composable
private fun OverviewHero(overview: SourcesOverview, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    val state = indexingState(overview)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        // Indexing pill row
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(state.color))
            Spacer(Modifier.width(8.dp))
            Text(
                state.word,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.5.sp,
                color = state.color,
            )
            if (state.percent != null) {
                Spacer(Modifier.width(8.dp))
                Text(
                    "${state.percent}%",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = c.warning,
                )
            }
        }

        // Stats grid — leading aligned, fixed 16dp gaps
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.lg)) {
            StatCell(value = formatCount(overview.sourceCount), label = "sources")
            overview.totalDocs?.let { StatCell(value = formatCount(it), label = "docs") }
            overview.totalChunks?.let { StatCell(value = formatCount(it), label = "chunks") }
            val showDisk = (overview.diskBytes ?: 0L) > 0L
            if (showDisk) overview.diskSize?.let { StatCell(value = it, label = "on disk") }
        }

        // Embedding model row
        overview.embeddingModel?.let { model ->
            Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "EMBEDDING MODEL",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.5.sp,
                    color = c.textMuted,
                )
                Text(
                    model,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    color = c.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun StatCell(value: String, label: String) {
    val c = OmTheme.colors
    Column(horizontalAlignment = Alignment.Start) {
        Text(
            value,
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
            style = MaterialTheme.typography.bodyLarge.copy(fontFeatureSettings = "tnum"),
        )
        Text(label, fontSize = 10.sp, color = c.textMuted, letterSpacing = 0.3.sp)
    }
}

@Composable
private fun SourceRow(
    row: SourceRowUi,
    onClick: () -> Unit,
    onOpenNotices: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.Top,
    ) {
        SourceIcon(row.icon, size = 28.dp, modifier = Modifier.padding(top = 2.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            // Title row
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    row.label,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.weight(1f))
                OmnesisStatePill(
                    state = row.syncState,
                    paused = row.paused,
                    label = stateLabel(row.syncState, row.paused, compact = true),
                )
            }
            // Account id
            Text(
                row.accountId,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                color = c.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // Metadata row, with the notice icon beside the host device
            MetadataRow(row, onOpenNotices)
            // Sync progress bar
            if (row.syncState == "syncing" && row.progressPercent != null) {
                OmProgressBar(row.progressPercent, row.progressMessage)
            }
            // Latest-activity line
            if (row.lastActivity != null) {
                ActivityLine(row.lastActivity, row.activityAgo)
            }
        }
    }
}

@Composable
private fun MetadataRow(row: SourceRowUi, onOpenNotices: () -> Unit) {
    val c = OmTheme.colors
    val count = row.count
    val unit = row.unit
    val pct = row.percentIndexed
    val host = row.hostDevice
    val notices = row.noticeGroups.flatMap { it.notices }
    if (count == null && pct == null && host == null && row.countLabel == null && notices.isEmpty()) return
    Row(
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (count != null && unit != null) {
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = c.textSecondary, fontFeatureSettings = "tnum")) {
                        append("%,d ".format(count))
                    }
                    withStyle(SpanStyle(color = c.textMuted)) { append(unit) }
                },
                fontSize = 11.sp,
            )
        } else if (row.countLabel != null) {
            Text(row.countLabel, fontSize = 11.sp, color = c.textMuted)
        }
        if (pct != null) {
            val p = pct.coerceIn(0.0, 100.0)
            val pctColor = if (p >= 100.0) c.success else c.warning
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(5.dp).clip(CircleShape).background(pctColor))
                Text(
                    "${p.toInt()}% indexed",
                    fontSize = 11.sp,
                    color = pctColor,
                    style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = "tnum"),
                )
            }
        }
        if (host != null) {
            Text("·", fontSize = 11.sp, color = c.textMuted)
            Text(
                host,
                fontSize = 11.sp,
                color = c.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        // One icon at the worst level across every device; the sheet names each device.
        NoticeButton(notices, target = row.label, onOpen = onOpenNotices, worstOnly = true)
    }
}

/** 4dp-tall rounded track ([OmTheme.colors.bgTertiary]) overlaid by an [accent] fill. */
@Composable
internal fun OmProgressBar(percent: Double, message: String? = null, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    val frac = (percent / 100.0).toFloat().coerceIn(0f, 1f)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(4.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(c.bgTertiary),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(frac)
                    .height(4.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(c.accent),
            )
        }
        message?.let {
            Text(it, fontSize = 10.sp, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun ActivityLine(title: String, ago: String?) {
    val c = OmTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Description, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(10.dp))
        Text(
            title,
            fontSize = 11.sp,
            color = c.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (ago != null) {
            Text("·", fontSize = 11.sp, color = c.textMuted)
            Text(ago, fontSize = 11.sp, color = c.textMuted, maxLines = 1)
        }
    }
}

/** Warning-tinted label shown when cached rows are served after a failed refresh. */
@Composable
private fun InlineRefreshBanner(message: String, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Row(
        modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = c.warning, modifier = Modifier.size(14.dp).padding(top = 1.dp))
        Text(message, fontSize = 13.sp, color = c.warning)
    }
}

@Composable
private fun SourcesEmptyState(onRefresh: () -> Unit, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Column(
        modifier.fillMaxSize().padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Outlined.GridView, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(48.dp))
        Text("No sources yet", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        Text(
            buildAnnotatedString {
                append("Add sources from the desktop CLI with ")
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append("omnesis add") }
                append(".")
            },
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
        )
        FilledTonalButton(
            onClick = onRefresh,
            colors = ButtonDefaults.filledTonalButtonColors(
                containerColor = c.accent.copy(alpha = 0.15f),
                contentColor = c.accent,
            ),
        ) {
            Text("Refresh")
        }
    }
}

// MARK: - State derivation

private data class IndexingPillState(val word: String, val color: androidx.compose.ui.graphics.Color, val percent: Int?)

@Composable
private fun indexingState(overview: SourcesOverview): IndexingPillState {
    val c = OmTheme.colors
    val total = overview.totalDocs ?: 0
    // A document is "done" once the indexer has reached a terminal state for it:
    // indexed, or terminally errored (an un-embeddable/unreachable doc). Folding
    // the errored docs into completion lets the pill reach 100% / UP TO DATE once
    // the indexer has caught up, instead of stalling under it forever on the
    // handful it can never embed.
    val done = (overview.totalIndexed ?: 0) + (overview.totalIndexErrors ?: 0)
    return when {
        !overview.enabled || overview.indexLabel == "Indexer off" ->
            IndexingPillState("INDEXER OFF", c.textMuted, null)
        total > 0 && done >= total ->
            IndexingPillState("UP TO DATE", c.success, null)
        else -> {
            val pct = if (total > 0) ((done.toDouble() / total) * 100).toInt().coerceIn(0, 100) else 0
            IndexingPillState("INDEXING", c.warning, pct)
        }
    }
}

/**
 * iOS sync-state → pill label. paused trumps the raw state. The list-row pill uses a
 * tighter `needs-auth → "auth"` label (`compact = true`, mirroring iOS
 * `SourcesView.pillLabel`) while the detail STATUS pill spells out `"needs auth"`
 * (mirroring iOS `SourcesView.stateLabel`).
 */
internal fun stateLabel(state: String, paused: Boolean, compact: Boolean = false): String = when {
    paused -> "paused"
    else -> when (state) {
        "syncing" -> "syncing"
        "synced", "completed" -> "synced"
        "error" -> "error"
        "needs-auth" -> if (compact) "auth" else "needs auth"
        "auth-expiring" -> "expiring"
        "rate-limited" -> if (compact) "limited" else "rate limited"
        "stale" -> "stale"
        "disabled" -> "disabled"
        // Anything unrecognised is shown under its own name rather than
        // relabelled: calling an unknown state "idle" hides it entirely.
        else -> state.ifBlank { "idle" }
    }
}

// MARK: - Previews

private fun sampleContent() = SourcesContent(
    overview = SourcesOverview(
        sourceCount = 5, totalDocs = 165_100, totalChunks = 426_100, diskSize = "4 GB",
        embeddingModel = "nomic-embed-text-v1.5.Q8_0.gguf", indexLabel = "Indexing",
        enabled = true, totalIndexed = 163_500, diskBytes = 4_000_000_000L,
    ),
    sources = listOf(
        SourceRowUi(
            sourceId = "gmail:user@example.com", label = "Gmail", accountId = "user@example.com",
            icon = SourceIconModel(fallbackInitial = "G"), countLabel = "509 emails",
            syncState = "syncing", percentIndexed = 100.0, hostDevice = "studio-desktop",
            lastActivity = "Welcome to your weekly summary", progressPercent = 50.0,
            progressMessage = "Page 6 of 12", paused = false, count = 509, unit = "emails",
            activityAgo = "1m ago",
        ),
        SourceRowUi(
            sourceId = "apple-notes:user@example.com", label = "Apple Notes", accountId = "user@example.com",
            icon = SourceIconModel(fallbackInitial = "N"), countLabel = "4 notes",
            syncState = "synced", percentIndexed = null, hostDevice = "studio-desktop",
            lastActivity = "Standup notes — Mar 9", progressPercent = null, progressMessage = null,
            paused = false, count = 4, unit = "notes", activityAgo = "20m ago",
        ),
        SourceRowUi(
            sourceId = "whatsapp-messages:+15550100000", label = "WhatsApp", accountId = "+15550100000",
            icon = SourceIconModel(fallbackInitial = "W"), countLabel = "17,421 messages",
            syncState = "error", percentIndexed = 100.0, hostDevice = "studio-desktop",
            lastActivity = null, progressPercent = null, progressMessage = null,
            paused = false, count = 17_421, unit = "messages", activityAgo = null,
            noticeGroups = listOf(
                NoticeGroup(
                    "studio-desktop",
                    listOf(NoticeUi(NoticeSeverity.ERROR, "The last sync failed")),
                ),
            ),
        ),
        SourceRowUi(
            sourceId = "strava:1234567", label = "Strava", accountId = "1234567",
            icon = SourceIconModel(fallbackInitial = "S"), countLabel = "10 activities",
            syncState = "idle", percentIndexed = null, hostDevice = "studio-desktop",
            lastActivity = null, progressPercent = null, progressMessage = null,
            paused = true, count = 10, unit = "activities", activityAgo = null,
        ),
    ),
)

private val previewConn = ConnectionState.Connected("d", "GW", listOf("read"))

@Preview(name = "Sources · populated · dark")
@Composable
private fun SourcesPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        SourcesContent(
            state = Loadable.Content(sampleContent()),
            connection = previewConn,
            onOpenMenu = {}, onRetry = {}, onOpenSource = {},
        )
    }
}

@Preview(name = "Sources · populated · light")
@Composable
private fun SourcesPreviewLight() {
    OmnesisTheme(darkTheme = false) {
        SourcesContent(
            state = Loadable.Content(sampleContent()),
            connection = previewConn,
            onOpenMenu = {}, onRetry = {}, onOpenSource = {},
        )
    }
}

@Preview(name = "Sources · empty · dark")
@Composable
private fun SourcesEmptyPreview() {
    OmnesisTheme(darkTheme = true) {
        SourcesContent(
            state = Loadable.Content(SourcesContent(sampleContent().overview.copy(sourceCount = 0), emptyList())),
            connection = previewConn,
            onOpenMenu = {}, onRetry = {}, onOpenSource = {},
        )
    }
}

@Preview(name = "Sources · first-load error · dark")
@Composable
private fun SourcesErrorPreview() {
    OmnesisTheme(darkTheme = true) {
        SourcesContent(
            state = Loadable.Error(dev.omnesis.android.transport.GatewayException.Network(Exception("offline"))),
            connection = previewConn,
            onOpenMenu = {}, onRetry = {}, onOpenSource = {},
        )
    }
}
