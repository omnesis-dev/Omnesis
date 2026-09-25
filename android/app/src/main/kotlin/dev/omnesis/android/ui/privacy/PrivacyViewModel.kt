// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.PrivacyApprovalDetail
import dev.omnesis.android.transport.dto.PrivacyAuditEventSummary
import dev.omnesis.android.transport.dto.PrivacyConversationDetail
import dev.omnesis.android.transport.dto.PrivacyExchangeApproval
import dev.omnesis.android.transport.dto.PrivacyExchangeFeedPage
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangePresentationPage
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyReviewerHealth
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalSummary
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalsEnvelope
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.appendUnique
import dev.omnesis.android.ui.common.classifyGatewayError
import dev.omnesis.android.ui.common.gatewayErrorDetail
import dev.omnesis.android.ui.common.prependUnique
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PrivacyResolutionBus @Inject constructor() {
    private val _resolved = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val resolved = _resolved.asSharedFlow()
    private val _deleted = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val deleted = _deleted.asSharedFlow()

    fun notifyResolved(conversationId: String) {
        _resolved.tryEmit(conversationId)
    }

    fun notifyDeleted(conversationId: String) {
        _deleted.tryEmit(conversationId)
    }
}

@Singleton
class PrivacySubscriptionResolutionBus @Inject constructor() {
    private val _changed = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val changed = _changed.asSharedFlow()

    fun notifyChanged() {
        _changed.tryEmit(Unit)
    }
}

/** The monotonic owner of the activity read, so a late reply cannot overwrite a newer one. */
internal class PrivacyRequestGate {
    private var activity = 0L

    fun beginActivityRefresh(): Long = ++activity

    fun ownsActivity(generation: Long): Boolean = generation == activity
}

data class PrivacyUiState(
    val loading: Boolean = true,

    // ── Activity: the flat exchange feed, newest first ──
    val exchanges: List<PrivacyExchangePresentation> = emptyList(),
    val exchangesPaging: CursorPagingState = CursorPagingState(),
    /** `"<approvalId>:<approve|deny>"` while one decision is in flight. */
    val resolving: String? = null,
    val approvalErrors: Map<String, String> = emptyMap(),
    val resolution: PrivacyResolutionCopy? = null,

    // ── Watch requests: watches asked for and not yet decided. A watch that is already
    // running is not here — it lives on the Watches screen with everything else it does.
    val subscriptionApprovals: List<PrivacySubscriptionApprovalSummary> = emptyList(),
    val subscriptionApprovalsTotalCount: Int = subscriptionApprovals.size,
    val subscriptionApprovalsPaging: CursorPagingState = CursorPagingState(),

    val reviewerHealth: PrivacyReviewerHealth? = null,
    val error: Throwable? = null,
) {
    /** Pending exchanges, pinned at the top of Activity as full review cards. */
    val pendingReviews: List<PrivacyExchangePresentation>
        get() = exchanges.filter(::isPendingPrivacyReview).take(MAX_PINNED_REVIEWS)

    /** Everything the pinned cards do not already show. */
    val feed: List<PrivacyExchangePresentation>
        get() {
            val pinned = pendingReviews.mapTo(hashSetOf()) { it.taskId }
            return exchanges.filterNot { it.taskId in pinned }
        }

    companion object {
        /**
         * Pending items are few by construction — they expire — but the cap keeps
         * one runaway integration from turning the landing screen into an
         * unreadable stack. The rest stay visible as feed rows carrying the
         * "Needs your review" chip.
         */
        const val MAX_PINNED_REVIEWS = 5
    }
}

internal fun isPendingPrivacyReview(exchange: PrivacyExchangePresentation): Boolean =
    exchange.outcome == "needs_review" && exchange.approval?.status == "pending"

/** The conversation a decision belongs to, so the screens showing it can reload. */
internal fun conversationIdForApproval(state: PrivacyUiState, approvalId: String): String? =
    state.exchanges.firstOrNull { it.approval?.id == approvalId }?.conversationId

