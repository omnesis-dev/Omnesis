// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import android.content.Intent
import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.DirectAuditEvent
import dev.omnesis.android.transport.dto.DirectAuditSession
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.PullToRefresh
import java.util.Locale
import kotlinx.serialization.json.JsonElement

/**
 * Whether the record carries a result. Refused/failed calls record no result
 * and read "No result recorded." — the outcome chip is gone, so only failures
 * speak, through the shared error card inside the flat card.
 */
internal fun directPayloadHasResult(payload: JsonElement?): Boolean = directRecordHasResult(payload)

/* ── Session list ───────────────────────────────────────────────────────── */

@Composable
fun DirectAuditScreen(
    onOpenSession: (String) -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: DirectAuditViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    DirectAuditPane(
        state = state,
        onOpenSession = onOpenSession,
        onRetry = { vm.load() },
        onPullRefresh = { vm.load(showLoadingIndicator = false) },
        onOpenSettings = onOpenSettings,
    )
}

@Composable
fun DirectAuditPane(
    state: DirectAuditUiState,
    onOpenSession: (String) -> Unit,
    onRetry: () -> Unit,
    onPullRefresh: () -> Unit = onRetry,
    onOpenSettings: () -> Unit = {},
) {
    val c = OmTheme.colors
    Box(Modifier.fillMaxSize().background(c.bgPrimary)) {
        when {
            state.loading && state.sessions.isEmpty() -> LoadingView()
            state.unavailable && state.sessions.isEmpty() -> DirectUnsupportedPane(onRetry = onRetry)
            state.error != null && state.sessions.isEmpty() -> GatewayErrorView(
                context = "load direct activity",
                error = state.error,
                onRetry = onRetry,
                onOpenSettings = onOpenSettings,
            )
            else -> PullToRefresh(refreshing = false, onRefresh = onPullRefresh) {
                DirectSessionList(sessions = state.sessions, onOpenSession = onOpenSession)
            }
        }
    }
}

/** A gateway from before the Direct boundary: version skew, not a failure. Answer keeps working. */
@Composable
private fun DirectUnsupportedPane(onRetry: () -> Unit) {
    val c = OmTheme.colors
    Column(
        Modifier.fillMaxSize().padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Text(
            "Direct reads land here, grouped into sessions.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
        )
        PrivacyEmptyState(
            title = "Direct transcripts need a newer gateway",
            message = "This gateway predates Direct audit transcripts. Update it to see raw reads here — " +
                "the Answer tab is unaffected.",
        )
        PrivacyTextLink(text = "Retry", onClick = onRetry)
    }
}

@Composable
private fun DirectSessionList(
    sessions: List<DirectAuditSession>,
    onOpenSession: (String) -> Unit,
) {
    val context = LocalContext.current
    val locale = context.resources.configuration.locales[0] ?: Locale.getDefault()
    val use24HourClock = DateFormat.is24HourFormat(context)
    val c = OmTheme.colors
    if (sessions.isEmpty()) {
        Column(
            Modifier.fillMaxSize().padding(OmSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            Text(
                "Direct reads land here, grouped into sessions.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
            PrivacyEmptyState(
                title = "No direct reads recorded",
                message = "Every raw corpus read by an external agent appears here, " +
                    "with the tool calls it made.",
            )
        }
        return
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item("lede") {
            Text(
                "Raw, unreviewed reads — what left without a privacy review.",
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
        }
        items(sessions, key = { it.id }) { session ->
            DirectSessionRow(session, locale, use24HourClock) { onOpenSession(session.id) }
            HorizontalDivider(thickness = Dp.Hairline, color = OmTheme.colors.borderLight)
        }
        item("tail") { Spacer(Modifier.height(OmSpacing.lg)) }
    }
}

@Composable
private fun DirectSessionRow(
    session: DirectAuditSession,
    locale: Locale,
    use24HourClock: Boolean,
    onClick: () -> Unit,
) {
    val c = OmTheme.colors
    val at = (session.lastEventAt.takeIf { it > 0 } ?: session.createdAt)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = OmSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text(
                directAuditAgentName(session),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    directAuditSessionLabel(session),
                    style = MaterialTheme.typography.labelSmall,
                    color = c.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Text(
                    if (session.eventCount == 1) "1 call" else "${session.eventCount} calls",
                    style = MaterialTheme.typography.labelSmall,
                    color = c.textSecondary,
                )
                if (session.explicitKey == null) {
                    Text(
                        "heuristic",
                        style = MaterialTheme.typography.labelSmall,
                        color = c.textMuted,
                    )
                }
            }
        }
        Text(
            formatPrivacyFeedTime(at, locale = locale, use24HourClock = use24HourClock),
            fontSize = 12.sp,
            color = c.textMuted,
            maxLines = 1,
            textAlign = TextAlign.End,
            modifier = Modifier
                .widthIn(min = 48.dp)
                .semantics {
                    contentDescription = formatPrivacyFeedDateTime(
                        at,
                        locale = locale,
                        use24HourClock = use24HourClock,
                    )
                },
        )
        Icon(
            Icons.AutoMirrored.Outlined.KeyboardArrowRight,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.size(11.dp),
        )
    }
}

/* ── One session's transcript ─────────────────────────────────────────── */

@Composable
fun DirectAuditDetailScreen(
    onBack: () -> Unit,
    onDeleted: () -> Unit,
    onOpenSettings: () -> Unit = {},
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (canonicalId: String, name: String?) -> Unit = { _, _ -> },
    vm: DirectAuditDetailViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LaunchedEffect(state.deleted) {
        if (state.deleted) onDeleted()
    }
    DirectAuditDetailContent(
        state = state,
        onBack = onBack,
        onRetry = vm::load,
        onEnsurePayload = vm::ensurePayload,
        onRetryEvent = vm::retryEvent,
        onDelete = vm::deleteSession,
        onOpenSettings = onOpenSettings,
        onOpenDocument = onOpenDocument,
        onOpenPerson = onOpenPerson,
        onOpenUrl = { url ->
            runCatching {
                context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()))
            }
        },
        catalog = vm.catalog,
    )
}

