// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyExchangeApproval
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import dev.omnesis.android.ui.common.CursorPagingState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Activity is the landing section: a held answer is decided here, in place, and
 * everything else is one flat row per exchange.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrivacyActivityUiTest {
    @get:Rule
    val compose = createComposeRule()

    /**
     * Privacy is the record of events. The rules — the policy documents included — live under
     * Settings beside the grants they govern, and a watch that is already running lives on the
     * Watches screen with everything else it does.
     */
    @Test
    fun privacyCarriesNeitherAPolicyNorAWatchesSection() {
        showPrivacy(state = PrivacyUiState(loading = false, exchanges = listOf(shared)))

        compose.onNodeWithText("Watches").assertDoesNotExist()
        compose.onNodeWithText("Policy").assertDoesNotExist()
        compose.onNodeWithText("The policy can only be edited on the web portal.")
            .assertDoesNotExist()
    }

    @Test
    fun aHeldAnswerIsDecidedOnTheLandingScreenWithoutNavigating() {
        var approved: String? = null
        var denied: String? = null
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchanges = listOf(pending),
            ),
            onApprove = { approved = it },
            onDeny = { denied = it },
        )

        compose.onNodeWithText("One answer is waiting for you").assertIsDisplayed()
        // The request and the held answer are the exchange's own words, so each
        // is announced as a quotation rather than read as more of this screen's
        // prose.
        compose.onNodeWithContentDescription("Quoted question: What is the next milestone?")
            .assertIsDisplayed()
        compose.onNodeWithContentDescription(
            "Quoted held answer: The next invented review is on 14 September.",
        ).assertIsDisplayed()
        compose.onNodeWithText("Your privacy policy asks you to decide").assertIsDisplayed()
        compose.onNodeWithText("Share once").performScrollTo().performClick()
        compose.runOnIdle { assertEquals("approval-example", approved) }
        compose.onNodeWithText("Don't share").performScrollTo().performClick()
        compose.runOnIdle { assertEquals("approval-example", denied) }
    }

    @Test
    fun theFeedNamesTheAgentWithoutItsRegistrySlugAndDoesNotRepeatItInTheOutcome() {
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchanges = listOf(shared),
            ),
        )

        // Who asked and what they asked are one sentence, so the row is matched as one.
        compose.onNodeWithText("Atlas asked", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Shared").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Shared with Atlas").assertDoesNotExist()
        compose.onNodeWithText("Atlas (openclaw) asked", substring = true).assertDoesNotExist()
    }

    @Test
    fun statusFilterCountsLoadedFeedRowsAndNeverHidesAPinnedReview() {
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchanges = listOf(pending, shared, failed),
            ),
        )

        compose.onNodeWithText("All 2")
            .performScrollTo()
            .assertIsDisplayed()
            .assertHeightIsAtLeast(48.dp)
            .assertWidthIsAtLeast(48.dp)
        compose.onNodeWithText("Shared 1").assertIsDisplayed()
        compose.onNodeWithText("Failed 1").performClick()

        compose.onNodeWithText("One answer is waiting for you")
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText("Why did the fictional request fail?", substring = true)
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText("What changed in the invented project?", substring = true)
            .assertDoesNotExist()
    }

    @Test
    fun narrowedEmptyFeedExplainsThatOnlyLoadedActivityWasFiltered() {
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchanges = listOf(shared),
            ),
        )

        compose.onNodeWithText("Not shared 0").performClick()
        compose.onNodeWithText("No matching activity").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Nothing has left this machine").assertDoesNotExist()
    }

    @Test
    fun unknownOutcomesRemainVisibleUnderEveryFilter() {
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchanges = listOf(unknown),
            ),
        )

        compose.onNodeWithText("Failed 1").performClick()
        compose.onNodeWithText("What happened in the fictional workflow?", substring = true)
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText("Outcome not recognised").assertIsDisplayed()
    }

    @Test
    fun activityAndDayLabelsAreAccessibilityHeadings() {
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchanges = listOf(undated),
            ),
        )

        compose.onNodeWithText("Recent activity").assert(isHeading())
        compose.onNodeWithText("DATE UNKNOWN").performScrollTo().assert(isHeading())
    }

    @Test
    fun compactTimesExposeFullLocalContextToAccessibilityServices() {
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchanges = listOf(shared, undated),
            ),
        )

        compose.onNodeWithContentDescription("1970", substring = true, useUnmergedTree = true)
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithContentDescription("Unknown", useUnmergedTree = true)
            .performScrollTo()
            .assertIsDisplayed()
    }

    @Test
    fun aPinnedReviewIsNotRepeatedAsAFeedRowBelowIt() {
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchanges = listOf(pending),
            ),
        )

        // Only the pinned card shows the question; the feed below is empty.
        compose.onNodeWithText("Nothing has left this machine").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun appendFailureUsesAContextualFooterWithoutBecomingAFullPrivacyError() {
        var retries = 0
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchanges = listOf(shared),
                exchangesPaging = CursorPagingState(
                    nextCursor = "older",
                    paginationError = IllegalStateException("fictional page failure"),
                ),
            ),
            onLoadMoreExchanges = { retries += 1 },
        )

        compose.onNodeWithText("Couldn't load older activity.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Retry loading older activity").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1, retries) }
        compose.onNodeWithText("Retry", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun initialFailureUsesTheScreenErrorChannelNotAnAppendFooter() {
        val refresh = CursorPagingState().beginRefresh()
        val failure = IllegalStateException("fictional initial failure")
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchangesPaging = refresh.state.failRefresh(refresh.request, failure),
                error = failure,
            ),
        )

        compose.onNodeWithText("Retry").assertIsDisplayed()
        compose.onNodeWithText("Couldn't load older activity.").assertDoesNotExist()
    }

    @Test
    fun activityDoesNotClaimEmptyWhilePagesOrAnAppendErrorRemain() {
        showPrivacy(
            state = PrivacyUiState(
                loading = false,
                exchangesPaging = CursorPagingState(
                    nextCursor = "older",
                    paginationError = IllegalStateException("fictional page failure"),
                ),
            ),
        )

        compose.onNodeWithText("Nothing has left this machine").assertDoesNotExist()
        compose.onNodeWithText("Couldn't load older activity.").performScrollTo().assertIsDisplayed()
    }

    private fun showPrivacy(
        state: PrivacyUiState,
        onApprove: (String) -> Unit = {},
        onDeny: (String) -> Unit = {},
        onLoadMoreExchanges: () -> Unit = {},
    ) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyContent(
                    state = state,
                    onOpenMenu = {},
                    onOpenExchange = { _, _ -> },
                    onRetry = {},
                    onApprove = onApprove,
                    onDeny = onDeny,
                    onLoadMoreExchanges = onLoadMoreExchanges,
                )
            }
        }
    }

    private val agent = PrivacyExternalAgentIdentity(displayName = "Atlas (openclaw)", source = "token")

    private val shared = PrivacyExchangePresentation(
        taskId = "task-shared",
        conversationId = "conversation-example",
        workflowId = "workflow-example",
        externalAgent = agent,
        workflow = PrivacyExchangeWorkflow("Prepare project update", "Prepare an invented update."),
        question = "What changed in the invented project?",
        status = "released",
        outcome = "shared",
        createdAt = 100,
        resolvedAt = 200,
        sharedAt = 300,
        sharedAnswer = "The invented review is planned for September.",
    )

    private val pending = PrivacyExchangePresentation(
        taskId = "task-pending",
        conversationId = "conversation-example",
        workflowId = "workflow-example",
        externalAgent = agent,
        workflow = PrivacyExchangeWorkflow("Prepare project update", "Prepare an invented update."),
        question = "What is the next milestone?",
        status = "approval_required",
        outcome = "needs_review",
        createdAt = 100,
        pendingCandidate = "The next invented review is on 14 September.",
        approval = PrivacyExchangeApproval(id = "approval-example", status = "pending", expiresAt = 400),
        review = PrivacyExchangeReview(
            fallbackCause = "policy_requires_review",
            rationale = "Exact schedule detail needs your approval.",
        ),
    )

    private val failed = shared.copy(
        taskId = "task-failed",
        question = "Why did the fictional request fail?",
        status = "failed",
        outcome = "failed",
        sharedAt = null,
        sharedAnswer = null,
    )

    private val unknown = shared.copy(
        taskId = "task-unknown",
        question = "What happened in the fictional workflow?",
        outcome = "future_outcome",
        sharedAt = null,
    )

    private val undated = unknown.copy(
        taskId = "task-undated",
        createdAt = 0,
        resolvedAt = null,
    )
}