/** A deleted audit conversation takes its exchanges out of the feed immediately. */
internal fun removeDeletedConversation(state: PrivacyUiState, conversationId: String): PrivacyUiState =
    state.copy(exchanges = state.exchanges.filterNot { it.conversationId == conversationId })

internal fun shouldRefreshConversation(openConversationId: String, resolvedConversationId: String): Boolean =
    openConversationId == resolvedConversationId

internal fun mergePrivacyActivity(
    current: PrivacyUiState,
    feed: PrivacyExchangeFeedPage,
    reviewerHealth: PrivacyReviewerHealth?,
): PrivacyUiState {
    return current.copy(
        exchanges = feed.exchanges,
        reviewerHealth = reviewerHealth ?: current.reviewerHealth,
        error = null,
    )
}

internal fun mergePrivacySubscriptionApprovals(
    current: PrivacyUiState,
    approvals: PrivacySubscriptionApprovalsEnvelope,
): PrivacyUiState = current.copy(
    subscriptionApprovals = approvals.approvals,
    subscriptionApprovalsTotalCount = approvals.totalCount,
)

internal data class PrivacyApprovalPageMerge<T>(
    val items: List<T>,
    val totalCount: Int,
    val paging: CursorPagingState,
)

/**
 * Shared page reducer for the cursor-paginated queues. Request ownership is
 * checked before any list or count mutation, and stable ids are deduplicated
 * across pages.
 */
internal fun <T, K> mergePrivacyApprovalPage(
    currentItems: List<T>,
    paging: CursorPagingState,
    request: CursorPagingState.Request,
    incomingItems: List<T>,
    nextCursor: String?,
    totalCount: Int,
    key: (T) -> K,
): PrivacyApprovalPageMerge<T>? {
    if (!paging.owns(request)) return null
    val mergedItems = if (request.cursor == null) {
        incomingItems.distinctBy(key)
    } else {
        appendUnique(currentItems, incomingItems, key)
    }
    val finishedPaging = if (request.cursor == null) {
        paging.finishRefresh(request, nextCursor)
    } else {
        paging.finishLoadMore(
            request,
            nextCursor,
            madeProgress = mergedItems.size > currentItems.size,
        )
    }
    return PrivacyApprovalPageMerge(
        items = mergedItems,
        totalCount = totalCount,
        paging = finishedPaging,
    )
}

internal fun shouldRetryPrivacyApprovalRefresh(paging: CursorPagingState): Boolean =
    paging.refreshError != null

/**
 * The approval routes still exist so a link minted before the review card moved
 * onto the landing feed — a push notification, a bookmark — lands on the
 * decision it names. It renders through the same review card, so the approval
 * detail is projected onto the exchange shape that card speaks.
 */
internal fun approvalAsExchange(detail: PrivacyApprovalDetail): PrivacyExchangePresentation =
    PrivacyExchangePresentation(
        taskId = detail.taskId,
        conversationId = detail.conversationId,
        workflowId = detail.workflowId,
        externalAgent = detail.externalAgent,
        workflow = PrivacyExchangeWorkflow(detail.workflowName, detail.workflowPurpose),
        question = detail.question,
        status = "approval_required",
        outcome = if (detail.status == "pending") "needs_review" else "not_shared",
        createdAt = detail.createdAt,
        resolvedAt = detail.resolvedAt,
        sharedAt = detail.sharedAt,
        pendingCandidate = detail.candidateAnswer,
        approval = PrivacyExchangeApproval(
            id = detail.id,
            status = detail.status,
            expiresAt = detail.expiresAt,
            resolvedAt = detail.resolvedAt,
        ),
        review = PrivacyExchangeReview(
            fallbackCause = detail.review.fallbackCause,
            findings = detail.review.findings,
            rationale = detail.review.rationale,
            policyFamilyId = detail.review.policyFamilyId,
            policyFamilyName = detail.review.policyFamilyName,
        ),
    )

