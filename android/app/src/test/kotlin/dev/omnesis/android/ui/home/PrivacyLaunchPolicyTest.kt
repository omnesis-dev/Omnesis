// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import dev.omnesis.android.transport.dto.PrivacyApprovalSummary
import dev.omnesis.android.transport.dto.PrivacyApprovalsPage
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the app does about privacy decisions when it comes forward, and what the menu says
 * about them — the two rules that decide whether an operator ever sees a held answer.
 */
class PrivacyLaunchPolicyTest {
    @Test
    fun aHeldAnswerIsOpenedWhenTheAppComesForwardWithNothingElseAsked() {
        val presentation = PendingApprovalPresentation()
        presentation.beginForeground()

        assertTrue(presentation.present("approval-example", explicitLaunchPending = false))
    }

    @Test
    fun nothingIsOpenedWhenNoDecisionIsWaiting() {
        val presentation = PendingApprovalPresentation()
        presentation.beginForeground()

        assertFalse(presentation.present(null, explicitLaunchPending = false))
        assertTrue(presentation.canOffer)
    }

    /** A launch still waiting on its bus names its own destination; the offer is dropped. */
    @Test
    fun aPendingExplicitLaunchWinsOverTheOffer() {
        val presentation = PendingApprovalPresentation()
        presentation.beginForeground()

        assertFalse(presentation.present("approval-example", explicitLaunchPending = true))
    }

    /**
     * A warm start delivers onStart() before onNewIntent(): the queue read is armed with no
     * launch in sight, the notification's approval then lands and is handled, and only
     * afterwards does the read reply. The reply must not stack a second decision on top.
     */
    @Test
    fun anExplicitLaunchHandledBeforeTheReplyArrivesStillWins() {
        val presentation = PendingApprovalPresentation()
        presentation.beginForeground()
        assertTrue(presentation.canOffer)
        presentation.recordExplicitLaunch()

        assertFalse(presentation.present("approval-other", explicitLaunchPending = false))
        // The session's single presentation was not spent by the dropped offer.
        assertTrue(presentation.canOffer)
    }

    @Test
    fun aDroppedOfferKeepsThePresentationForTheNextForeground() {
        val presentation = PendingApprovalPresentation()
        presentation.beginForeground()
        presentation.recordExplicitLaunch()
        assertFalse(presentation.present("approval-example", explicitLaunchPending = false))

        presentation.beginForeground()
        assertTrue(presentation.present("approval-example", explicitLaunchPending = false))
    }

    @Test
    fun onePresentationPerSessionSurvivesANewForeground() {
        val presentation = PendingApprovalPresentation()
        presentation.beginForeground()
        assertTrue(presentation.present("approval-example", explicitLaunchPending = false))

        presentation.beginForeground()
        assertFalse(presentation.canOffer)
        assertFalse(presentation.present("approval-example", explicitLaunchPending = false))
    }

    @Test
    fun theOldestHeldAnswerIsTheOneRowWhenOnlyOneIsWaiting() = runTest {
        val fetched = mutableListOf<String?>()
        val oldest = oldestPendingApprovalId(
            first = page(listOf("approval-only"), totalCount = 1),
        ) { cursor -> fetched += cursor; page(emptyList(), totalCount = 1) }

        assertEquals("approval-only", oldest)
        assertEquals(emptyList<String?>(), fetched)
    }

    /** The gateway lists newest first, so the tail of the queue is the decision about to expire. */
    @Test
    fun theOldestHeldAnswerIsTheTailOfANewestFirstQueue() = runTest {
        val fetched = mutableListOf<String?>()
        val oldest = oldestPendingApprovalId(
            first = page(listOf("approval-newest"), totalCount = 3),
        ) { cursor ->
            fetched += cursor
            page(listOf("approval-newest", "approval-middle", "approval-oldest"), totalCount = 3)
        }

        assertEquals("approval-oldest", oldest)
        assertEquals(listOf<String?>(null), fetched)
    }

    @Test
    fun aQueueLongerThanOnePageIsWalkedToItsTail() = runTest {
        val oldest = oldestPendingApprovalId(
            first = page(listOf("approval-1"), totalCount = 4),
        ) { cursor ->
            when (cursor) {
                null -> page(listOf("approval-1", "approval-2"), totalCount = 4, nextCursor = "after-2")
                "after-2" -> page(listOf("approval-3", "approval-4"), totalCount = 4)
                else -> error("unexpected cursor $cursor")
            }
        }

        assertEquals("approval-4", oldest)
    }

    private fun page(ids: List<String>, totalCount: Int, nextCursor: String? = null) =
        PrivacyApprovalsPage(
            approvals = ids.map { PrivacyApprovalSummary(id = it, status = "pending") },
            nextCursor = nextCursor,
            totalCount = totalCount,
        )

    @Test
    fun theBadgeCountsHeldAnswersOnAStockGateway() {
        assertEquals(
            3,
            privacyDecisionsWaiting(heldAnswers = 3, watchRequests = 4, experimental = false),
        )
    }

    @Test
    fun theBadgeAddsWatchRequestsWhereTheyCanBeSettled() {
        assertEquals(
            7,
            privacyDecisionsWaiting(heldAnswers = 3, watchRequests = 4, experimental = true),
        )
    }

    @Test
    fun anUnreadableQueueCountsAsNoneRatherThanAWrongNumber() {
        assertEquals(
            2,
            privacyDecisionsWaiting(heldAnswers = 2, watchRequests = null, experimental = true),
        )
        assertEquals(
            0,
            privacyDecisionsWaiting(heldAnswers = null, watchRequests = null, experimental = true),
        )
    }
}