internal const val DIRECT_EVENT_LIMIT = 100

/**
 * One calendar day's separator inside a transcript: the date centered, with
 * room above and below. The first day's heading doubles as the transcript's
 * top date.
 */
@Composable
private fun DirectTranscriptDayHeading(heading: String) {
    Text(
        heading,
        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
        color = OmTheme.colors.textMuted,
        textAlign = TextAlign.Center,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = OmSpacing.md, bottom = OmSpacing.sm),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DirectAuditDetailContent(
    state: DirectAuditDetailUiState,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onEnsurePayload: (String) -> Unit = {},
    onRetryEvent: (String) -> Unit = {},
    onDelete: () -> Unit = {},
    onOpenSettings: () -> Unit = {},
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (canonicalId: String, name: String?) -> Unit = { _, _ -> },
    onOpenUrl: (String) -> Unit = {},
    catalog: SourceCatalog = SourceCatalog(),
) {
    val c = OmTheme.colors
    var confirmDelete by remember { mutableStateOf(false) }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { if (!state.deleting) confirmDelete = false },
            icon = { Icon(Icons.Outlined.DeleteOutline, contentDescription = null) },
            title = { Text("Delete direct transcript?") },
            text = {
                Text(
                    "This removes the transcript of every tool call in this session. " +
                        "This cannot be undone.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = false
                        onDelete()
                    },
                    enabled = !state.deleting,
                ) { Text("Delete", color = c.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
        )
    }
    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Outlined.ArrowBack,
                            contentDescription = "Back",
                            tint = c.accent,
                        )
                    }
                },
                title = { Text("Direct transcript") },
                actions = {
                    IconButton(onClick = onRetry, enabled = !state.loading && !state.deleting) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Refresh", tint = c.accent)
                    }
                    IconButton(
                        onClick = { confirmDelete = true },
                        enabled = !state.loading && !state.deleting,
                    ) {
                        Icon(
                            Icons.Outlined.DeleteOutline,
                            contentDescription = "Delete direct transcript",
                            tint = c.danger,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().background(c.bgPrimary)) {
            when {
                state.loading && state.events.isEmpty() -> LoadingView()
                state.unavailable && state.events.isEmpty() -> Column(
                    Modifier.fillMaxSize().padding(OmSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
                ) {
                    PrivacyEmptyState(
                        title = "Direct transcripts need a newer gateway",
                        message = "This gateway predates Direct audit transcripts.",
                    )
                }
                state.error != null && state.events.isEmpty() -> GatewayErrorView(
                    context = "load direct transcript",
                    error = state.error,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                else -> DirectEventList(
                    state = state,
                    onEnsurePayload = onEnsurePayload,
                    onRetryEvent = onRetryEvent,
                    actionError = state.actionError,
                    onOpenDocument = onOpenDocument,
                    onOpenPerson = onOpenPerson,
                    onOpenUrl = onOpenUrl,
                    catalog = catalog,
                )
            }
        }
    }
}

@Composable
private fun DirectEventList(
    state: DirectAuditDetailUiState,
    onEnsurePayload: (String) -> Unit,
    onRetryEvent: (String) -> Unit,
    actionError: String?,
    onOpenDocument: (String) -> Unit,
    onOpenPerson: (canonicalId: String, name: String?) -> Unit,
    onOpenUrl: (String) -> Unit,
    catalog: SourceCatalog,
) {
    val context = LocalContext.current
    val locale = context.resources.configuration.locales[0] ?: Locale.getDefault()
    val use24HourClock = DateFormat.is24HourFormat(context)
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        if (!state.loading && state.events.isNotEmpty()) {
            item("session-header") {
                val session = state.session
                if (session != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
                        Text(
                            directAuditSessionLabel(session),
                            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                            color = OmTheme.colors.textPrimary,
                        )
                        Text(
                            "${directAuditAgentName(session)} · " +
                                if (session.eventCount == 1) "1 call" else "${session.eventCount} calls",
                            style = MaterialTheme.typography.bodySmall,
                            color = OmTheme.colors.textSecondary,
                        )
                    }
                } else {
                    Text(
                        if (state.events.size == 1) "1 call" else "${state.events.size} calls",
                        style = MaterialTheme.typography.labelSmall,
                        color = OmTheme.colors.textSecondary,
                    )
                }
            }
        }
        if (actionError != null) {
            item("action-error") {
                PrivacyBanner(
                    message = actionError,
                    kind = PrivacyBannerKind.ERROR,
                    title = "Couldn't complete that",
                )
            }
        }
        if (state.events.isEmpty()) {
            item("empty") {
                PrivacyEmptyState(
                    title = "No calls in this session",
                    message = "Nothing about it remains in the direct transcript.",
                )
            }
        }
        // Calls group by local calendar day: the first day's heading is the
        // transcript's top date, and a later day interleaves its heading
        // before its first call.
        directTranscriptDays(state.events, locale = locale).forEach { day ->
            item("day-${day.key}") { DirectTranscriptDayHeading(heading = day.heading) }
            items(day.events, key = { it.id }) { event ->
                DirectEventRow(
                    event = event,
                    locale = locale,
                    use24HourClock = use24HourClock,
                    payload = state.payloads[event.id],
                    payloadLoaded = state.payloads.containsKey(event.id),
                    payloadLoading = event.id in state.payloadLoading,
                    payloadError = state.payloadErrors[event.id],
                    payloadTerminal = event.id in state.payloadTerminal,
                    onEnsurePayload = { onEnsurePayload(event.id) },
                    onRetryPayload = { onRetryEvent(event.id) },
                    onOpenDocument = onOpenDocument,
                    onOpenPerson = onOpenPerson,
                    onOpenUrl = onOpenUrl,
                    catalog = catalog,
                )
            }
        }
        if (state.events.size >= DIRECT_EVENT_LIMIT) {
            // The gateway serves the oldest calls first, so a capped session
            // shows the first page, not the latest calls.
            item("cap") {
                Text(
                    "Showing the first $DIRECT_EVENT_LIMIT calls.",
                    style = MaterialTheme.typography.labelSmall,
                    color = OmTheme.colors.textMuted,
                )
            }
        }
        item("tail") { Spacer(Modifier.height(OmSpacing.xl)) }
    }
}