@HiltViewModel
class PrivacyViewModel @Inject constructor(
    private val session: SessionManager,
    private val resolutionBus: PrivacyResolutionBus,
    subscriptionResolutionBus: PrivacySubscriptionResolutionBus,
) : ViewModel() {
    private val _state = MutableStateFlow(PrivacyUiState())
    val state = _state.asStateFlow()
    private val requestGate = PrivacyRequestGate()
    private var subscriptionsGeneration = 0L

    init {
        load()
        viewModelScope.launch {
            resolutionBus.resolved.collect {
                refreshActivity()
            }
        }
        viewModelScope.launch {
            resolutionBus.deleted.collect { conversationId ->
                _state.value = removeDeletedConversation(_state.value, conversationId)
                refreshActivity()
            }
        }
        viewModelScope.launch {
            subscriptionResolutionBus.changed.collect { refreshSubscriptions() }
        }
    }

    /**
     * Read the activity feed and the watch-request queue. [showLoadingIndicator] is false for
     * pull-to-refresh, where the feed stays on screen and the pull's own indicator says a fetch
     * is running — raising the screen-wide loading flag there would replace what the reader is
     * holding with a spinner.
     */
    fun load(showLoadingIndicator: Boolean = true) {
        refreshSubscriptions()
        refreshActivity(showLoadingIndicator = showLoadingIndicator)
    }

    /**
     * The feed request owns the screen-wide loading flag: it is the only read this screen
     * blanks for. The watch-request queue is a section within it and never blanks the screen.
     */
    private fun refreshActivity(showLoadingIndicator: Boolean = false) {
        val requestGeneration = requestGate.beginActivityRefresh()
        val current = _state.value
        val feedRefresh = current.exchangesPaging.beginRefresh()
        _state.value = current.copy(
            loading = if (showLoadingIndicator) true else current.loading,
            exchangesPaging = feedRefresh.state,
            error = if (showLoadingIndicator) null else current.error,
        )
        viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                val feed = async { admin.privacyExchangeFeed() }
                val health = async { runCatching { admin.privacyReviewerHealth() }.getOrNull() }
                feed.await() to health.await()
            }.fold(
                onSuccess = { (feed, health) ->
                    // A newer read owns the screen and settles it, so a superseded reply
                    // touches nothing — including the loading flag that newer read raised.
                    if (!requestGate.ownsActivity(requestGeneration)) return@fold
                    val latest = _state.value
                    if (!latest.exchangesPaging.owns(feedRefresh.request)) {
                        // This read is still the gate's owner, so nobody else will lower the
                        // flag; the feed rows are left to whichever paging request took over.
                        _state.value = latest.copy(loading = false)
                        return@fold
                    }
                    val merged = mergePrivacyActivity(latest, feed, health)
                    _state.value = merged.copy(
                        loading = false,
                        exchangesPaging = merged.exchangesPaging.finishRefresh(
                            feedRefresh.request,
                            feed.nextCursor,
                        ),
                    )
                },
                onFailure = { error ->
                    if (requestGate.ownsActivity(requestGeneration)) {
                        _state.value = _state.value.copy(
                            loading = false,
                            error = error,
                            exchangesPaging = _state.value.exchangesPaging.failRefresh(
                                feedRefresh.request,
                                error,
                            ),
                        )
                    }
                },
            )
        }
    }

    fun loadMoreExchanges() {
        val current = _state.value
        if (shouldRetryPrivacyApprovalRefresh(current.exchangesPaging)) {
            refreshActivity()
            return
        }
        val started = current.exchangesPaging.beginLoadMore() ?: return
        _state.value = current.copy(exchangesPaging = started.state)
        viewModelScope.launch {
            runCatching {
                session.requireSession().admin.privacyExchangeFeed(cursor = started.request.cursor)
            }.fold(
                onSuccess = { page ->
                    val latest = _state.value
                    val merged = mergePrivacyApprovalPage(
                        currentItems = latest.exchanges,
                        paging = latest.exchangesPaging,
                        request = started.request,
                        incomingItems = page.exchanges,
                        nextCursor = page.nextCursor,
                        totalCount = 0,
                    ) { it.taskId } ?: return@fold
                    _state.value = latest.copy(
                        exchanges = merged.items,
                        exchangesPaging = merged.paging,
                    )
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        exchangesPaging = _state.value.exchangesPaging.failLoadMore(
                            started.request,
                            error,
                        ),
                    )
                },
            )
        }
    }

    fun dismissResolution() {
        _state.value = _state.value.copy(resolution = null)
    }

    fun approve(approvalId: String) = resolve(approvalId, approve = true)

    fun deny(approvalId: String) = resolve(approvalId, approve = false)

    private fun resolve(approvalId: String, approve: Boolean) {
        val current = _state.value
        if (current.resolving != null) return
        val action = if (approve) "approve" else "deny"
        val conversationId = conversationIdForApproval(current, approvalId)
        _state.value = current.copy(
            resolving = "$approvalId:$action",
            approvalErrors = current.approvalErrors - approvalId,
        )
        viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                if (approve) admin.approvePrivacyApproval(approvalId) else admin.denyPrivacyApproval(approvalId)
            }.fold(
                onSuccess = { resolution ->
                    val externalAgent = current.exchanges
                        .firstOrNull { it.approval?.id == approvalId }
                        ?.externalAgent
                    _state.value = _state.value.copy(
                        resolving = null,
                        resolution = privacyResolutionCopy(
                            resolution.status,
                            resolution.reason,
                            externalAgent,
                        ),
                    )
                    // Any screen already showing this conversation is now stale:
                    // it still offers the decision that was just made here.
                    conversationId?.let(resolutionBus::notifyResolved)
                    refreshActivity()
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        resolving = null,
                        approvalErrors = _state.value.approvalErrors +
                            (approvalId to privacyErrorMessage(error)),
                    )
                },
            )
        }
    }

    private fun refreshSubscriptions() {
        val generation = ++subscriptionsGeneration
        val approvalRefresh = _state.value.subscriptionApprovalsPaging.beginRefresh()
        _state.value = _state.value.copy(subscriptionApprovalsPaging = approvalRefresh.state)
        viewModelScope.launch {
            runCatching { session.requireSession().admin.privacySubscriptionApprovals() }.fold(
                onSuccess = { approvals ->
                    if (generation != subscriptionsGeneration) return@fold
                    val latest = _state.value
                    if (!latest.subscriptionApprovalsPaging.owns(approvalRefresh.request)) return@fold
                    val merged = mergePrivacySubscriptionApprovals(latest, approvals)
                    _state.value = merged.copy(
                        subscriptionApprovalsPaging =
                            merged.subscriptionApprovalsPaging.finishRefresh(
                                approvalRefresh.request,
                                approvals.nextCursor,
                            ),
                    )
                },
                onFailure = { error ->
                    if (generation != subscriptionsGeneration) return@fold
                    // A gateway too old to serve the queue has no watch requests rather than a
                    // broken one, so the section simply stays empty.
                    _state.value = if (error is GatewayException.NotFound) {
                        _state.value.copy(
                            subscriptionApprovals = emptyList(),
                            subscriptionApprovalsTotalCount = 0,
                            subscriptionApprovalsPaging =
                                _state.value.subscriptionApprovalsPaging.finishRefresh(
                                    approvalRefresh.request,
                                    null,
                                ),
                        )
                    } else {
                        _state.value.copy(
                            subscriptionApprovalsPaging =
                                _state.value.subscriptionApprovalsPaging.failRefresh(
                                    approvalRefresh.request,
                                    error,
                                ),
                        )
                    }
                },
            )
        }
    }

    fun loadMoreSubscriptionApprovals() {
        val current = _state.value
        if (shouldRetryPrivacyApprovalRefresh(current.subscriptionApprovalsPaging)) {
            refreshSubscriptions()
            return
        }
        val started = current.subscriptionApprovalsPaging.beginLoadMore() ?: return
        _state.value = current.copy(subscriptionApprovalsPaging = started.state)
        viewModelScope.launch {
            runCatching {
                session.requireSession().admin.privacySubscriptionApprovals(
                    cursor = started.request.cursor,
                )
            }.fold(
                onSuccess = { page ->
                    val latest = _state.value
                    val pageMerge = mergePrivacyApprovalPage(
                        currentItems = latest.subscriptionApprovals,
                        paging = latest.subscriptionApprovalsPaging,
                        request = started.request,
                        incomingItems = page.approvals,
                        nextCursor = page.nextCursor,
                        totalCount = page.totalCount,
                    ) { it.id } ?: return@fold
                    _state.value = latest.copy(
                        subscriptionApprovals = pageMerge.items,
                        subscriptionApprovalsTotalCount = pageMerge.totalCount,
                        subscriptionApprovalsPaging = pageMerge.paging,
                    )
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        subscriptionApprovalsPaging =
                            _state.value.subscriptionApprovalsPaging.failLoadMore(
                                started.request,
                                error,
                            ),
                    )
                },
            )
        }
    }

}

