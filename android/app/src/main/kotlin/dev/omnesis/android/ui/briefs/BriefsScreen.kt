// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.BriefRecordDto
import dev.omnesis.android.transport.dto.BriefsMenuEntry
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.PullToRefresh
import java.time.Instant

/**
 * Omnesis Briefs — the proactive awareness feed, as a list built for triage: every card
 * glanceable, tap a row to read it, swipe a row to clear it, long-press to talk back.
 *
 * The feed is finite and it is explicitly fine for it to end — the empty state is the
 * goal state, never padded. The Android port of the iOS `BriefsView`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BriefsScreen(
    onOpenMenu: () -> Unit,
    onOpenConversation: (conversationId: String, autoSend: String?) -> Unit,
    onOpenSettings: () -> Unit = {},
    briefsMenuEntry: BriefsMenuEntry = BriefsMenuEntry.AVAILABLE,
    onConfigureBackgroundAgent: () -> Unit = {},
    onOpenDocument: (String) -> Unit = {},
    vm: BriefsViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    var overlay by remember { mutableStateOf<BriefOverlay?>(null) }

    fun stopFeedWork() {
        vm.discardDictation()
        vm.cancelOpenThread()
    }

    // Work initiated by this destination cannot outlive it: release the microphone and
    // invalidate any thread reply that would otherwise navigate after the user left.
    DisposableEffect(Unit) {
        onDispose {
            vm.discardDictation()
            vm.cancelOpenThread()
        }
    }

    Scaffold(
        containerColor = OmTheme.colors.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Briefs", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Outlined.Menu, contentDescription = "Menu", tint = OmTheme.colors.accent)
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            BriefsListContent(
                feed = state.feed,
                loading = state.loading,
                loadError = state.loadError,
                paging = state.paging,
                onOpen = { brief ->
                    vm.markViewed(brief)
                    overlay = openBriefDetail(brief, ::stopFeedWork)
                },
                onQuickClear = { brief -> vm.dismiss(brief, brief.kind.clearActionReason) },
                onAsk = { brief -> vm.openThread(brief) { onOpenConversation(it, null) } },
                onMoreOptions = { overlay = openBriefDismiss(it, null, ::stopFeedWork) },
                onRetry = { vm.load() },
                onRefresh = { vm.load(showLoadingIndicator = false) },
                onOpenSettings = onOpenSettings,
                needsBackgroundAgent = briefsMenuEntry == BriefsMenuEntry.NEEDS_ATTENTION,
                onConfigureBackgroundAgent = onConfigureBackgroundAgent,
                onLoadMore = { vm.loadMore() },
                onDictate = { vm.startDictation(it) },
                // Only while no sheet covers the feed: a strip the user cannot see is a
                // hot mic they have forgotten about.
                dictatingBriefId = state.dictatingBriefId,
                dictationText = state.dictationDisplayText,
                onStopDictation = {
                    vm.stopDictationAndSend { conversationId, spoken ->
                        onOpenConversation(conversationId, spoken)
                    }
                },
            )
        }
    }

    (overlay as? BriefOverlay.Detail)?.brief?.let { brief ->
        BriefDetailSheet(
            brief = brief,
            openingThread = state.openingThreadBriefId == brief.id,
            dictating = state.dictatingBriefId == brief.id,
            dictationText = state.dictationDisplayText,
            onAsk = { vm.openThread(brief) { onOpenConversation(it, null) } },
            onDictate = {
                if (state.dictatingBriefId == brief.id) {
                    vm.stopDictationAndSend { conversationId, spoken ->
                        onOpenConversation(conversationId, spoken)
                    }
                } else {
                    vm.startDictation(brief)
                }
            },
            onDismiss = { reason, snoozeUntil ->
                vm.discardDictation()
                vm.cancelOpenThread(brief.id)
                vm.dismiss(brief, reason, snoozeUntil = snoozeUntil)
                overlay = null
            },
            onMoreOptions = { initialReason ->
                vm.cancelOpenThread(brief.id)
                overlay = openBriefDismiss(brief, initialReason, vm::discardDictation)
            },
            iconFor = vm::iconFor,
            onOpenDocument = onOpenDocument,
            onDismissRequest = {
                vm.discardDictation()
                vm.cancelOpenThread(brief.id)
                overlay = null
            },
        )
    }

    (overlay as? BriefOverlay.Dismiss)?.let { target ->
        BriefDismissSheet(
            brief = target.brief,
            initialReason = target.initialReason,
            onConfirm = { reason, feedback, snoozeUntil ->
                vm.dismiss(target.brief, reason, feedback, snoozeUntil)
                overlay = null
            },
            onDismissRequest = { overlay = null },
        )
    }

    state.dismissError?.let { message ->
        BriefErrorDialog("Couldn't dismiss brief", message, vm::clearDismissError)
    }
    state.threadError?.let { message ->
        BriefErrorDialog("Couldn't open the conversation", message, vm::clearThreadError)
    }
    state.dictationUnavailable?.let { message ->
        BriefErrorDialog("Dictation unavailable", message, vm::clearDictationUnavailable)
    }
}

@Composable
private fun BriefErrorDialog(title: String, message: String, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = { TextButton(onClick = onDismiss) { Text("OK") } },
    )
}

/**
 * Renders the feed without fetching anything, so screenshots drive every state directly.
 */
