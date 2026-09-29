// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.AnswerCitation
import dev.omnesis.android.transport.dto.PrivacyApprovalDetail
import dev.omnesis.android.transport.dto.PrivacyConversationDetail
import dev.omnesis.android.transport.dto.PrivacyExchangeApproval
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrivacyCitationsUiTest {
    @get:Rule
    val compose = createComposeRule()

    /* ── Rows measured against the draft ── */

    @Test
    fun aReleasedCitationNamesTheFieldsTheDraftHadAndItLacksAndShowsTheDraftsValue() {
        val rows = privacyCitationRows(
            released = listOf(budget.copy(appUrl = null, timestamp = null)),
            drafted = listOf(budget),
        )

        val row = rows.single() as PrivacyCitationRow.Shared
        assertEquals(listOf(PrivacyCitationField.DATE, PrivacyCitationField.APP_LINK), row.withheldFields)
        assertEquals("examplemail://thread/q4-budget", row.value(PrivacyCitationField.APP_LINK))
        assertEquals("https://mail.example.com/thread/q4-budget", row.value(PrivacyCitationField.WEB_LINK))
    }

    @Test
    fun rowsFollowTheDraftsOrderWithAWithheldCitationInItsPlace() {
        val extra = AnswerCitation(documentId = "doc-extra", sourceType = "calendar", title = "Standup")
        val rows = privacyCitationRows(released = listOf(extra, budget), drafted = listOf(notes, budget))

        assertEquals(listOf("doc-notes", "doc-budget", "doc-extra"), rows.map { it.citation.documentId })
        assertEquals(PrivacyCitationRow.Withheld(notes), rows[0])
        assertEquals(PrivacyCitationRow.Shared(budget, draft = budget), rows[1])
        assertEquals(PrivacyCitationRow.Shared(extra), rows[2])
    }

    @Test
    fun withoutADraftEveryReleasedCitationIsStatedAsItIs() {
        val rows = privacyCitationRows(released = listOf(budget.copy(appUrl = null)))

        assertEquals(listOf(PrivacyCitationRow.Shared(budget.copy(appUrl = null))), rows)
    }

    @Test
    fun aDraftRecordedWithNoCitationsComparesNothingAway() {
        val rows = privacyCitationRows(released = listOf(budget), drafted = emptyList())

        assertEquals(listOf(PrivacyCitationRow.Shared(budget)), rows)
    }

    @Test
    fun theBaselineIsTheDraftsCitationsOnlyWhenADraftWasRecorded() {
        assertEquals(sharedExchange.draftCitations, privacyCitationBaseline(sharedExchange))
        assertEquals(null, privacyCitationBaseline(sharedExchange.copy(draftAnswer = null)))
    }

    @Test
    fun theDraftCardListsTheCitationsOfTheAnswerItShows() {
        assertEquals(sharedExchange.draftCitations, privacyDisplayedCitations(sharedExchange))
        val noDraft = sharedExchange.copy(draftAnswer = null)
        assertEquals(noDraft.sharedCitations, privacyDisplayedCitations(noDraft))
        val held = pendingExchange.copy(draftCitations = listOf(notes))
        assertEquals(held.pendingCitations, privacyDisplayedCitations(held))
    }

    @Test
    fun theDraftCardFollowsTheAnswersPrecedenceByPresenceNotByContent() {
        // A blank draft is still the answer's pick, and a blank answer shows no list.
        val blankDraft = sharedExchange.copy(draftAnswer = "  ")
        assertEquals(null, privacyDisplayedAnswer(blankDraft))
        assertEquals(emptyList<AnswerCitation>(), privacyDisplayedCitations(blankDraft))
    }

    /* ── The pending decision ── */

    @Test
    fun aPendingReviewCardWritesOutEveryLinkItWouldShare() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) { PrivacyReviewCard(exchange = pendingExchange) }
        }

        compose.onNodeWithText(PRIVACY_CITATIONS_PENDING_HEADING).assertIsDisplayed()
        compose.onNodeWithText(PRIVACY_CITATIONS_PENDING_NOTE).assertIsDisplayed()
        compose.onNodeWithText(PRIVACY_CITATIONS_WITHHELD_NOTE).assertDoesNotExist()
        compose.onNodeWithText("Q4 budget review").assertIsDisplayed()
        compose.onNodeWithText("gmail", substring = true).assertIsDisplayed()
        compose.onNodeWithText("https://mail.example.com/thread/q4-budget").assertIsDisplayed()
        compose.onNodeWithText("examplemail://thread/q4-budget").assertIsDisplayed()
    }

    @Test
    fun aCitationWithoutATitleIsUntitled() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyReviewCard(
                    exchange = pendingExchange.copy(pendingCitations = listOf(budget.copy(title = null))),
                )
            }
        }

        compose.onNodeWithText("Untitled").assertIsDisplayed()
    }

    @Test
    fun aWebLinkOpensWhenTappedAndALinkNothingHereOpensIsOnlyText() {
        val opened = mutableListOf<String>()
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyReviewCard(exchange = pendingExchange, onOpenUrl = { opened += it })
            }
        }

        compose.onNodeWithText("examplemail://thread/q4-budget").assertHasNoClickAction()
        compose.onNodeWithText("https://mail.example.com/thread/q4-budget")
            .assertHasClickAction()
            .performClick()
        assertEquals(listOf("https://mail.example.com/thread/q4-budget"), opened)
    }

    @Test
    fun theApprovalScreenListsTheCitationsHeldBesideTheCandidate() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyApprovalContent(
                    state = PrivacyApprovalUiState(
                        loading = false,
                        detail = PrivacyApprovalDetail(
                            id = "approval-example",
                            taskId = "task-pending",
                            status = "pending",
                            question = "When is the budget review?",
                            candidateAnswer = "The invented budget review is on Friday.",
                            candidateCitations = listOf(budget),
                        ),
                    ),
                    onBack = {},
                    onRetry = {},
                )
            }
        }

        compose.onNodeWithText("Q4 budget review").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("https://mail.example.com/thread/q4-budget").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun aPendingSpineWithADraftListsWhatShareOnceWouldReleaseAndWhatTheCheckWithheld() {
        showSpine(
            pendingExchange.copy(
                draftAnswer = "The invented budget review is on Friday, per the planning notes.",
                draftCitations = listOf(budget, notes),
            ),
        )

        compose.onNodeWithText(PRIVACY_CITATIONS_DRAFT_HEADING).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(PRIVACY_CITATIONS_PENDING_HEADING).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(PRIVACY_CITATIONS_WITHHELD_NOTE).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Withheld").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun theFeedReviewCardComparesTheHeldCitationsAgainstTheRecordedDraft() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyReviewCard(
                    exchange = pendingExchange.copy(
                        draftAnswer = "The invented budget review is on Friday, per the planning notes.",
                        draftCitations = listOf(budget, notes),
                    ),
                )
            }
        }

        compose.onNodeWithText(PRIVACY_CITATIONS_WITHHELD_NOTE).assertIsDisplayed()
        compose.onNodeWithText("Withheld").assertIsDisplayed()
        // The withheld citation's link is shown as the draft had it, and only as text.
        compose.onNodeWithText("https://notes.example.com/page/planning").assertHasNoClickAction()
    }

    /* ── What left ── */

    @Test
    fun theReleasedBandMarksAWithheldCitationAndAWithheldLink() {
        showSpine(sharedExchange)

        compose.onNodeWithText(PRIVACY_CITATIONS_SHARED_HEADING).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("withheld").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Withheld").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(PRIVACY_CITATIONS_WITHHELD_NOTE).performScrollTo().assertIsDisplayed()
        // The draft card lists the app link as drafted, and the band shows it
        // again, struck through, as the field the check withheld.
        compose.onAllNodesWithText("examplemail://thread/q4-budget").assertCountEquals(2)
    }

    @Test
    fun anExchangeWithNoCitationsShowsNoCitationsAtAll() {
        showSpine(
            sharedExchange.copy(sharedCitations = emptyList(), draftCitations = emptyList()),
        )

        compose.onNodeWithText(PRIVACY_CITATIONS_DRAFT_HEADING).assertDoesNotExist()
        compose.onNodeWithText(PRIVACY_CITATIONS_SHARED_HEADING).assertDoesNotExist()
    }

    private fun showSpine(exchange: PrivacyExchangePresentation) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyExchangeDetailContent(
                    state = PrivacyExchangeDetailUiState(
                        loading = false,
                        conversation = conversation,
                        exchanges = listOf(exchange),
                    ),
                    shown = listOf(exchange),
                    onBack = {},
                    onRetry = {},
                )
            }
        }
    }

    /* ── Fixtures (invented) ── */

    private val agent = PrivacyExternalAgentIdentity(displayName = "Atlas (openclaw)", source = "token")

    private val budget = AnswerCitation(
        documentId = "doc-budget",
        sourceType = "gmail",
        title = "Q4 budget review",
        timestamp = "2026-09-12T09:30:00Z",
        sourceUrl = "https://mail.example.com/thread/q4-budget",
        appUrl = "examplemail://thread/q4-budget",
    )

    private val notes = AnswerCitation(
        documentId = "doc-notes",
        sourceType = "notion",
        title = "Planning notes",
        sourceUrl = "https://notes.example.com/page/planning",
    )

    private val conversation = PrivacyConversationDetail(
        id = "conversation-example",
        workflowId = "workflow-example",
        workflowName = "Prepare budget update",
        externalAgent = agent,
        taskCount = 1,
    )

    private val pendingExchange = PrivacyExchangePresentation(
        taskId = "task-pending",
        conversationId = conversation.id,
        workflowId = conversation.workflowId,
        externalAgent = agent,
        workflow = PrivacyExchangeWorkflow("Prepare budget update", "Summarise an invented review."),
        question = "When is the budget review?",
        status = "approval_required",
        outcome = "needs_review",
        createdAt = 100,
        pendingCandidate = "The invented budget review is on Friday.",
        pendingCitations = listOf(budget),
        approval = PrivacyExchangeApproval(id = "approval-example", status = "pending", expiresAt = 1_000),
        review = PrivacyExchangeReview(rationale = "The policy requires approval for schedule details."),
    )

    private val sharedExchange = PrivacyExchangePresentation(
        taskId = "task-shared",
        conversationId = conversation.id,
        workflowId = conversation.workflowId,
        externalAgent = agent,
        workflow = PrivacyExchangeWorkflow("Prepare budget update", "Summarise an invented review."),
        question = "When is the budget review?",
        status = "released_with_reductions",
        outcome = "shared_with_reductions",
        createdAt = 100,
        resolvedAt = 200,
        sharedAt = 300,
        draftAnswer = "The invented budget review is on Friday, per the planning notes.",
        sharedAnswer = "The invented budget review is on Friday.",
        draftCitations = listOf(budget, notes),
        sharedCitations = listOf(budget.copy(appUrl = null)),
    )
}