/** Prefer an actionable gateway detail, then use the shared transport vocabulary. */
internal fun privacyErrorMessage(error: Throwable): String =
    gatewayErrorDetail(error) ?: classifyGatewayError(error)

/* ── One exchange, or one conversation's worth ────────────────────────────── */

data class PrivacyExchangeDetailUiState(
    val loading: Boolean = true,
    val deleting: Boolean = false,
    val deleted: Boolean = false,
    val conversation: PrivacyConversationDetail? = null,
    val exchanges: List<PrivacyExchangePresentation> = emptyList(),
    val exchangePaging: CursorPagingState = CursorPagingState(),
    val exchangePrependVersion: Long = 0,
    val events: List<PrivacyAuditEventSummary> = emptyList(),
    /** `"<approvalId>:<approve|deny>"` while one decision is in flight. */
    val resolving: String? = null,
    val actionError: String? = null,
    val error: Throwable? = null,
)

/** The exchange's own slice of the conversation ledger. */
internal fun eventsForTask(
    events: List<PrivacyAuditEventSummary>,
    taskId: String,
): List<PrivacyAuditEventSummary> = events.filter { it.taskId == taskId }

internal class PrivacyExchangeDetailRequestGate {
    private var load = 0L
    private var delete = 0L

    fun beginLoad(): Long = ++load
    fun ownsLoad(generation: Long): Boolean = generation == load