@Composable
fun BriefsListContent(
    feed: BriefsFeedState,
    loading: Boolean,
    loadError: Throwable?,
    paging: CursorPagingState = CursorPagingState(),
    onOpen: (BriefRecordDto) -> Unit,
    onQuickClear: (BriefRecordDto) -> Unit,
    onAsk: (BriefRecordDto) -> Unit,
    onMoreOptions: (BriefRecordDto) -> Unit,
    onRetry: () -> Unit,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit = {},
    needsBackgroundAgent: Boolean = false,
    onConfigureBackgroundAgent: () -> Unit = {},
    onLoadMore: () -> Unit = {},
    onDictate: (BriefRecordDto) -> Unit = {},
    /** The brief whose row is the recording strip, if any. */
    dictatingBriefId: String? = null,
    dictationText: String = "",
    onStopDictation: () -> Unit = {},
    /** Screenshot seam: freeze one row with its trailing actions exposed. */
    revealedActionsBriefId: String? = null,
    now: Instant = Instant.now(),
) {
    val listState = rememberLazyListState()
    var runtimeRevealedBriefId by remember { mutableStateOf<String?>(null) }
    val activeRevealedBriefId = revealedActionsBriefId ?: runtimeRevealedBriefId
    Column(Modifier.fillMaxSize()) {
        if (needsBackgroundAgent) {
            BackgroundAgentWarning(
                onClick = onConfigureBackgroundAgent,
                modifier = Modifier.padding(horizontal = OmSpacing.lg, vertical = OmSpacing.sm),
            )
        }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            when {
                loading && feed.isEmpty -> LoadingView()
                loadError != null && feed.isEmpty -> GatewayErrorView(
                    context = "load briefs",
                    error = loadError,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                feed.isEmpty && paging.canShowDefinitiveEmpty -> EmptyBriefs()
                else -> PullToRefresh(refreshing = paging.isRefreshing, onRefresh = onRefresh) {
                    // Side insets match the Privacy feed: rows and dividers share them.
                    LazyColumn(
                        Modifier.fillMaxSize(),
                        state = listState,
                        contentPadding = PaddingValues(horizontal = OmSpacing.lg),
                    ) {
                        items(feed.briefs, key = { it.id }) { brief ->
                            if (brief.id == dictatingBriefId) {
                                // The row IS the recording surface — no swipe actions and no tap
                                // to open while it is hot, because the only thing to do with it
                                // is finish speaking.
                                BriefRowDictating(
                                    title = brief.title,
                                    displayText = dictationText,
                                    onStop = onStopDictation,
                                )
                            } else {
                                BriefSwipeRow(
                                    brief = brief,
                                    unread = feed.isUnread(brief.id),
                                    now = now,
                                    onOpen = { onOpen(brief) },
                                    onQuickClear = { onQuickClear(brief) },
                                    onAsk = { onAsk(brief) },
                                    onDictate = { onDictate(brief) },
                                    onMoreOptions = { onMoreOptions(brief) },
                                    actionsRevealed = brief.id == activeRevealedBriefId,
                                    onActionsRevealed = { runtimeRevealedBriefId = brief.id },
                                    onActionsClosed = {
                                        if (runtimeRevealedBriefId == brief.id) runtimeRevealedBriefId = null
                                    },
                                )
                            }
                            HorizontalDivider(thickness = Dp.Hairline, color = OmTheme.colors.borderLight)
                        }
                        item("briefs-paging") {
                            ListPagingFooter(
                                listState = listState,
                                boundaryKey = "briefs-paging",
                                paging = paging,
                                loadAction = "more briefs",
                                onLoadMore = onLoadMore,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BackgroundAgentWarning(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = OmTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(colors.warning.copy(alpha = 0.12f))
            .clickable(onClick = onClick)
            .padding(OmSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Outlined.WarningAmber,
            contentDescription = null,
            tint = colors.warning,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(OmSpacing.sm))
        Column(Modifier.weight(1f)) {
            Text(
                "Background agent needs attention",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = colors.textPrimary,
            )
            Text(
                "Stored briefs remain available. Review model settings to resume new briefs.",
                style = MaterialTheme.typography.bodySmall,
                color = colors.textSecondary,
            )
        }
        Icon(
            Icons.Outlined.ChevronRight,
            contentDescription = null,
            tint = colors.warning,
            modifier = Modifier.size(20.dp),
        )
    }
}

/**
 * The goal state. Briefs are produced when there is something worth saying, so an empty
 * feed means there is nothing — which is good news, and is said as such rather than
 * dressed up as a problem.
 */
@Composable
private fun EmptyBriefs() {
    Column(
        Modifier.fillMaxSize().padding(horizontal = OmSpacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.Outlined.CheckCircle,
            contentDescription = null,
            tint = OmTheme.colors.textMuted,
            modifier = Modifier.size(36.dp),
        )
        Spacer(Modifier.size(OmSpacing.md))
        Text(
            "No briefs to show",
            style = MaterialTheme.typography.titleMedium,
            color = OmTheme.colors.textPrimary,
        )
        Spacer(Modifier.size(OmSpacing.sm))
        Text(
            "Nothing needs you right now. New briefs appear here when something deserves your attention.",
            style = MaterialTheme.typography.bodySmall,
            color = OmTheme.colors.textSecondary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}
