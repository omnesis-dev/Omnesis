// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyApprovalDetail
import dev.omnesis.android.transport.dto.PrivacyConversationDetail
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import dev.omnesis.android.transport.dto.PrivacyReviewRecord
import dev.omnesis.android.ui.common.CursorPagingState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The policy an exchange was reviewed under is offered as a row into that policy's
 * document, on the exchange detail and on the approval screen — and only where the record
 * names one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrivacyReviewedUnderPolicyUiTest {
    @get:Rule
    val compose = createComposeRule()

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

    private val reviewedUnderFamily = PrivacyExchangeReview(
        rationale = "The policy allows a summary but not the exact date.",
        policyFamilyId = "family-example",
        policyFamilyName = "Everyday policy",
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
        review = reviewedUnderFamily,
    )

    private val approval = PrivacyApprovalDetail(
        id = "approval-example",
        taskId = "task-pending-example",
        workflowId = "workflow-example",
        conversationId = conversation.id,
        workflowName = "Prepare project update",
        externalAgent = agent,
        status = "pending",
        createdAt = 100,
        expiresAt = 200,
        question = "What is the next milestone?",
        candidateAnswer = "The next invented review is on 14 September.",
        review = PrivacyReviewRecord(
            rationale = "The policy requires approval before exact dates leave Omnesis.",
            policyFamilyId = "family-example",
            policyFamilyName = "Everyday policy",
        ),
    )

    @Test
    fun theExchangeDetailOffersThePolicyTheAnswerWasReviewedUnder() {
        val opened = mutableListOf<Pair<String, String?>>()
        showDetail(exchange, onOpenPolicy = { id, name -> opened += id to name })

        compose.onNodeWithText("Reviewed under Everyday policy").performScrollTo().assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf("family-example" to "Everyday policy"), opened) }
    }

    @Test
    fun aRecordThatNamesNoFamilyRendersNoPolicyRow() {
        showDetail(exchange.copy(review = reviewedUnderFamily.copy(policyFamilyId = null, policyFamilyName = null)))

        compose.onNodeWithText("Reviewed under", substring = true).assertDoesNotExist()
        compose.onNodeWithText("See the policy it was reviewed under").assertDoesNotExist()
    }

    /** A record from a gateway that names the family by id alone still opens it. */
    @Test
    fun aFamilyWithoutANameIsStillReachable() {
        val opened = mutableListOf<Pair<String, String?>>()
        showDetail(
            exchange.copy(review = reviewedUnderFamily.copy(policyFamilyName = null)),
            onOpenPolicy = { id, name -> opened += id to name },
        )

        compose.onNodeWithText("See the policy it was reviewed under").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("family-example" to null), opened) }
    }

    @Test
    fun theApprovalScreenOffersThePolicyTheHeldAnswerWasReviewedUnder() {
        val opened = mutableListOf<Pair<String, String?>>()
        showApproval(approval, onOpenPolicy = { id, name -> opened += id to name })

        compose.onNodeWithText("Reviewed under Everyday policy").performScrollTo().assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf("family-example" to "Everyday policy"), opened) }
    }

    @Test
    fun anApprovalWhoseRecordNamesNoFamilyRendersNoPolicyRow() {
        showApproval(approval.copy(review = PrivacyReviewRecord(rationale = approval.review.rationale)))

        compose.onNodeWithText("Reviewed under", substring = true).assertDoesNotExist()
    }

    /** A card with nowhere to send the reader shows no row rather than one that goes nowhere. */
    @Test
    fun aReviewCardWithNoWayToOpenAPolicyShowsNoRow() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyReviewCard(exchange = approvalAsExchange(approval))
            }
        }

        compose.onNodeWithText("Reviewed under", substring = true).assertDoesNotExist()
    }

    /** The landing feed pins the same card without a way to open a policy, so it carries no row. */
    @Test
    fun theLandingFeedsPinnedReviewCarriesNoPolicyRow() {
        val pending = approvalAsExchange(approval)
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyContent(
                    state = PrivacyUiState(
                        loading = false,
                        exchanges = listOf(pending),
                        exchangesPaging = CursorPagingState(),
                    ),
                    onOpenMenu = {},
                    onOpenExchange = { _, _ -> },
                    onRetry = {},
                )
            }
        }

        compose.onNodeWithText("One answer is waiting for you").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Share once").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Reviewed under", substring = true).assertDoesNotExist()
        compose.onNodeWithText("See the policy it was reviewed under").assertDoesNotExist()
    }

    /** Surrounding whitespace on the wire is not part of the id or the name. */
    @Test
    fun theFamilyIdAndNameAreTrimmedBeforeTheyAreShownOrOpened() {
        val opened = mutableListOf<Pair<String, String?>>()
        showDetail(
            exchange.copy(
                review = reviewedUnderFamily.copy(policyFamilyId = "  family-example  ", policyFamilyName = " Everyday policy "),
            ),
            onOpenPolicy = { id, name -> opened += id to name },
        )

        compose.onNodeWithText("Reviewed under Everyday policy").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("family-example" to "Everyday policy"), opened) }
    }

    @Test
    fun aBlankFamilyIdRendersNoRow() {
        showDetail(exchange.copy(review = reviewedUnderFamily.copy(policyFamilyId = "   ")))

        compose.onNodeWithText("Reviewed under", substring = true).assertDoesNotExist()
        compose.onNodeWithText("See the policy it was reviewed under").assertDoesNotExist()
    }

    @Test
    fun aBlankNameFallsBackToTheGenericLabelAndOpensWithNoName() {
        val opened = mutableListOf<Pair<String, String?>>()
        showDetail(
            exchange.copy(review = reviewedUnderFamily.copy(policyFamilyName = "   ")),
            onOpenPolicy = { id, name -> opened += id to name },
        )
        compose.onNodeWithText("See the policy it was reviewed under").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("family-example" to null), opened) }
    }

    private fun showDetail(
        exchange: PrivacyExchangePresentation,
        onOpenPolicy: (String, String?) -> Unit = { _, _ -> },
    ) {
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
                    onOpenPolicy = onOpenPolicy,
                )
            }
        }
    }

    private fun showApproval(
        detail: PrivacyApprovalDetail,
        onOpenPolicy: (String, String?) -> Unit = { _, _ -> },
    ) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyApprovalContent(
                    state = PrivacyApprovalUiState(loading = false, detail = detail),
                    onBack = {},
                    onRetry = {},
                    onOpenPolicy = onOpenPolicy,
                )
            }
        }
    }
}