    fun invalidateLoad() {
        load += 1
    }

    fun beginDelete(): Long {
        invalidateAll()
        return delete
    }

    fun ownsDelete(generation: Long): Boolean = generation == delete

    fun invalidateAll() {
        load += 1
        delete += 1
    }
}

internal fun privacyExchangeBackgroundRefreshAllowed(
    foregroundLoadsInFlight: Int,
    backgroundLoadInFlight: Boolean,
    paging: CursorPagingState,
): Boolean = foregroundLoadsInFlight == 0 &&
    !backgroundLoadInFlight &&
    !paging.isRefreshing &&
    !paging.isLoadingMore

internal fun mergePrivacyExchangeBackgroundRefresh(
    current: PrivacyExchangeDetailUiState,
    conversation: PrivacyConversationDetail,
    page: PrivacyExchangePresentationPage,
    events: List<PrivacyAuditEventSummary>,
): PrivacyExchangeDetailUiState {
    val freshIds = page.exchanges.mapTo(hashSetOf()) { it.taskId }
    return current.copy(
        conversation = conversation,
        exchanges = current.exchanges.filterNot { it.taskId in freshIds } + page.exchanges,
        events = events,
        error = null,
    )
}

internal data class PrivacyRunningExchangePageWalk(
    val exchanges: List<PrivacyExchangePresentation> = emptyList(),
    val previousCursor: String? = null,
    val remainingTaskIds: Set<String>,
    val pageCount: Int = 0,
) {
    val complete: Boolean get() = remainingTaskIds.isEmpty() || previousCursor == null

    fun adding(page: PrivacyExchangePresentationPage): PrivacyRunningExchangePageWalk {
        val found = page.exchanges.mapTo(hashSetOf()) { it.taskId }
        val alreadyLoaded = exchanges.mapTo(hashSetOf()) { it.taskId }
        val uniqueOlder = page.exchanges
            .distinctBy { it.taskId }
            .filterNot { it.taskId in alreadyLoaded }
        return copy(
            exchanges = uniqueOlder + exchanges,
            previousCursor = page.previousCursor,
            remainingTaskIds = remainingTaskIds - found,
            pageCount = pageCount + 1,
        )
    }

    fun page(): PrivacyExchangePresentationPage = PrivacyExchangePresentationPage(
        exchanges = exchanges,
        previousCursor = previousCursor,
    )
}

