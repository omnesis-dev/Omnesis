// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import dev.omnesis.android.transport.dto.PrivacyConversationDetail
import dev.omnesis.android.transport.dto.PrivacyExchangeApproval
import dev.omnesis.android.transport.dto.PrivacyExchangeFeedPage
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangePresentationPage
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import dev.omnesis.android.transport.dto.PrivacyInterpretedCondition
import dev.omnesis.android.transport.dto.PrivacyReviewerHealth
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalDetail
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalsEnvelope
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalSummary
import dev.omnesis.android.transport.dto.PrivacySubscriptionCondition
import dev.omnesis.android.transport.dto.PrivacySubscriptionDetail
import dev.omnesis.android.transport.dto.PrivacySubscriptionIntegrationDevice
import dev.omnesis.android.transport.dto.PrivacySubscriptionReaction
import dev.omnesis.android.transport.dto.PrivacySubscriptionWorkflow
import dev.omnesis.android.ui.common.CursorPagingState
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivacyViewModelRaceTest {
    @Test
    fun onlyNonterminalSubscriptionsCanBeRevoked() {
        assertTrue(canRevokePrivacySubscription("pending_approval"))
        assertTrue(canRevokePrivacySubscription("active"))
        assertTrue(canRevokePrivacySubscription("paused"))
        assertFalse(canRevokePrivacySubscription("denied"))
        assertFalse(canRevokePrivacySubscription("revoked"))
        assertFalse(canRevokePrivacySubscription("expired"))
    }

    @Test
    fun lateActivityReadCannotOverwriteANewerOne() {
        val gate = PrivacyRequestGate()
        val first = gate.beginActivityRefresh()
        val second = gate.beginActivityRefresh()

        assertFalse(gate.ownsActivity(first))
        assertTrue(gate.ownsActivity(second))
    }

    @Test
    fun aDecisionNamesTheConversationTheOpenScreensAreShowing() {
        val state = PrivacyUiState(
            exchanges = listOf(
                pendingExchange("task-one", "approval-one").copy(conversationId = "conversation-one"),
            ),
        )

        assertEquals("conversation-one", conversationIdForApproval(state, "approval-one"))
        assertNull(conversationIdForApproval(state, "approval-two"))
        assertNull(conversationIdForApproval(state, "approval-unknown"))
    }

    @Test
    fun watchRequestRefreshPreservesIndependentAnswerPrivacyState() {
        // The two queues are refreshed together but are unrelated: a watch-request page must
        // never overwrite the exchange feed beside it.
        val current = PrivacyUiState(
            loading = false,
            exchanges = listOf(exchange("task-one")),
        )
        val merged = mergePrivacySubscriptionApprovals(
            current,
            approvals = PrivacySubscriptionApprovalsEnvelope(totalCount = 0),
        )

        assertEquals("task-one", merged.exchanges.single().taskId)
        assertEquals(0, merged.subscriptionApprovalsTotalCount)
    }

    @Test
    fun lostResolutionResponseReconcilesCommittedApprovalWithoutSubmittingAgain() = runTest {
        var submitCount = 0
        var reloadCount = 0
        val transportFailure = IllegalStateException("fictional response loss")

        val outcome = resolveSubscriptionApprovalAndReconcile(
            resolve = {
                submitCount += 1
                throw transportFailure
            },
            reload = {
                reloadCount += 1
                subscriptionApproval("approved")
            },
        )

        assertEquals(1, submitCount)
        assertEquals(1, reloadCount)
        assertTrue(outcome is PrivacySubscriptionResolutionOutcome.Reconciled)
        assertEquals(
            "approved",
            (outcome as PrivacySubscriptionResolutionOutcome.Reconciled).detail.status,
        )
    }

    @Test
    fun confirmedPendingApprovalKeepsOriginalResolutionFailure() = runTest {
        val transportFailure = IllegalStateException("fictional rejection")

        val outcome = resolveSubscriptionApprovalAndReconcile(
            resolve = { throw transportFailure },
            reload = { subscriptionApproval("pending") },
        )

        assertTrue(outcome is PrivacySubscriptionResolutionOutcome.Failed)
        outcome as PrivacySubscriptionResolutionOutcome.Failed
        assertEquals(transportFailure, outcome.error)
        assertEquals("pending", outcome.latest?.status)
    }

    @Test
    fun lostRevokeResponseReconcilesTerminalStateWithoutSubmittingAgain() = runTest {
        var submitCount = 0
        var reloadCount = 0

        val outcome = revokeSubscriptionAndReconcile(
            revoke = {
                submitCount += 1
                throw IllegalStateException("fictional response loss")
            },
            reload = {
                reloadCount += 1
                subscriptionDetail("revoked")
            },
        )

        assertEquals(1, submitCount)
        assertEquals(1, reloadCount)
        assertTrue(outcome is PrivacySubscriptionRevokeOutcome.Reconciled)
    }

    @Test
    fun nonTerminalRevokeReconciliationPreservesOriginalFailure() = runTest {
        val actionFailure = IllegalStateException("fictional response loss")
        val outcome = revokeSubscriptionAndReconcile(
            revoke = { throw actionFailure },
            reload = { subscriptionDetail("active") },
        )

        assertTrue(outcome is PrivacySubscriptionRevokeOutcome.Failed)
        outcome as PrivacySubscriptionRevokeOutcome.Failed
        assertEquals(actionFailure, outcome.error)
        assertEquals("active", outcome.latest?.status)
    }

    @Test
    fun pinnedReviewsAreCappedAndNeverDuplicatedInTheFeedBelow() {
        val pending = (1..PrivacyUiState.MAX_PINNED_REVIEWS + 2).map {
            pendingExchange("task-$it", "approval-$it")
        }
        val state = PrivacyUiState(exchanges = pending + exchange("task-shared"))

        assertEquals(PrivacyUiState.MAX_PINNED_REVIEWS, state.pendingReviews.size)
        val pinnedIds = state.pendingReviews.map { it.taskId }.toSet()
        assertTrue(state.feed.none { it.taskId in pinnedIds })
        // The overflow stays visible in the feed rather than disappearing.
        assertEquals(3, state.feed.size)
    }

    @Test
    fun approvalPageMergeDeduplicatesAndKeepsTheExactServerTotal() {
        val refresh = CursorPagingState().beginRefresh()
        val first = mergePrivacyApprovalPage(
            currentItems = emptyList(),
            paging = refresh.state,
            request = refresh.request,
            incomingItems = listOf(PrivacySubscriptionApprovalSummary(id = "approval-one")),
            nextCursor = "cursor-two",
            totalCount = 72,
        ) { it.id }
        checkNotNull(first)
        val more = first.paging.beginLoadMore()
        checkNotNull(more)

        val merged = mergePrivacyApprovalPage(
            currentItems = first.items,
            paging = more.state,
            request = more.request,
            incomingItems = listOf(
                PrivacySubscriptionApprovalSummary(id = "approval-one"),
                PrivacySubscriptionApprovalSummary(id = "approval-two"),
            ),
            nextCursor = null,
            totalCount = 73,
        ) { it.id }

        checkNotNull(merged)
        assertEquals(listOf("approval-one", "approval-two"), merged.items.map { it.id })
        assertEquals(73, merged.totalCount)
        assertFalse(merged.paging.canLoadMore)
    }

    @Test
    fun approvalPageMergeRejectsAResponseOwnedByAnOlderGeneration() {
        val initial = CursorPagingState(nextCursor = "cursor-two")
        val stalePage = checkNotNull(initial.beginLoadMore())
        val refresh = stalePage.state.beginRefresh()

        val merged = mergePrivacyApprovalPage(
            currentItems = listOf(PrivacySubscriptionApprovalSummary(id = "approval-one")),
            paging = refresh.state,
            request = stalePage.request,
            incomingItems = listOf(PrivacySubscriptionApprovalSummary(id = "approval-stale")),
            nextCursor = null,
            totalCount = 2,
        ) { it.id }

        assertNull(merged)
    }

    @Test
    fun firstPageApprovalFailureRetriesARefreshWhilePageFailureRetriesItsCursor() {
        val refresh = CursorPagingState().beginRefresh()
        val failedRefresh = refresh.state.failRefresh(
            refresh.request,
            IllegalStateException("fictional refresh failure"),
        )
        val paging = CursorPagingState(nextCursor = "cursor-two").beginLoadMore()
        checkNotNull(paging)
        val failedPage = paging.state.failLoadMore(
            paging.request,
            IllegalStateException("fictional page failure"),
        )

        assertTrue(shouldRetryPrivacyApprovalRefresh(failedRefresh))
        assertFalse(shouldRetryPrivacyApprovalRefresh(failedPage))
    }

    @Test
    fun exchangeDetailReloadInvalidatesEarlierResponsesAndItsPagination() {
        val gate = PrivacyExchangeDetailRequestGate()
        val firstLoad = gate.beginLoad()
        val page = CursorPagingState(nextCursor = "older").beginLoadMore()
        checkNotNull(page)

        val secondLoad = gate.beginLoad()
        val refreshedPaging = page.state.beginRefresh().state

        assertFalse(gate.ownsLoad(firstLoad))
        assertTrue(gate.ownsLoad(secondLoad))
        assertFalse(refreshedPaging.owns(page.request))
    }

    @Test
    fun exchangeDetailPaginationBlocksAPollAndSupersedesAnOlderRefresh() {
        val gate = PrivacyExchangeDetailRequestGate()
        val background = gate.beginLoad()
        val paging = CursorPagingState(nextCursor = "older").beginLoadMore()
        checkNotNull(paging)

        gate.invalidateLoad()

        assertFalse(gate.ownsLoad(background))
        assertFalse(
            privacyExchangeBackgroundRefreshAllowed(
                foregroundLoadsInFlight = 1,
                backgroundLoadInFlight = false,
                paging = paging.state,
            ),
        )
    }

    @Test
    fun exchangeDetailBackgroundRefreshPreservesOlderPagesAndTheirCursor() {
        val olderRunning = exchange("task-older").copy(status = "running", outcome = "checking")
        val recent = exchange("task-recent")
        val paging = CursorPagingState(nextCursor = "cursor-older")
        val current = PrivacyExchangeDetailUiState(
            loading = false,
            exchanges = listOf(olderRunning, recent),
            exchangePaging = paging,
        )
        val refreshedRecent = recent.copy(status = "denied", outcome = "not_shared")
        val refreshedOlder = olderRunning.copy(status = "denied", outcome = "not_shared")
        var walk = PrivacyRunningExchangePageWalk(
            remainingTaskIds = setOf(olderRunning.taskId),
        )
        walk = walk.adding(
            PrivacyExchangePresentationPage(
                exchanges = listOf(refreshedRecent),
                previousCursor = "cursor-older",
            ),
        )
        assertFalse(walk.complete)
        walk = walk.adding(
            PrivacyExchangePresentationPage(exchanges = listOf(refreshedOlder)),
        )
        assertTrue(walk.complete)
        walk = walk.adding(
            PrivacyExchangePresentationPage(exchanges = listOf(refreshedOlder)),
        )
        assertEquals(2, walk.exchanges.size)

        val merged = mergePrivacyExchangeBackgroundRefresh(
            current = current,
            conversation = PrivacyConversationDetail(id = "conversation-example"),
            page = walk.page(),
            events = emptyList(),
        )

        assertEquals(listOf("task-older", "task-recent"), merged.exchanges.map { it.taskId })
        assertEquals("not_shared", merged.exchanges.first().outcome)
        assertEquals("not_shared", merged.exchanges.last().outcome)
        assertEquals(paging, merged.exchangePaging)
    }

    @Test
    fun deletionSupersedesAnyInFlightExchangeLoad() {
        val gate = PrivacyExchangeDetailRequestGate()
        val load = gate.beginLoad()
        val deletion = gate.beginDelete()

        assertFalse(gate.ownsLoad(load))
        assertTrue(gate.ownsDelete(deletion))
    }

    @Test
    fun unavailableReviewerHealthDoesNotBlankActivity() {
        val existingHealth = PrivacyReviewerHealth(status = "attention", recentOperationalFailureCount = 2)
        val current = PrivacyUiState(
            loading = false,
            reviewerHealth = existingHealth,
        )

        val merged = mergePrivacyActivity(
            current = current,
            feed = PrivacyExchangeFeedPage(exchanges = listOf(exchange("task-one"))),
            reviewerHealth = null,
        )

        assertEquals(existingHealth, merged.reviewerHealth)
        assertEquals(listOf("task-one"), merged.exchanges.map { it.taskId })
    }

    @Test
    fun aSucceedingActivityReadClearsTheFailureItReplaces() {
        val current = PrivacyUiState(loading = false, error = IllegalStateException("offline"))

        val merged = mergePrivacyActivity(
            current = current,
            feed = PrivacyExchangeFeedPage(exchanges = listOf(exchange("task-one"))),
            reviewerHealth = null,
        )

        assertNull(merged.error)
        assertEquals(listOf("task-one"), merged.exchanges.map { it.taskId })
    }

    @Test
    fun newerApprovalRequestOwnsTheScreen() {
        val gate = PrivacyApprovalRequestGate()
        val resolution = gate.begin()
        val authoritativeReload = gate.begin()

        assertFalse(gate.owns(resolution))
        assertTrue(gate.owns(authoritativeReload))
    }

    @Test
    fun deletionImmediatelyRemovesOnlyTheMatchingConversationsExchanges() {
        val state = PrivacyUiState(
            loading = false,
            exchanges = listOf(
                exchange("task-one", conversationId = "conversation-one"),
                exchange("task-two", conversationId = "conversation-two"),
            ),
        )

        val updated = removeDeletedConversation(state, "conversation-one")

        assertEquals(listOf("task-two"), updated.exchanges.map { it.taskId })
    }

    @Test
    fun approvalResolutionRefreshesOnlyItsOpenConversation() {
        assertTrue(shouldRefreshConversation("conversation-one", "conversation-one"))
        assertFalse(shouldRefreshConversation("conversation-one", "conversation-two"))
    }

    @Test
    fun onlyOneExchangesSliceOfTheLedgerReachesItsSpine() {
        val events = listOf(
            auditEvent("event-a", "task-one"),
            auditEvent("event-b", "task-two"),
            auditEvent("event-c", "task-one"),
        )

        assertEquals(listOf("event-a", "event-c"), eventsForTask(events, "task-one").map { it.id })
        assertEquals(listOf("event-b"), eventsForTask(events, "task-two").map { it.id })
    }

    @Test
    fun approvalDetailProjectsOntoTheExchangeTheReviewCardSpeaks() {
        val projected = approvalAsExchange(
            dev.omnesis.android.transport.dto.PrivacyApprovalDetail(
                id = "approval-example",
                taskId = "task-example",
                conversationId = "conversation-example",
                workflowId = "workflow-example",
                workflowName = "Prepare project update",
                workflowPurpose = "Prepare a concise update.",
                externalAgent = PrivacyExternalAgentIdentity("Atlas (openclaw)", "token"),
                status = "pending",
                createdAt = 100,
                expiresAt = 200,
                question = "What is the next milestone?",
                candidateAnswer = "The next invented review is on 14 September.",
                review = dev.omnesis.android.transport.dto.PrivacyReviewRecord(
                    rationale = "Exact schedule detail needs approval.",
                ),
            ),
        )

        assertEquals("needs_review", projected.outcome)
        assertEquals("approval-example", projected.approval?.id)
        assertEquals("The next invented review is on 14 September.", projected.pendingCandidate)
        assertTrue(isPendingPrivacyReview(projected))
        assertEquals("Exact schedule detail needs approval.", projected.review?.rationale)
    }

    private fun exchange(taskId: String, conversationId: String = "conversation-example") =
        PrivacyExchangePresentation(
            taskId = taskId,
            conversationId = conversationId,
            workflowId = "workflow-example",
            externalAgent = PrivacyExternalAgentIdentity("Atlas", "token"),
            workflow = PrivacyExchangeWorkflow("Example workflow", "Prepare an invented update."),
            question = "What changed?",
            status = "released",
            outcome = "shared",
            createdAt = 100,
            resolvedAt = 200,
            sharedAt = 300,
        )

    private fun pendingExchange(taskId: String, approvalId: String) = exchange(taskId).copy(
        status = "approval_required",
        outcome = "needs_review",
        resolvedAt = null,
        sharedAt = null,
        pendingCandidate = "An invented held answer.",
        approval = PrivacyExchangeApproval(id = approvalId, status = "pending", expiresAt = 400),
    )

    private fun auditEvent(id: String, taskId: String) =
        dev.omnesis.android.transport.dto.PrivacyAuditEventSummary(
            id = id,
            taskId = taskId,
            kind = "privacy_review",
            createdAt = 100,
        )

    private fun subscriptionApproval(status: String) = PrivacySubscriptionApprovalDetail(
        id = "subscription-approval-example",
        subscriptionId = "subscription-example",
        workflowHandle = "workflow-example",
        integration = PrivacyExternalAgentIdentity(displayName = "OpenClaw", source = "token"),
        status = status,
        interpretedCondition = PrivacyInterpretedCondition(
            summary = "A fictional project update requests a decision.",
        ),
        interpretation = PrivacyInterpretedCondition(
            summary = "A fictional project update requests a decision.",
        ),
        workflowId = "workflow-example",
        integrationDeviceId = "integration-device-example",
        integrationDevice = PrivacySubscriptionIntegrationDevice(
            id = "integration-device-example",
            name = "Fictional OpenClaw integration",
            kind = "agent",
        ),
        workflow = PrivacySubscriptionWorkflow(
            id = "workflow-example",
            name = "Fictional project review",
            purpose = "Review invented project updates.",
        ),
        revisionId = "revision-example",
        revision = 1,
        createdAt = 100,
        expiresAt = 200,
        condition = PrivacySubscriptionCondition(
            description = "a fictional project update requests a decision",
        ),
        reaction = PrivacySubscriptionReaction(
            instruction = "Prepare an invented checklist.",
        ),
        categories = listOf("documents"),
        policyRevision = "policy-example",
    )

    private fun subscriptionDetail(status: String) = PrivacySubscriptionDetail(
        id = "subscription-example",
        workflowHandle = "workflow-example",
        integration = PrivacyExternalAgentIdentity(displayName = "OpenClaw", source = "token"),
        status = status,
    )
}
