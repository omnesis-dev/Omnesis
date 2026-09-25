// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyExchangeApproval
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import dev.omnesis.android.ui.home.MainMenuDrawer
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Privacy surfaces decide what leaves the machine, so none of their state
 * may be carried by appearance alone — not a tinted banner, and not a bare
 * numeral on the menu row that leads to the decisions.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrivacyAccessibilityTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun aBannersKindIsCarriedByItsGlyphRatherThanItsTint() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                androidx.compose.foundation.layout.Column {
                    PrivacyBanner("The approval failed.", PrivacyBannerKind.ERROR)
                    PrivacyBanner("The policy changed elsewhere.", PrivacyBannerKind.WARNING)
                    PrivacyBanner("Answer approved.", PrivacyBannerKind.SUCCESS)
                }
            }
        }

        compose.onNodeWithContentDescription("Error").assertIsDisplayed()
        compose.onNodeWithContentDescription("Warning").assertIsDisplayed()
        compose.onNodeWithContentDescription("Success").assertIsDisplayed()
    }

    /**
     * The count lives on the menu row that leads to the decisions, so the badge is where a
     * screen reader must be told what the number means.
     */
    @Test
    fun thePrivacyMenuBadgeSaysWhatItCounts() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = emptyList(),
                    conversationsLoading = false,
                    onNewConversation = {},
                    onNavigate = {},
                    onResumeConversation = {},
                    onDeleteConversation = {},
                    onOpenSettings = {},
                    privacyPendingCount = 2,
                )
            }
        }

        // The row is one merged node to a screen reader, so the phrase is asserted on the
        // merged tree and the numeral it replaces must not survive beside it.
        compose.onNodeWithContentDescription("2 decisions waiting for you").assertExists()
        compose.onNodeWithText("2").assertDoesNotExist()
    }

    @Test
    fun theTrustBoundaryIsReadAsWrittenRatherThanSpelledOut() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PrivacyExchangeSpine(exchange = shared, events = emptyList())
            }
        }

        compose.onNodeWithContentDescription("your machine", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("left your machine", useUnmergedTree = true).assertExists()
    }

    private val agent = PrivacyExternalAgentIdentity(displayName = "Atlas (openclaw)", source = "token")

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

    private val shared = pending.copy(
        taskId = "task-shared",
        status = "released",
        outcome = "shared",
        pendingCandidate = null,
        sharedAnswer = "The invented review is planned for September.",
        approval = null,
        resolvedAt = 200,
        sharedAt = 300,
    )
}