private const val RUNNING_EXCHANGE_LOOKUP_MAX_PAGES = 20

@HiltViewModel
class PrivacyExchangeDetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val session: SessionManager,
    private val resolutionBus: PrivacyResolutionBus,
    /** The shared loaded catalog, so trace rows show real source icons — never a fresh empty one. */
    val catalog: SourceCatalog,
) : ViewModel() {
    private val conversationId: String = checkNotNull(savedStateHandle["conversationId"])

    /** Null on the conversation-wide route, which stacks every exchange. */
    private val taskId: String? = savedStateHandle.get<String>("taskId")?.takeIf { it.isNotBlank() }

    private val _state = MutableStateFlow(PrivacyExchangeDetailUiState())
    val state = _state.asStateFlow()
    private val requestGate = PrivacyExchangeDetailRequestGate()
    private var foregroundLoadsInFlight = 0
    private var backgroundLoadInFlight = false

    init {
        load()
        viewModelScope.launch {
            resolutionBus.resolved.collect { resolvedConversationId ->
                if (shouldRefreshConversation(conversationId, resolvedConversationId)) load()
            }
        }
    }

    fun load() {
        foregroundLoadsInFlight += 1
        launchLoad(background = false).invokeOnCompletion { foregroundLoadsInFlight -= 1 }
    }

    internal suspend fun refreshRunningExchange() {
        val refreshAllowed = privacyExchangeBackgroundRefreshAllowed(
            foregroundLoadsInFlight,
            backgroundLoadInFlight,
            _state.value.exchangePaging,
        )
        if (!refreshAllowed) return
        backgroundLoadInFlight = true
        try {
            launchLoad(background = true).join()
        } finally {
            backgroundLoadInFlight = false
        }
    }

    private fun launchLoad(background: Boolean): Job {
        val generation = requestGate.beginLoad()
        val runningTaskIds = if (background) {
            shownExchanges(_state.value.exchanges)
                .filter(::privacyExchangeNeedsPolling)
                .mapTo(hashSetOf()) { it.taskId }
        } else {
            emptySet()
        }
        val started = if (background) null else _state.value.exchangePaging.beginRefresh()
        _state.value = _state.value.copy(
            loading = if (background) _state.value.loading else true,
            exchangePaging = started?.state ?: _state.value.exchangePaging,
            error = if (background) _state.value.error else null,
        )
        return viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                val conversation = async { admin.privacyConversation(conversationId) }
                val exchanges = async {
                    var walk = PrivacyRunningExchangePageWalk(remainingTaskIds = runningTaskIds)
                    val seenCursors = hashSetOf<String>()
                    while (true) {
                        if (background && !requestGate.ownsLoad(generation)) break
                        val cursor = walk.previousCursor
                        if (cursor != null && !seenCursors.add(cursor)) break
                        val page = admin.privacyConversationExchanges(
                            conversationId,
                            cursor = cursor,
                            includeAgentTracesTaskId = taskId,
                        )
                        walk = walk.adding(page)
                        if (!background || walk.complete ||
                            walk.pageCount >= RUNNING_EXCHANGE_LOOKUP_MAX_PAGES
                        ) break
                    }
                    walk.page()
                }
                val events = async {
                    runCatching { admin.privacyConversationEvents(conversationId, limit = 100) }
                        .getOrNull()
                }
                Triple(conversation.await(), exchanges.await(), events.await())
            }.fold(
                onSuccess = { (conversation, exchangePage, eventPage) ->
                    if (!requestGate.ownsLoad(generation)) return@fold
                    val events = eventPage?.events ?: _state.value.events
                    _state.value = if (background) {
                        mergePrivacyExchangeBackgroundRefresh(
                            _state.value,
                            conversation,
                            exchangePage,
                            events,
                        )
                    } else {
                        checkNotNull(started)
                        _state.value.copy(
                            loading = false,
                            conversation = conversation,
                            exchanges = exchangePage.exchanges,
                            events = events,
                            exchangePaging = _state.value.exchangePaging.finishRefresh(
                                started.request,
                                exchangePage.previousCursor,
                            ),
                            error = null,
                        )
                    }
                },
                onFailure = {
                    if (!background && requestGate.ownsLoad(generation)) {
                        checkNotNull(started)
                        _state.value = _state.value.copy(
                            loading = false,
                            error = it,
                            exchangePaging = _state.value.exchangePaging.failRefresh(
                                started.request,
                                it,
                            ),
                        )
                    }
                },
            )
        }
    }

    /** Only the conversation-wide route pages; a single exchange is one page by construction. */
    fun loadPreviousExchanges() {
        val current = _state.value
        if (current.exchangePaging.refreshError != null) {
            load()
            return
        }
        val started = current.exchangePaging.beginLoadMore() ?: return
        foregroundLoadsInFlight += 1
        requestGate.invalidateLoad()
        _state.value = current.copy(exchangePaging = started.state)
        viewModelScope.launch {
            try {
                runCatching {
                    session.requireSession().admin.privacyConversationExchanges(
                        conversationId,
                        cursor = started.request.cursor,
                        includeAgentTracesTaskId = taskId,
                    )
                }.fold(
                    onSuccess = { page ->
                        val latest = _state.value
                        if (!latest.exchangePaging.owns(started.request)) return@fold
                        val merged = prependUnique(latest.exchanges, page.exchanges) { it.taskId }
                        _state.value = latest.copy(
                            exchanges = merged,
                            exchangePaging = latest.exchangePaging.finishLoadMore(
                                started.request,
                                page.previousCursor,
                                madeProgress = merged.size > latest.exchanges.size,
                            ),
                            exchangePrependVersion = latest.exchangePrependVersion + 1,
                        )
                    },
                    onFailure = { error ->
                        _state.value = _state.value.copy(
                            exchangePaging = _state.value.exchangePaging.failLoadMore(
                                started.request,
                                error,
                            ),
                        )
                    },
                )
            } finally {
                foregroundLoadsInFlight -= 1
            }
        }
    }

    /** The shown exchanges: one when the route names a task, the whole conversation otherwise. */
    fun shownExchanges(all: List<PrivacyExchangePresentation>): List<PrivacyExchangePresentation> =
        if (taskId == null) all else all.filter { it.taskId == taskId }

    fun approve(approvalId: String) = resolve(approvalId, approve = true)

    fun deny(approvalId: String) = resolve(approvalId, approve = false)

    private fun resolve(approvalId: String, approve: Boolean) {
        if (_state.value.resolving != null) return
        _state.value = _state.value.copy(
            resolving = "$approvalId:${if (approve) "approve" else "deny"}",
            actionError = null,
        )
        viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                if (approve) admin.approvePrivacyApproval(approvalId) else admin.denyPrivacyApproval(approvalId)
            }.fold(
                onSuccess = {
                    _state.value = _state.value.copy(resolving = null)
                    resolutionBus.notifyResolved(conversationId)
                    load()
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        resolving = null,
                        actionError = privacyErrorMessage(error),
                    )
                },
            )
        }
    }

    fun deleteConversation() {
        if (_state.value.deleting) return
        val generation = requestGate.beginDelete()
        _state.value = _state.value.copy(deleting = true, actionError = null)
        viewModelScope.launch {
            runCatching { session.requireSession().admin.deletePrivacyConversation(conversationId) }.fold(
                onSuccess = {
                    if (requestGate.ownsDelete(generation)) {
                        resolutionBus.notifyDeleted(conversationId)
                        _state.value = PrivacyExchangeDetailUiState(loading = false, deleted = true)
                    }
                },
                onFailure = {
                    if (requestGate.ownsDelete(generation)) {
                        _state.value = _state.value.copy(
                            deleting = false,
                            actionError = privacyErrorMessage(it),
                        )
                    }
                },
            )
        }
    }

    override fun onCleared() {
        requestGate.invalidateAll()
        super.onCleared()
    }
}

