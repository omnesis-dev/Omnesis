// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyApprovalDetail
import dev.omnesis.android.transport.dto.PrivacyAuditEventDisplay
import dev.omnesis.android.transport.dto.PrivacyAuditEventSummary
import dev.omnesis.android.transport.dto.PrivacyAuditStatusDisplay
import dev.omnesis.android.transport.dto.PrivacyConversationDetail
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import dev.omnesis.android.transport.dto.PrivacyFinding
import dev.omnesis.android.transport.dto.PrivacyReviewRecord
import dev.omnesis.android.ui.privacy.PrivacyApprovalContent
import dev.omnesis.android.ui.privacy.PrivacyApprovalUiState
import dev.omnesis.android.ui.privacy.PrivacyExchangeDetailContent
import dev.omnesis.android.ui.privacy.PrivacyExchangeDetailUiState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The policy an answer was reviewed under, as the row that opens it on the detail and the approval. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrivacyPolicyLinkScreenshotTest {

    private val agent = PrivacyExternalAgentIdentity(displayName = "Atlas (openclaw)", source = "token")

    private val findings = listOf(
        PrivacyFinding(
            category = "schedule",
            detailLevel = "exact",
            subject = "user",
            disposition = "approval",
            description = "The held answer contains an exact date from a private calendar.",
        ),
    )

    private val conversation = PrivacyConversationDetail(
        id = "conversation-example",
        workflowId = "workflow-example",
        workflowName = "Prepare project update",
        externalAgent = agent,
        title = "What changed in the Northstar project?",
        taskCount = 1,
        latestOutcome = "shared_with_reductions",
        workflowStatus = "active",
    )

    private val exchange = PrivacyExchangePresentation(
        taskId = "task-shared-example",
        conversationId = conversation.id,
        workflowId = conversation.workflowId,
        externalAgent = agent,
        workflow = PrivacyExchangeWorkflow(
            "Prepare project update",
            "Prepare a concise update for an external project tracker.",
        ),
        question = "What changed in the Northstar project?",
        status = "released_with_reductions",
        outcome = "shared_with_reductions",
        createdAt = 1_781_999_000_000,
        resolvedAt = 1_781_999_020_000,
        sharedAt = 1_781_999_025_000,
        sharedAnswer = "The invented project review is planned for September.",
        draftAnswer = "The invented project review is planned for 14 September at 10:00.",
        reductions = listOf("Exact day and time removed"),
        review = PrivacyExchangeReview(
            findings = findings,
            rationale = "The policy allows a summary but not the exact date.",
            policyFamilyId = "family-example",
            policyFamilyName = "Everyday policy",
        ),
    )

    private val events = listOf(
        PrivacyAuditEventSummary(
            id = "event-review",
            taskId = exchange.taskId,
            kind = "privacy_review",
            createdAt = 1_781_999_010_000,
            display = PrivacyAuditEventDisplay(
                title = "Privacy review",
                text = "The policy allows a summary but not the exact date.",
                decodedStatus = PrivacyAuditStatusDisplay("reduced", "Details removed"),
                provider = "example-provider",
                model = "reviewer-example-v1",
            ),
        ),
    )

    private val approval = PrivacyApprovalDetail(
        id = "approval-example",
        taskId = "task-pending-example",
        workflowId = "workflow-example",
        conversationId = conversation.id,
        workflowName = "Prepare project update",
        externalAgent = agent,
        status = "pending",
        createdAt = 1_782_000_000_000,
        expiresAt = 1_782_086_400_000,
        workflowPurpose = "Prepare a concise update for an external project tracker.",
        question = "What is the next milestone?",
        candidateAnswer = "The next invented project review is scheduled for 14 September at 10:00.",
        review = PrivacyReviewRecord(
            recipeVersion = "privacy-review-v1",
            provider = "example-provider",
            model = "reviewer-example-v1",
            policyRevision = "example-revision",
            findings = findings,
            rationale = "The global policy requires approval before exact schedule details leave Omnesis.",
            policyFamilyId = "family-example",
            policyFamilyName = "Everyday policy",
        ),
    )

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark, content = content)
            }
        }
    }

    @Composable
    private fun detail() = PrivacyExchangeDetailContent(
        state = PrivacyExchangeDetailUiState(
            loading = false,
            conversation = conversation,
            exchanges = listOf(exchange),
            events = events,
        ),
        shown = listOf(exchange),
        onBack = {},
        onRetry = {},
        onOpenPolicy = { _, _ -> },
    )

    @Composable
    private fun approvalScreen() = PrivacyApprovalContent(
        state = PrivacyApprovalUiState(loading = false, detail = approval),
        onBack = {},
        onRetry = {},
        onOpenPolicy = { _, _ -> },
    )

    @Test
    fun privacy_spine_reviewed_under_policy_light() =
        capture("privacy_spine_reviewed_under_policy_light", false) { detail() }

    @Test
    fun privacy_spine_reviewed_under_policy_dark() =
        capture("privacy_spine_reviewed_under_policy_dark", true) { detail() }

    @Test
    fun privacy_approval_reviewed_under_policy_light() =
        capture("privacy_approval_reviewed_under_policy_light", false) { approvalScreen() }

    @Test
    fun privacy_approval_reviewed_under_policy_dark() =
        capture("privacy_approval_reviewed_under_policy_dark", true) { approvalScreen() }
}
