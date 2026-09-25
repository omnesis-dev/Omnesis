// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyAnswerComparisonWire
import dev.omnesis.android.transport.dto.PrivacyAnswerDiffLineWire
import dev.omnesis.android.transport.dto.PrivacyAnswerDiffSpanWire
import dev.omnesis.android.transport.dto.PrivacyAuditEventDisplay
import dev.omnesis.android.transport.dto.PrivacyAuditEventSummary
import dev.omnesis.android.transport.dto.PrivacyAuditStatusDisplay
import dev.omnesis.android.transport.dto.PrivacyConversationDetail
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import dev.omnesis.android.ui.common.CursorPagingState
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrivacyExchangeDetailUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun theSpineTellsTheStoryInEventOrderAcrossTheBoundary() {
        showDetail()

        compose.onNodeWithText("Atlas asked").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("YOUR MACHINE").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Omnesis drafted an answer").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Privacy check").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("LEFT YOUR MACHINE").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Atlas received this answer", substring = true)
            .performScrollTo()
            .assertIsDisplayed()
    }

    @Test
    fun anOauthExchangeNamesItsPrincipalAndConnection() {
        val principal = PrivacyExternalAgentIdentity(
            displayName = "Research assistant",
            narrativeName = "Research assistant",
            connectionName = "Desktop connection",
            source = "principal",
        )

        showDetail(exchange = exchange.copy(externalAgent = principal))

        compose.onNodeWithText("Principal").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Research assistant asked").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Connection").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Desktop connection").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Caller").assertDoesNotExist()
    }

    @Test
    fun everyRecordedStepIsOnTheSpineWithNothingLeftToOpen() {
        showDetail()

        // The reviewing model is stated on the decision card, and no toggle
        // stands between the reader and the steps.
        compose.onNodeWithText("Checked by example-provider / reviewer-example-v1.")
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText("Technical record").assertDoesNotExist()
        compose.onNodeWithText("Copy record").assertDoesNotExist()
    }

    @Test
    fun theSpineNeverShowsADigestOrAByteCount() {
        showDetail()

        compose.onNodeWithText("Payload digest").assertDoesNotExist()
        compose.onNodeWithText("Payload bytes").assertDoesNotExist()
    }

    @Test
    fun aConversationWideViewDoesNotClaimNoExchangesWhenEarlierPagesStalled() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyExchangeDetailContent(
                    state = PrivacyExchangeDetailUiState(
                        loading = false,
                        conversation = conversation,
                        exchangePaging = CursorPagingState(stoppedBeforeEnd = true),
                    ),
                    shown = emptyList(),
                    onBack = {},
                    onRetry = {},
                )
            }
        }

        compose.onNodeWithText("This exchange is no longer available").assertDoesNotExist()
    }

    @Test
    fun theComparisonSaysWhichSideEachLineIsOnRatherThanColouringIt() {
        showDetail(events = events + releasedWithDiff)

        compose.onNodeWithText("Compared with the draft").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription(
            "Removed from the draft: It starts at 10:00. Changed: at 10:00",
        ).performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Added in the shared answer: It starts.")
            .performScrollTo()
            .assertIsDisplayed()
        // The comparison carries the released text line by line, so the step
        // does not print its own copy of it as well.
        compose.onNodeWithText("It starts.", substring = false).assertDoesNotExist()
    }

    @Test
    fun anIdenticalReleaseIsStatedInOneLineRatherThanShownAgain() {
        showDetail(events = events + releasedIdentical)

        compose.onNodeWithText("This went out exactly as drafted.")
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText("Compared with the draft").assertDoesNotExist()
    }

    /* ── Whose words a listener is hearing ── */

    @Test
    fun theCallersQuestionAndTheAnswerAreAnnouncedAsQuotations() {
        showDetail()

        compose.onNodeWithContentDescription("Quoted question: What changed in the invented project?")
            .performScrollTo()
            .assertIsDisplayed()
        // Something left, so the block holds the text that left rather than a draft.
        compose.onNodeWithContentDescription(
            "Quoted answer that was shared: The invented review is planned for September.",
        ).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun anUnattendedDraftRemainsVisibleWithoutOfferingAReleaseAction() {
        val unattended = exchange.copy(
            status = "denied",
            outcome = "not_shared",
            sharedAt = null,
            sharedAnswer = null,
            draftAnswer = "The fictional reception desk is open until 17:00.",
            pendingCandidate = null,
            approval = null,
            userDecision = null,
            denialReason = "approval_not_available",
        )

        showDetail(exchange = unattended)

        compose.onNodeWithContentDescription(
            "Quoted draft answer: The fictional reception desk is open until 17:00.",
        ).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(
            "The privacy check recommended approval, but this request has no approval flow. " +
                "Omnesis did not share the answer.",
        ).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("The draft is not available.", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Share once").assertDoesNotExist()
    }

    @Test
    fun anUnverifiableUnattendedDraftShowsOneUnavailableMessage() {
        val unavailable = exchange.copy(
            status = "denied",
            outcome = "not_shared",
            sharedAt = null,
            sharedAnswer = null,
            draftAnswer = null,
            pendingCandidate = null,
            approval = null,
            denialReason = "approval_not_available",
        )

        showDetail(exchange = unavailable)

        compose.onNodeWithText("The draft is not available. Nothing about it left this machine.")
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithText("This draft has not left this machine.").assertDoesNotExist()
    }

    @Test
    fun aRecordedDraftTakesPriorityOverTheReleasedAnswerInTheDraftCard() {
        val withDraft = exchange.copy(
            draftAnswer = "The invented review is planned for 14 September at 10:00.",
        )

        showDetail(exchange = withDraft)

        compose.onNodeWithContentDescription(
            "Quoted draft answer: The invented review is planned for 14 September at 10:00.",
        ).performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription(
            "Quoted answer that was shared: The invented review is planned for September.",
        ).assertDoesNotExist()
    }

    @Test
    fun aStepQuotesTheReviewersOwnWordsAndLeavesOmnesisSentencesInProse() {
        showDetail(events = events + outboundResponse)

        compose.onNodeWithContentDescription(
            "Quoted privacy check summary: The policy allowed this answer.",
        ).performScrollTo().assertIsDisplayed()
        // The gateway wrote the outbound-response sentence about itself, so it
        // is never attributed to the exchange.
        compose.onNodeWithText("The first occurrence of this exact response was returned.")
            .performScrollTo()
            .assertIsDisplayed()
        compose.onNodeWithContentDescription(
            "Quoted answer that was shared: The first occurrence of this exact response was returned.",
        ).assertDoesNotExist()
    }

    private fun showDetail(
        events: List<PrivacyAuditEventSummary> = this.events,
        exchange: PrivacyExchangePresentation = this.exchange,
    ) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyExchangeDetailContent(
                    state = PrivacyExchangeDetailUiState(
                        loading = false,
                        conversation = conversation,
                        exchanges = listOf(exchange),
                        events = events,
                    ),
                    shown = listOf(exchange),
                    onBack = {},
                    onRetry = {},
                )
            }
        }
    }

    private val agent = PrivacyExternalAgentIdentity(displayName = "Atlas (openclaw)", source = "token")

    private val conversation = PrivacyConversationDetail(
        id = "conversation-example",
        workflowId = "workflow-example",
        workflowName = "Prepare project update",
        externalAgent = agent,
        title = "What changed?",
        taskCount = 1,
        latestOutcome = "shared",
        workflowStatus = "active",
    )

    private val exchange = PrivacyExchangePresentation(
        taskId = "task-example",
        conversationId = conversation.id,
        workflowId = conversation.workflowId,
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

    private val events = listOf(
        PrivacyAuditEventSummary(
            id = "event-review",
            taskId = "task-example",
            kind = "privacy_review",
            createdAt = 150,
            display = PrivacyAuditEventDisplay(
                title = "Privacy review",
                text = "The policy allowed this answer.",
                decodedStatus = PrivacyAuditStatusDisplay("allowed", "Allowed"),
                provider = "example-provider",
                model = "reviewer-example-v1",
            ),
        ),
    )

    /** A step whose body is the gateway's own sentence about what it did. */
    private val outboundResponse = PrivacyAuditEventSummary(
        id = "event-egress",
        taskId = "task-example",
        kind = "egress",
        createdAt = 310,
        display = PrivacyAuditEventDisplay(
            title = "Outbound response",
            text = "The first occurrence of this exact response was returned.",
            decodedStatus = PrivacyAuditStatusDisplay("allowed", "Shared"),
        ),
    )

    private val releasedWithDiff = PrivacyAuditEventSummary(
        id = "event-released",
        taskId = "task-example",
        kind = "released",
        createdAt = 300,
        display = PrivacyAuditEventDisplay(
            title = "Left this machine",
            text = "It starts.",
            decodedStatus = PrivacyAuditStatusDisplay("reduced", "Details removed"),
        ),
        decodedAnswerComparison = PrivacyAnswerComparisonWire(
            kind = "diff",
            lines = listOf(
                PrivacyAnswerDiffLineWire(
                    op = "removed",
                    text = "It starts at 10:00.",
                    spans = listOf(
                        PrivacyAnswerDiffSpanWire("equal", "It starts"),
                        PrivacyAnswerDiffSpanWire("removed", " at 10:00"),
                        PrivacyAnswerDiffSpanWire("equal", "."),
                    ),
                ),
                PrivacyAnswerDiffLineWire(op = "added", text = "It starts."),
            ),
        ),
    )

    private val releasedIdentical = PrivacyAuditEventSummary(
        id = "event-released",
        taskId = "task-example",
        kind = "released",
        createdAt = 300,
        display = PrivacyAuditEventDisplay(title = "Left this machine"),
        decodedAnswerComparison = PrivacyAnswerComparisonWire(kind = "identical"),
    )
}