/* ── One approval, opened by id ───────────────────────────────────────────── */

data class PrivacyApprovalUiState(
    val loading: Boolean = true,
    val resolving: String? = null,
    val detail: PrivacyApprovalDetail? = null,
    val resolution: PrivacyResolutionCopy? = null,
    val actionError: String? = null,
    val error: Throwable? = null,
)

internal class PrivacyApprovalRequestGate {
    private var generation = 0L

    fun begin(): Long = ++generation
    fun owns(request: Long): Boolean = request == generation
}

@HiltViewModel
class PrivacyApprovalViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val session: SessionManager,
    private val resolutionBus: PrivacyResolutionBus,
) : ViewModel() {
    private val approvalId: String = checkNotNull(savedStateHandle["approvalId"])
    private val _state = MutableStateFlow(PrivacyApprovalUiState())
    val state = _state.asStateFlow()
    private val requestGate = PrivacyApprovalRequestGate()

    init {
        load()
    }

    fun load() {
        val generation = requestGate.begin()
        _state.value = _state.value.copy(loading = true, error = null)
        viewModelScope.launch {
            runCatching { session.requireSession().admin.privacyApproval(approvalId) }.fold(
                onSuccess = {
                    if (requestGate.owns(generation)) {
                        _state.value = PrivacyApprovalUiState(loading = false, detail = it)
                    }
                },
                onFailure = {
                    if (requestGate.owns(generation)) {
                        _state.value = _state.value.copy(loading = false, error = it)
                    }
                },
            )
        }
    }

    fun approve() = resolve(approve = true)

    fun deny() = resolve(approve = false)

    private fun resolve(approve: Boolean) {
        val current = _state.value
        val detail = current.detail
        if (
            current.resolving != null ||
            detail?.status != "pending" ||
            (approve && detail.candidateAnswer.isNullOrBlank())
        ) return
        val generation = requestGate.begin()
        _state.value = current.copy(
            resolving = "$approvalId:${if (approve) "approve" else "deny"}",
            actionError = null,
        )
        viewModelScope.launch {
            runCatching {
                val admin = session.requireSession().admin
                if (approve) admin.approvePrivacyApproval(approvalId) else admin.denyPrivacyApproval(approvalId)
            }.fold(
                onSuccess = { resolution ->
                    if (!requestGate.owns(generation)) return@fold
                    _state.value = _state.value.copy(
                        resolving = null,
                        resolution = privacyResolutionCopy(
                            resolution.status,
                            resolution.reason,
                            detail.externalAgent,
                        ),
                    )
                    resolutionBus.notifyResolved(detail.conversationId)
                },
                onFailure = { error ->
                    if (!requestGate.owns(generation)) return@fold
                    if (error is GatewayException.ServerError && error.status == 409) {
                        val latest = runCatching {
                            session.requireSession().admin.privacyApproval(approvalId)
                        }.getOrNull()
                        if (!requestGate.owns(generation)) return@fold
                        if (latest != null) {
                            _state.value = PrivacyApprovalUiState(loading = false, detail = latest)
                            resolutionBus.notifyResolved(latest.conversationId)
                        } else {
                            _state.value = _state.value.copy(
                                resolving = null,
                                actionError = privacyErrorMessage(error),
                            )
                        }
                    } else {
                        _state.value = _state.value.copy(
                            resolving = null,
                            actionError = privacyErrorMessage(error),
                        )
                    }
                },
            )
        }
    }
}