/**
 * One transcript call, rendered linearly: the shared flat tool card is the
 * whole item, timestamped on the right — mirroring the portal's
 * `DirectCallItem`. No wrapper card (its title duplicated the inner card's),
 * no success chip: only failures speak, through the shared error card.
 *
 * The payload loads when the call composes (LazyColumn composes the visible
 * window, like the portal's IntersectionObserver with its 200px root margin):
 * a session holds up to [DIRECT_EVENT_LIMIT] calls and firing every payload
 * fetch on mount would thunder the gateway. Above-the-fold cards compose
 * immediately, so the visible transcript still renders without an extra tap.
 */
@Composable
private fun DirectEventRow(
    event: DirectAuditEvent,
    locale: Locale,
    use24HourClock: Boolean,
    payload: JsonElement?,
    payloadLoaded: Boolean,
    payloadLoading: Boolean,
    payloadError: String?,
    payloadTerminal: Boolean,
    onEnsurePayload: () -> Unit,
    onRetryPayload: () -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpenPerson: (canonicalId: String, name: String?) -> Unit,
    onOpenUrl: (String) -> Unit,
    catalog: SourceCatalog,
) {
    val c = OmTheme.colors
    LaunchedEffect(event.id) { onEnsurePayload() }
    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
    ) {
        when {
            payloadLoading && !payloadLoaded -> OmSpinner()
            payloadError != null -> Column(
                verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            ) {
                Text(
                    payloadError,
                    style = MaterialTheme.typography.bodySmall,
                    color = c.danger,
                )
                if (!payloadTerminal) {
                    PrivacyTextLink(text = "Retry", onClick = onRetryPayload)
                }
            }
            payloadLoaded -> {
                if (directPayloadHasResult(payload)) {
                    // Batch calls project one card per child — the portal's
                    // per-item split — sharing this call's instant and payload.
                    val timeText = formatPrivacyFeedTime(
                        event.createdAt,
                        locale = locale,
                        use24HourClock = use24HourClock,
                    )
                    directTranscriptCards(event.tool.ifBlank { "Unknown tool" }, payload).forEach { card ->
                        AuditToolCard(
                            tool = card.tool,
                            content = card.content,
                            rawPayload = payload,
                            timeText = timeText,
                            onOpenDocument = onOpenDocument,
                            onOpenPerson = onOpenPerson,
                            onOpenUrl = onOpenUrl,
                            catalog = catalog,
                        )
                    }
                } else {
                    Text(
                        "No result recorded.",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.textMuted,
                    )
                }
            }
            // Not yet loaded and no fetch in flight (the ensure above just
            // fired): hold the spinner slot so the row does not flash empty.
            else -> OmSpinner()
        }
    }
}
