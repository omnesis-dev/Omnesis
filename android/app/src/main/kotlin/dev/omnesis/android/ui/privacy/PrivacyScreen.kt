// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalSummary
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.PullToRefresh
import java.util.Locale

/**
 * Privacy is the record of events: what an external agent asked, what was answered, and what
 * is still waiting on a decision. A pending item is pinned at the top as a full review card
 * rather than filed behind a tab of its own — a queue nobody opens is a queue that hides
 * decisions. The rules those events are judged by — who may ask, over what, under which
 * policy — live under Settings, beside the grants they govern.
 *
 * A watch that is already running is not here. A watch is a watch however it was asked for, and
 * it lives on the Watches screen with everything else it does, including the record of what it
 * may disclose and to whom. What stays is the queue of watches *requested* and not yet decided:
 * a request to create a watch is not a watch.
 */

/** The two halves of the audit record: reviewed Answer releases, and raw Direct reads. */
enum class AuditTab(val label: String) {
    ANSWER("Answer"),
    DIRECT("Direct"),
}

@Composable
fun PrivacyScreen(
    onOpenMenu: () -> Unit,
    onOpenExchange: (conversationId: String, taskId: String) -> Unit,
    onOpenSubscriptionApproval: (String) -> Unit,
    onOpenDirectSession: (String) -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: PrivacyViewModel = hiltViewModel(),
    directVm: DirectAuditViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val directState by directVm.state.collectAsStateWithLifecycle()
    PrivacyContent(
        state = state,
        directState = directState,
        onOpenMenu = onOpenMenu,
        onOpenExchange = onOpenExchange,
        onOpenSubscriptionApproval = onOpenSubscriptionApproval,
        onOpenDirectSession = onOpenDirectSession,
        onOpenSettings = onOpenSettings,
        onRetry = { vm.load() },
        onPullRefresh = { vm.load(showLoadingIndicator = false) },
        onApprove = vm::approve,
        onDeny = vm::deny,
        onDismissResolution = vm::dismissResolution,
        onLoadMoreExchanges = vm::loadMoreExchanges,
        onLoadMoreSubscriptionApprovals = vm::loadMoreSubscriptionApprovals,
        onDirectRetry = { directVm.load() },
        onDirectRefresh = { directVm.load(showLoadingIndicator = false) },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrivacyContent(
    state: PrivacyUiState,
    onOpenMenu: () -> Unit,
    onOpenExchange: (conversationId: String, taskId: String) -> Unit,
    onRetry: () -> Unit,
    /** Re-read without blanking the pane — what a pull does, as against a retry. */
    onPullRefresh: () -> Unit = onRetry,
    onOpenSubscriptionApproval: (String) -> Unit = {},
    onOpenSettings: () -> Unit = {},
    onApprove: (String) -> Unit = {},
    onDeny: (String) -> Unit = {},
    onDismissResolution: () -> Unit = {},
    onLoadMoreExchanges: () -> Unit = {},
    onLoadMoreSubscriptionApprovals: () -> Unit = {},
    initialActivityFilter: PrivacyFeedFilter = PrivacyFeedFilter.ALL,
    directState: DirectAuditUiState = DirectAuditUiState(loading = false),
    onOpenDirectSession: (String) -> Unit = {},
    onDirectRetry: () -> Unit = {},
    onDirectRefresh: () -> Unit = onDirectRetry,
    initialTab: AuditTab = AuditTab.ANSWER,
) {
    val c = OmTheme.colors
    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Default.Menu, contentDescription = "Menu", tint = c.accent)
                    }
                },
                title = { Text("Audit") },
            )
        },
    ) { padding ->
        Box(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .background(c.bgPrimary),
        ) {
            when {
                state.loading -> LoadingView()
                // A feed error with nothing already on screen is the whole screen's error;
                // once rows are showing, the pull-to-refresh footer carries the failure and
                // replacing the record with an error page would hide what was already read.
                state.error != null && state.exchanges.isEmpty() &&
                    state.subscriptionApprovals.isEmpty() ->
                    GatewayErrorView(
                        context = "load privacy activity",
                        error = state.error,
                        onRetry = onRetry,
                        onOpenSettings = onOpenSettings,
                    )
                else -> PrivacyBody(
                    state = state,
                    directState = directState,
                    onOpenExchange = onOpenExchange,
                    onOpenSubscriptionApproval = onOpenSubscriptionApproval,
                    onOpenDirectSession = onOpenDirectSession,
                    onRefresh = onPullRefresh,
                    onApprove = onApprove,
                    onDeny = onDeny,
                    onDismissResolution = onDismissResolution,
                    onLoadMoreExchanges = onLoadMoreExchanges,
                    onLoadMoreSubscriptionApprovals = onLoadMoreSubscriptionApprovals,
                    onDirectRetry = onDirectRetry,
                    onDirectRefresh = onDirectRefresh,
                    initialActivityFilter = initialActivityFilter,
                    initialTab = initialTab,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AuditTabRow(selected: AuditTab, onSelect: (AuditTab) -> Unit) {
    val c = OmTheme.colors
    SingleChoiceSegmentedButtonRow(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg, vertical = OmSpacing.sm),
    ) {
        AuditTab.entries.forEachIndexed { i, tab ->
            SegmentedButton(
                selected = tab == selected,
                onClick = { onSelect(tab) },
                shape = SegmentedButtonDefaults.itemShape(i, AuditTab.entries.size),
                icon = {},
                colors = SegmentedButtonDefaults.colors(
                    activeContainerColor = c.bgSecondary,
                    activeContentColor = c.textPrimary,
                    activeBorderColor = c.border,
                    inactiveContainerColor = Color.Transparent,
                    inactiveContentColor = c.textSecondary,
                    inactiveBorderColor = c.border,
                ),
            ) {
                Text(tab.label, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun PrivacyBody(
    state: PrivacyUiState,
    onOpenExchange: (String, String) -> Unit,
    onOpenSubscriptionApproval: (String) -> Unit,
    onRefresh: () -> Unit,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onDismissResolution: () -> Unit,
    onLoadMoreExchanges: () -> Unit,
    onLoadMoreSubscriptionApprovals: () -> Unit,
    initialActivityFilter: PrivacyFeedFilter,
    directState: DirectAuditUiState,
    onOpenDirectSession: (String) -> Unit,
    onDirectRetry: () -> Unit,
    onDirectRefresh: () -> Unit,
    initialTab: AuditTab,
) {
    val c = OmTheme.colors
    var tab by rememberSaveable { mutableStateOf(initialTab) }
    Column(Modifier.fillMaxSize()) {
        if (state.reviewerHealth?.status == "attention") {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(c.warning.copy(alpha = 0.12f))
                    .padding(OmSpacing.md),
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(
                    Icons.Outlined.WarningAmber,
                    contentDescription = null,
                    tint = c.warning,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    "Some recent automatic privacy checks could not complete. Any affected answer " +
                        "stays inside Omnesis and waits for your review.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        AuditTabRow(selected = tab, onSelect = { tab = it })
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (tab == AuditTab.DIRECT) {
                DirectAuditPane(
                    state = directState,
                    onOpenSession = onOpenDirectSession,
                    onRetry = onDirectRetry,
                    onPullRefresh = onDirectRefresh,
                )
            } else {
                // Pull to refresh — the same gesture every other list in the app uses.
                PullToRefresh(refreshing = state.exchangesPaging.isRefreshing, onRefresh = onRefresh) {
                    PrivacyActivityPane(
                        state = state,
                        onOpenExchange = onOpenExchange,
                        onOpenSubscriptionApproval = onOpenSubscriptionApproval,
                        onApprove = onApprove,
                        onDeny = onDeny,
                        onDismissResolution = onDismissResolution,
                        onLoadMoreExchanges = onLoadMoreExchanges,
                        onLoadMoreSubscriptionApprovals = onLoadMoreSubscriptionApprovals,
                        initialFilter = initialActivityFilter,
                    )
                }
            }
        }
    }
}

/* ── Activity ─────────────────────────────────────────────────────────────── */

@Composable
private fun PrivacyActivityPane(
    state: PrivacyUiState,
    onOpenExchange: (String, String) -> Unit,
    onOpenSubscriptionApproval: (String) -> Unit,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onDismissResolution: () -> Unit,
    onLoadMoreExchanges: () -> Unit,
    onLoadMoreSubscriptionApprovals: () -> Unit,
    initialFilter: PrivacyFeedFilter,
) {
    val context = LocalContext.current
    val locale = context.resources.configuration.locales[0] ?: Locale.getDefault()
    val use24HourClock = DateFormat.is24HourFormat(context)
    val listState = rememberLazyListState()
    val pending = state.pendingReviews
    val listed = state.feed
    var filter by rememberSaveable { mutableStateOf(initialFilter) }
    val counts = privacyFeedFilterCounts(listed)
    val feed = listed.filter { privacyFeedFilterMatches(filter, it) }
    LazyColumn(
        Modifier.fillMaxSize(),
        state = listState,
        contentPadding = PaddingValues(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        state.resolution?.let { resolution ->
            item("resolution") {
                PrivacyBanner(
                    message = resolution.message,
                    kind = PrivacyBannerKind.SUCCESS,
                    title = resolution.title,
                    action = { PrivacyTextLink("Dismiss", onDismissResolution) },
                )
            }
        }

        if (pending.isNotEmpty()) {
            item("pending-heading") {
                PrivacySectionHeading(
                    if (pending.size == 1) {
                        "One answer is waiting for you"
                    } else {
                        "${pending.size} answers are waiting for you"
                    },
                )
            }
            items(pending, key = { "pending:${it.taskId}" }) { exchange ->
                val approvalId = exchange.approval?.id.orEmpty()
                PrivacyReviewCard(
                    exchange = exchange,
                    busy = state.resolving
                        ?.takeIf { it.startsWith("$approvalId:") }
                        ?.substringAfterLast(':'),
                    error = state.approvalErrors[approvalId],
                    onApprove = { onApprove(approvalId) },
                    onDeny = { onDeny(approvalId) },
                )
            }
        }

        if (state.subscriptionApprovals.isNotEmpty()) {
            item("watch-requests-heading") {
                PrivacySectionHeading("Watch requests")
            }
            items(state.subscriptionApprovals, key = { "watch-request:${it.id}" }) { approval ->
                SubscriptionApprovalRow(approval) { onOpenSubscriptionApproval(approval.id) }
            }
            item("watch-requests-paging") {
                ListPagingFooter(
                    listState = listState,
                    boundaryKey = "watch-requests-paging",
                    paging = state.subscriptionApprovalsPaging,
                    onLoadMore = onLoadMoreSubscriptionApprovals,
                    loadAction = "more watch requests",
                )
            }
        }

        item("feed-heading") {
            Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                PrivacySectionHeading("Recent activity", Modifier.semantics { heading() })
                PrivacyFeedFilterPills(
                    selected = filter,
                    counts = counts,
                    onSelect = { filter = it },
                )
            }
        }

        if (feed.isEmpty() && filter != PrivacyFeedFilter.ALL) {
            item("feed-empty") {
                PrivacyEmptyState(
                    title = "No matching activity",
                    message = "Nothing in the activity loaded so far has this status. " +
                        "Load older activity to look further back.",
                )
            }
        } else if (feed.isEmpty() && state.exchangesPaging.canShowDefinitiveEmpty) {
            item("feed-empty") {
                PrivacyEmptyState(
                    title = "Nothing has left this machine",
                    message = "Every question an external agent asks Omnesis appears here, " +
                        "with what was shared.",
                )
            }
        } else {
            // Day boundaries are part of the chronology, unlike workflow
            // headings, and make the trailing clock column useful at a glance.
            item("feed-rows") {
                Column {
                    privacyFeedDays(feed, locale = locale).forEachIndexed { dayIndex, day ->
                        PrivacyFeedDayHeading(day.heading, first = dayIndex == 0, locale = locale)
                        day.exchanges.forEachIndexed { index, exchange ->
                            PrivacyFeedRow(exchange, locale, use24HourClock) {
                                onOpenExchange(exchange.conversationId, exchange.taskId)
                            }
                            if (index < day.exchanges.lastIndex) {
                                HorizontalDivider(thickness = Dp.Hairline, color = OmTheme.colors.borderLight)
                            }
                        }
                    }
                }
            }
        }

        item("feed-paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "feed-paging",
                paging = state.exchangesPaging,
                onLoadMore = onLoadMoreExchanges,
                loadAction = "older activity",
            )
        }
        item("tail") { Spacer(Modifier.height(OmSpacing.lg)) }
    }
}

@Composable
private fun PrivacyFeedFilterPills(
    selected: PrivacyFeedFilter,
    counts: Map<PrivacyFeedFilter, Int>,
    onSelect: (PrivacyFeedFilter) -> Unit,
) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs),
    ) {
        PrivacyFeedFilter.entries.forEach { option ->
            val active = option == selected
            val shape = RoundedCornerShape(percent = 50)
            Box(
                Modifier
                    .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                    .selectable(
                        selected = active,
                        onClick = { onSelect(option) },
                        role = Role.RadioButton,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "${option.label} ${counts[option] ?: 0}",
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
                    color = if (active) c.accent else c.textSecondary,
                    maxLines = 1,
                    modifier = Modifier
                        .clip(shape)
                        .background(if (active) c.accent.copy(alpha = 0.10f) else c.bgSecondary)
                        .border(
                            1.dp,
                            if (active) c.accent.copy(alpha = 0.55f) else c.border,
                            shape,
                        )
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
    }
}

@Composable
private fun PrivacyFeedDayHeading(heading: String, first: Boolean, locale: Locale) {
    val c = OmTheme.colors
    Column(Modifier.padding(top = if (first) 0.dp else OmSpacing.md)) {
        Text(
            heading.uppercase(locale),
            color = c.textMuted,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.8.sp,
            modifier = Modifier
                .padding(horizontal = OmSpacing.sm, vertical = 7.dp)
                .semantics { heading() },
        )
        HorizontalDivider(thickness = Dp.Hairline, color = c.borderLight)
    }
}

/**
 * One exchange, one row. The question is the row's identity; the outcome and the
 * time say what became of it.
 */
@Composable
internal fun PrivacyFeedRow(
    exchange: PrivacyExchangePresentation,
    locale: Locale,
    use24HourClock: Boolean,
    onClick: () -> Unit,
) {
    val c = OmTheme.colors
    val at = privacyFeedInstant(exchange)
    // Who asked and what they asked are one sentence, not two stacked labels: the emphasis
    // carries the difference, so two lines preserve more of the question
    // without letting one row dominate the chronology.
    val question = buildAnnotatedString {
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = c.textPrimary)) {
            append("${externalAgentNarrativeName(exchange.externalAgent)} asked ")
        }
        withStyle(SpanStyle(color = c.textSecondary)) {
            append("“${exchange.question}”")
        }
    }
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
                question,
                fontSize = 14.sp,
                lineHeight = 19.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PrivacyFeedOutcome(exchange, Modifier.weight(1f, fill = false))
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

@Composable
private fun PrivacyFeedOutcome(exchange: PrivacyExchangePresentation, modifier: Modifier = Modifier) {
    val presentation = privacyFeedOutcomeDisplay(exchange)
    if (!presentation.quiet) {
        PrivacyChip(presentation.outcome, modifier)
        return
    }
    val c = OmTheme.colors
    val color = privacyChipColors(presentation.outcome.tone).foreground
    Row(
        modifier,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val dot = Modifier
            .size(6.dp)
            .clip(CircleShape)
        Box(
            if (presentation.outcome.tone == PrivacyTone.WAITING) {
                dot.border(1.5.dp, color, CircleShape)
            } else {
                dot.background(color)
            },
        )
        Text(
            presentation.outcome.label,
            color = c.textSecondary,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun SubscriptionApprovalRow(
    approval: PrivacySubscriptionApprovalSummary,
    onClick: () -> Unit,
) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(c.bgSecondary)
            .clickable(onClick = onClick)
            .padding(OmSpacing.md),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The external-agent mark, not the padlock: a watch request is a caller
        // asking, and the padlock belongs to the privacy check alone.
        Icon(
            imageVector = PrivacyExternalAgentGlyph,
            contentDescription = null,
            tint = privacyTones().review,
            modifier = Modifier.size(18.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text(
                "${externalAgentNarrativeName(approval.integration)} wants a standing watch",
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                color = c.textPrimary,
            )
            Text(
                approval.interpretedCondition.summary,
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(
            Icons.AutoMirrored.Outlined.KeyboardArrowRight,
            contentDescription = null,
            tint = c.textMuted,
        )
    }
}
