// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.core.net.toUri
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.rememberPrependPagingAnchor
import kotlinx.coroutines.delay

private const val RUNNING_EXCHANGE_REFRESH_MS = 2_000L

internal suspend fun pollRunningPrivacyExchange(
    isRunning: () -> Boolean,
    wait: suspend () -> Unit = { delay(RUNNING_EXCHANGE_REFRESH_MS) },
    refresh: suspend () -> Unit,
) {
    while (isRunning()) {
        wait()
        if (!isRunning()) return
        refresh()
    }
}

/**
 * One exchange as a spine, with its ledger folded underneath. When the route
 * names no task it stacks every exchange in the conversation, which is where a
 * link to the whole audit conversation lands.
 */
@Composable
fun PrivacyExchangeDetailScreen(
    onBack: () -> Unit,
    onDeleted: () -> Unit,
    onOpenConversation: (String) -> Unit = {},
    onOpenPolicy: PrivacyPolicyOpener? = null,
    onOpenSettings: () -> Unit = {},
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (canonicalId: String, name: String?) -> Unit = { _, _ -> },
    vm: PrivacyExchangeDetailViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val lifecycleOwner = LocalLifecycleOwner.current
    val shown = vm.shownExchanges(state.exchanges)
    val needsPolling = shown.any(::privacyExchangeNeedsPolling)
    LaunchedEffect(state.deleted) {
        if (state.deleted) onDeleted()
    }
    LaunchedEffect(lifecycleOwner, needsPolling) {
        if (!needsPolling) return@LaunchedEffect
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            pollRunningPrivacyExchange(
                isRunning = {
                    vm.shownExchanges(vm.state.value.exchanges).any(::privacyExchangeNeedsPolling)
                },
                refresh = vm::refreshRunningExchange,
            )
        }
    }
    val context = LocalContext.current
    PrivacyExchangeDetailContent(
        state = state,
        shown = shown,
        onBack = onBack,
        onRetry = vm::load,
        onLoadPrevious = vm::loadPreviousExchanges,
        onApprove = vm::approve,
        onDeny = vm::deny,
        onDelete = vm::deleteConversation,
        onOpenConversation = onOpenConversation,
        onOpenPolicy = onOpenPolicy,
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrivacyExchangeDetailContent(
    state: PrivacyExchangeDetailUiState,
    shown: List<PrivacyExchangePresentation>,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onLoadPrevious: () -> Unit = {},
    onApprove: (String) -> Unit = {},
    onDeny: (String) -> Unit = {},
    onDelete: () -> Unit = {},
    onOpenConversation: (String) -> Unit = {},
    onOpenPolicy: PrivacyPolicyOpener? = null,
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
            title = { Text("Delete audit conversation?") },
            text = {
                Text(
                    "This removes the trusted audit transcript and its external-view history. " +
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

    val single = shown.singleOrNull()
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
                title = {
                    // The agent's short name, not the outcome: an outcome sentence
                    // truncates in a centred app bar, and the outcome is a chip in
                    // the body anyway.
                    val identity = single?.externalAgent ?: state.conversation?.externalAgent
                    Text(
                        identity?.let(::externalAgentNarrativeName) ?: "External activity",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                actions = {
                    IconButton(onClick = onRetry, enabled = !state.loading && !state.deleting) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Refresh", tint = c.accent)
                    }
                    IconButton(
                        onClick = { confirmDelete = true },
                        enabled = state.conversation != null && !state.deleting,
                    ) {
                        Icon(
                            Icons.Outlined.DeleteOutline,
                            contentDescription = "Delete audit conversation",
                            tint = c.danger,
                        )
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().background(c.bgPrimary)) {
            when {
                state.loading -> LoadingView()
                state.error != null && state.conversation == null -> GatewayErrorView(
                    context = "load privacy activity",
                    error = state.error,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                state.conversation != null -> PrivacyExchangeDetailBody(
                    state = state,
                    shown = shown,
                    onLoadPrevious = onLoadPrevious,
                    onApprove = onApprove,
                    onDeny = onDeny,
                    onOpenConversation = onOpenConversation,
                    onOpenPolicy = onOpenPolicy,
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
private fun PrivacyExchangeDetailBody(
    state: PrivacyExchangeDetailUiState,
    shown: List<PrivacyExchangePresentation>,
    onLoadPrevious: () -> Unit,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onOpenConversation: (String) -> Unit,
    onOpenPolicy: PrivacyPolicyOpener?,
    onOpenDocument: (String) -> Unit,
    onOpenPerson: (canonicalId: String, name: String?) -> Unit,
    onOpenUrl: (String) -> Unit,
    catalog: SourceCatalog,
) {
    val c = OmTheme.colors
    val conversation = state.conversation ?: return
    val listState = rememberLazyListState()
    val prependAnchor = rememberPrependPagingAnchor()
    val single = shown.singleOrNull()
    LaunchedEffect(state.exchangePrependVersion) {
        prependAnchor.restore(
            completedVersion = state.exchangePrependVersion,
            listState = listState,
            orderedKeys = shown.map { it.taskId },
            leadingItemCount = 2,
        )
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        state = listState,
        contentPadding = PaddingValues(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item("header") {
            Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
                if (single != null) {
                    PrivacyChip(privacyExchangeOutcomeDisplay(single))
                }
                Text(
                    if (single != null) {
                        single.workflow.name.ifBlank { "External workflow" }
                    } else {
                        val suffix = if (shown.size == 1) "1 exchange" else "${shown.size} exchanges"
                        "${conversation.workflowName.ifBlank { "External workflow" }} · $suffix"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textSecondary,
                )
                // The route names one exchange, but the caller asked this
                // workflow more than once; the rest of the conversation is one
                // tap away rather than reachable only by opening each row.
                if (single != null && conversation.taskCount > 1) {
                    PrivacyTextLink(
                        text = "See all ${conversation.taskCount} exchanges",
                        onClick = { onOpenConversation(conversation.id) },
                        // Cancels the text button's own horizontal padding so
                        // the link starts on the same edge as the lines above
                        // it, while keeping its full touch target.
                        modifier = Modifier.offset(x = -OmSpacing.md),
                    )
                }
            }
        }

        if (single == null) {
            item("exchange-paging") {
                ListPagingFooter(
                    listState = listState,
                    boundaryKey = "exchange-paging",
                    paging = state.exchangePaging,
                    onLoadMore = {
                        prependAnchor.capture(
                            currentVersion = state.exchangePrependVersion,
                            listState = listState,
                            eligibleKeys = shown.mapTo(hashSetOf()) { it.taskId },
                        )
                        onLoadPrevious()
                    },
                    loadAction = "earlier privacy activity",
                )
            }
        }

        if (shown.isEmpty() && state.exchangePaging.canShowDefinitiveEmpty) {
            item("empty") {
                PrivacyEmptyState(
                    title = "This exchange is no longer available",
                    message = "Nothing about it remains in the audit transcript.",
                )
            }
        }

        items(shown, key = { it.taskId }) { exchange ->
            Column(
                Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            ) {
                if (single == null) {
                    PrivacyChip(privacyExchangeOutcomeDisplay(exchange))
                }
                PrivacyExchangeSpine(
                    exchange = exchange,
                    events = eventsForTask(state.events, exchange.taskId),
                    busy = state.resolving
                        ?.takeIf { it.startsWith("${exchange.approval?.id}:") }
                        ?.substringAfterLast(':'),
                    actionError = state.actionError,
                    onApprove = { exchange.approval?.id?.let(onApprove) },
                    onDeny = { exchange.approval?.id?.let(onDeny) },
                    onOpenPolicy = onOpenPolicy,
                    onOpenDocument = onOpenDocument,
                    onOpenPerson = onOpenPerson,
                    onOpenUrl = onOpenUrl,
                    catalog = catalog,
                )
            }
        }

        item("tail") { Spacer(Modifier.height(OmSpacing.xl)) }
    }
}

/* ── One approval, opened by id ───────────────────────────────────────────── */

/**
 * Kept so a link minted before the review card moved onto the landing feed — a
 * push notification, a bookmark — still lands on the decision it names.
 */
@Composable
fun PrivacyApprovalScreen(
    onBack: () -> Unit,
    onOpenExchange: (conversationId: String, taskId: String) -> Unit,
    onOpenPolicy: PrivacyPolicyOpener? = null,
    onOpenSettings: () -> Unit = {},
    vm: PrivacyApprovalViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    PrivacyApprovalContent(
        state = state,
        onBack = onBack,
        onRetry = vm::load,
        onApprove = vm::approve,
        onDeny = vm::deny,
        onOpenExchange = onOpenExchange,
        onOpenPolicy = onOpenPolicy,
        onOpenSettings = onOpenSettings,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrivacyApprovalContent(
    state: PrivacyApprovalUiState,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onApprove: () -> Unit = {},
    onDeny: () -> Unit = {},
    onOpenExchange: (String, String) -> Unit = { _, _ -> },
    onOpenPolicy: PrivacyPolicyOpener? = null,
    onOpenSettings: () -> Unit = {},
) {
    val c = OmTheme.colors
    val detail = state.detail
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
                title = {
                    Text(if (detail?.status == "pending") "Share this answer?" else "Privacy decision")
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().background(c.bgPrimary)) {
            when {
                state.loading -> LoadingView()
                state.resolution != null -> Column(
                    Modifier.fillMaxSize().padding(OmSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
                ) {
                    PrivacyBanner(
                        message = state.resolution.message,
                        kind = PrivacyBannerKind.SUCCESS,
                        title = state.resolution.title,
                        action = { PrivacyTextLink("Back to activity", onBack) },
                    )
                }
                state.error != null && detail == null -> GatewayErrorView(
                    context = "load privacy approval",
                    error = state.error,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                detail != null && detail.status == "pending" -> LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(OmSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
                ) {
                    item("card") {
                        PrivacyReviewCard(
                            exchange = approvalAsExchange(detail),
                            busy = state.resolving?.substringAfterLast(':'),
                            error = state.actionError,
                            onApprove = onApprove,
                            onDeny = onDeny,
                            onOpenPolicy = onOpenPolicy,
                        )
                    }
                }
                detail != null -> Column(
                    Modifier.fillMaxSize().padding(OmSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
                ) {
                    PrivacyBanner(
                        message = "This review is already decided.",
                        kind = PrivacyBannerKind.WARNING,
                        action = {
                            PrivacyTextLink(
                                text = "See what happened",
                                onClick = { onOpenExchange(detail.conversationId, detail.taskId) },
                            )
                        },
                    )
                }
            }
        }
    }
}
