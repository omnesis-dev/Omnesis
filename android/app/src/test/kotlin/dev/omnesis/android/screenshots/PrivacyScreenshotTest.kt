// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyAnswerComparisonWire
import dev.omnesis.android.transport.dto.PrivacyAnswerDiffLineWire
import dev.omnesis.android.transport.dto.PrivacyAnswerDiffSpanWire
import dev.omnesis.android.transport.dto.PrivacyApprovalDetail
import dev.omnesis.android.transport.dto.PrivacyAuditEventDisplay
import dev.omnesis.android.transport.dto.PrivacyAuditEventSummary
import dev.omnesis.android.transport.dto.PrivacyAuditStatusDisplay
import dev.omnesis.android.transport.dto.PrivacyConversationDetail
import dev.omnesis.android.transport.dto.PrivacyExchangeApproval
import dev.omnesis.android.transport.dto.PrivacyExchangeFailure
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.transport.dto.PrivacyExchangeReview
import dev.omnesis.android.transport.dto.PrivacyExchangeWorkflow
import dev.omnesis.android.transport.dto.PrivacyExternalAgentIdentity
import dev.omnesis.android.transport.dto.PrivacyFinding
import dev.omnesis.android.transport.dto.PrivacyInterpretedCondition
import dev.omnesis.android.transport.dto.PrivacyPolicyDocument
import dev.omnesis.android.transport.dto.PrivacyReviewRecord
import dev.omnesis.android.transport.dto.PrivacyReviewerHealth
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalDetail
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalSummary
import dev.omnesis.android.transport.dto.PrivacySubscriptionCondition
import dev.omnesis.android.transport.dto.PrivacySubscriptionIntegrationDevice
import dev.omnesis.android.transport.dto.PrivacySubscriptionReaction
import dev.omnesis.android.transport.dto.PrivacySubscriptionWorkflow
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.privacy.PrivacyAnswerBlock
import dev.omnesis.android.ui.privacy.PrivacyApprovalContent
import dev.omnesis.android.ui.privacy.PrivacyApprovalUiState
import dev.omnesis.android.ui.privacy.PrivacyContent
import dev.omnesis.android.ui.privacy.PrivacyExchangeDetailContent
import dev.omnesis.android.ui.privacy.PrivacyExchangeSpine
import dev.omnesis.android.ui.privacy.PrivacyExchangeDetailUiState
import dev.omnesis.android.ui.privacy.PrivacyFeedFilter
import dev.omnesis.android.ui.privacy.PrivacyPolicyContent
import dev.omnesis.android.ui.privacy.PrivacyPolicyUiState
import dev.omnesis.android.ui.privacy.PrivacyQuote
import dev.omnesis.android.ui.privacy.PrivacySubscriptionApprovalContent
import dev.omnesis.android.ui.privacy.PrivacySubscriptionApprovalUiState
import dev.omnesis.android.transport.dto.DirectAuditEvent
import dev.omnesis.android.transport.dto.DirectAuditEventDisplay
import dev.omnesis.android.transport.dto.DirectAuditSession
import dev.omnesis.android.transport.dto.PrivacyAnswerAgentTrace
import dev.omnesis.android.ui.privacy.AuditRawJsonSheet
import dev.omnesis.android.ui.privacy.AuditTab
import dev.omnesis.android.ui.privacy.auditRawJsonText
import dev.omnesis.android.ui.privacy.DirectAuditDetailContent
import dev.omnesis.android.ui.privacy.PrivacyAgentTranscripts
import dev.omnesis.android.ui.privacy.DirectAuditDetailUiState
import dev.omnesis.android.ui.privacy.DirectAuditUiState
import dev.omnesis.android.ui.privacy.PrivacyUiState
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import dev.omnesis.android.ui.privacy.privacyHeldAnswerTint
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrivacyScreenshotTest {

    /* ── Fixtures (invented; never sourced from a real corpus) ── */

    private val externalAgent = PrivacyExternalAgentIdentity(
        // The narrative surfaces strip the trailing registry slug; the technical
        // record keeps it. Both paths are exercised by keeping it here.
        displayName = "Atlas (openclaw)",
        source = "token",
    )

    private val findings = listOf(
        PrivacyFinding(
            category = "schedule",
            detailLevel = "exact",
            subject = "user",
            disposition = "approval",
            description = "The held answer contains an exact date from a private calendar.",
        ),
    )

    private val policyText = """
        # Omnesis privacy policy

        Credentials are blocked outright and cannot be released.
    """.trimIndent()

    private val policy = PrivacyPolicyDocument(
        policy = policyText,
        revision = "example-revision",
        updatedAt = 1_782_000_000_000,
    )

    private val sharedExchange = PrivacyExchangePresentation(
        taskId = "task-shared-example",
        conversationId = "conversation-example",
        workflowId = "workflow-example",
        externalAgent = externalAgent,
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
        ),
    )

    private val pendingExchange = PrivacyExchangePresentation(
        taskId = "task-pending-example",
        conversationId = "conversation-example",
        workflowId = "workflow-example",
        externalAgent = externalAgent,
        workflow = PrivacyExchangeWorkflow(
            "Prepare project update",
            "Prepare a concise update for an external project tracker.",
        ),
        question = "What is the next milestone?",
        status = "approval_required",
        outcome = "needs_review",
        createdAt = 1_782_000_000_000,
        pendingCandidate = "The next invented project review is scheduled for 14 September at 10:00.",
        approval = PrivacyExchangeApproval(
            id = "approval-example",
            status = "pending",
            expiresAt = 1_782_086_400_000,
        ),
        review = PrivacyExchangeReview(
            fallbackCause = "policy_requires_review",
            findings = findings,
            rationale = "The global policy requires approval before exact schedule details leave Omnesis.",
        ),
    )

    private val blockedExchange = PrivacyExchangePresentation(
        taskId = "task-blocked-example",
        conversationId = "conversation-example",
        workflowId = "workflow-other",
        externalAgent = externalAgent,
        workflow = PrivacyExchangeWorkflow("Account recovery", "Retrieve a recovery code."),
        question = "Can you share the recovery code for the invented account?",
        status = "denied",
        outcome = "not_shared",
        createdAt = 1_782_000_030_000,
        resolvedAt = 1_782_000_040_000,
        userDecision = "approved_but_blocked",
        review = PrivacyExchangeReview(
            fallbackCause = "hard_stop",
            rationale = "A recovery code was detected in the candidate answer.",
        ),
        failure = PrivacyExchangeFailure(
            code = "credential_hard_stop",
            message = "The privacy boundary does not allow a credential to leave this machine.",
        ),
    )

    private val generationFailedExchange = PrivacyExchangePresentation(
        taskId = "task-generation-failed-example",
        conversationId = "conversation-example",
        workflowId = "workflow-example",
        externalAgent = externalAgent,
        workflow = PrivacyExchangeWorkflow("Prepare project update", "Prepare an invented update."),
        question = "What is the next fictional milestone?",
        status = "failed",
        outcome = "failed",
        createdAt = 1_782_000_030_000,
        resolvedAt = 1_782_000_040_000,
        failure = PrivacyExchangeFailure(
            code = "http_request_timeout",
            message = "The model did not respond within the request deadline.",
            stage = "answer_generation",
            detail = "HTTP 504 · GATEWAY_TIMEOUT · request req-example-0042",
        ),
    )

    private val reviewFailedExchange = generationFailedExchange.copy(
        taskId = "task-review-failed-example",
        draftAnswer = "The next fictional milestone is the September review.",
        review = PrivacyExchangeReview(
            fallbackCause = "request_failed",
            rationale = "The privacy reviewer did not return a decision.",
        ),
        failure = PrivacyExchangeFailure(
            code = "privacy_review_failed",
            message = "The privacy check could not complete.",
            stage = "privacy_check",
        ),
    )

    private val unattendedDraftExchange = PrivacyExchangePresentation(
        taskId = "task-unattended-example",
        conversationId = "conversation-example",
        workflowId = "workflow-example",
        externalAgent = externalAgent,
        workflow = PrivacyExchangeWorkflow(
            "Prepare venue update",
            "Prepare an invented venue update.",
        ),
        question = "When does the fictional venue desk close?",
        status = "denied",
        outcome = "not_shared",
        createdAt = 1_782_000_030_000,
        resolvedAt = 1_782_000_040_000,
        draftAnswer = "The fictional venue desk is open until 17:00.",
        denialReason = "approval_not_available",
        review = PrivacyExchangeReview(
            fallbackCause = "policy_requires_review",
            rationale = "The answer required approval before it could leave Omnesis.",
        ),
    )

    private val runningExchange = PrivacyExchangePresentation(
        taskId = "task-running-example",
        conversationId = "conversation-example",
        workflowId = "workflow-example",
        externalAgent = externalAgent,
        workflow = PrivacyExchangeWorkflow(
            "Prepare venue update",
            "Prepare an invented venue update.",
        ),
        question = "When does the fictional venue desk close?",
        status = "running",
        outcome = "checking",
        createdAt = 1_782_000_030_000,
    )

    private val watchRequest = PrivacySubscriptionApprovalSummary(
        id = "subscription-approval-example",
        subscriptionId = "subscription-example",
        workflowHandle = "workflow-example",
        integration = externalAgent,
        status = "pending",
        interpretedCondition = PrivacyInterpretedCondition(
            summary = "A new Studio Northstar update requests a decision",
        ),
        revisionId = "subscription-revision-example",
        revision = 1,
        createdAt = 1_782_000_000_000,
        expiresAt = 1_783_209_600_000,
    )

    private val conversation = PrivacyConversationDetail(
        id = "conversation-example",
        workflowId = "workflow-example",
        workflowName = "Prepare project update",
        workflowPurpose = "Prepare a concise update for an external project tracker.",
        externalAgent = externalAgent,
        title = "What changed in the Northstar project?",
        createdAt = 1_781_900_000_000,
        updatedAt = 1_782_000_000_000,
        taskCount = 2,
        latestStatus = "released_with_reductions",
        latestOutcome = "shared_with_reductions",
        workflowStatus = "active",
        workflowExpiresAt = 1_783_000_000_000,
    )

    private val events = listOf(
        PrivacyAuditEventSummary(
            id = "audit-request-example",
            taskId = "task-shared-example",
            kind = "external_request",
            createdAt = 1_781_999_000_000,
            display = PrivacyAuditEventDisplay(
                title = "External request",
                // Both paragraphs of this step are the caller's own words — the
                // question it asked and the purpose it stated for itself — so
                // the record has to quote each of them.
                text = "What changed in the Northstar project?",
                detail = "Prepare a concise update for an external project tracker.",
            ),
        ),
        PrivacyAuditEventSummary(
            id = "audit-candidate-example",
            taskId = "task-shared-example",
            kind = "candidate_generated",
            createdAt = 1_781_999_010_000,
            display = PrivacyAuditEventDisplay(
                title = "Answer drafted",
                provider = "example-provider",
                model = "agent-example-v1",
            ),
        ),
        PrivacyAuditEventSummary(
            id = "audit-review-example",
            taskId = "task-shared-example",
            kind = "privacy_review",
            createdAt = 1_781_999_020_000,
            display = PrivacyAuditEventDisplay(
                title = "Privacy review",
                text = "Exact schedule details were removed before release.",
                decodedStatus = PrivacyAuditStatusDisplay("reduced", "Details removed"),
                provider = "example-provider",
                model = "reviewer-example-v1",
                reductions = listOf("Exact day and time removed"),
            ),
        ),
        PrivacyAuditEventSummary(
            id = "audit-egress-example",
            taskId = "task-shared-example",
            kind = "egress",
            createdAt = 1_781_999_025_000,
            display = PrivacyAuditEventDisplay(
                title = "Left this machine",
                decodedStatus = PrivacyAuditStatusDisplay("allowed", "Shared"),
            ),
        ),
    )

    private val unattendedEvents = listOf(
        PrivacyAuditEventSummary(
            id = "audit-unattended-request-example",
            taskId = unattendedDraftExchange.taskId,
            kind = "external_request",
            createdAt = unattendedDraftExchange.createdAt,
            display = PrivacyAuditEventDisplay(
                title = "External request",
                text = unattendedDraftExchange.question,
                detail = unattendedDraftExchange.workflow.purpose,
            ),
        ),
        PrivacyAuditEventSummary(
            id = "audit-unattended-candidate-example",
            taskId = unattendedDraftExchange.taskId,
            kind = "candidate_generated",
            createdAt = 1_782_000_035_000,
            display = PrivacyAuditEventDisplay(
                title = "Answer drafted",
                provider = "example-provider",
                model = "agent-example-v1",
            ),
        ),
        PrivacyAuditEventSummary(
            id = "audit-unattended-review-example",
            taskId = unattendedDraftExchange.taskId,
            kind = "privacy_review",
            createdAt = unattendedDraftExchange.resolvedAt ?: 1_782_000_040_000,
            display = PrivacyAuditEventDisplay(
                title = "Privacy review",
                text = unattendedDraftExchange.review?.rationale,
                decodedStatus = PrivacyAuditStatusDisplay("held", "Approval required"),
                provider = "example-provider",
                model = "reviewer-example-v1",
            ),
        ),
    )

    /**
     * The released answer as an edit of the draft, in the shape the gateway
     * emits: a change block lists every removed line before its added
     * counterparts, and only a line matched to one carries spans. The block
     * covers a line rewritten in place, a change to whitespace alone, and a line
     * struck with no counterpart at all.
     */
    private val answerDiff = PrivacyAnswerComparisonWire(
        kind = "diff",
        lines = listOf(
            PrivacyAnswerDiffLineWire(op = "equal", text = "The Northstar review is confirmed."),
            PrivacyAnswerDiffLineWire(
                op = "removed",
                text = "It starts on 14 September at 10:00 in the Riverside room.",
                spans = listOf(
                    PrivacyAnswerDiffSpanWire("equal", "It starts"),
                    PrivacyAnswerDiffSpanWire("removed", " on 14"),
                    PrivacyAnswerDiffSpanWire("equal", " September"),
                    PrivacyAnswerDiffSpanWire("removed", " at 10:00 in the Riverside room"),
                    PrivacyAnswerDiffSpanWire("equal", "."),
                ),
            ),
            PrivacyAnswerDiffLineWire(
                op = "removed",
                text = "Two  spaces before this one.",
                spans = listOf(
                    PrivacyAnswerDiffSpanWire("equal", "Two"),
                    PrivacyAnswerDiffSpanWire("removed", "  "),
                    PrivacyAnswerDiffSpanWire("equal", "spaces before this one."),
                ),
            ),
            PrivacyAnswerDiffLineWire(
                op = "removed",
                text = "Ask the team lead if you need the dial-in details for the room.",
            ),
            PrivacyAnswerDiffLineWire(
                op = "added",
                text = "It starts in September.",
                spans = listOf(
                    PrivacyAnswerDiffSpanWire("equal", "It starts"),
                    PrivacyAnswerDiffSpanWire("added", " in"),
                    PrivacyAnswerDiffSpanWire("equal", " September."),
                ),
            ),
            PrivacyAnswerDiffLineWire(
                op = "added",
                text = "Two spaces before this one.",
                spans = listOf(
                    PrivacyAnswerDiffSpanWire("equal", "Two"),
                    PrivacyAnswerDiffSpanWire("added", " "),
                    PrivacyAnswerDiffSpanWire("equal", "spaces before this one."),
                ),
            ),
        ),
    )

    private val releasedAnswer =
        "The Northstar review is confirmed. It starts in September."

    private fun releasedEvent(comparison: PrivacyAnswerComparisonWire, text: String?) =
        PrivacyAuditEventSummary(
            id = "audit-released-example",
            taskId = "task-shared-example",
            kind = "released",
            createdAt = 1_781_999_025_000,
            display = PrivacyAuditEventDisplay(
                title = "Left this machine",
                text = text,
                // An answer released byte-for-byte had nothing taken out of it,
                // so the step it sits on must not claim otherwise.
                decodedStatus = if (comparison.kind == "identical") {
                    PrivacyAuditStatusDisplay("allowed", "Shared")
                } else {
                    PrivacyAuditStatusDisplay("reduced", "Details removed")
                },
            ),
            decodedAnswerComparison = comparison,
        )

    private val approvalDetail = PrivacyApprovalDetail(
        id = "approval-example",
        taskId = "task-pending-example",
        workflowId = "workflow-example",
        conversationId = "conversation-example",
        workflowName = "Prepare project update",
        externalAgent = externalAgent,
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
        ),
    )

    /* ── Watches fixtures (unchanged surface) ── */

    private val subscriptionCondition = PrivacySubscriptionCondition(
        description = "a Studio Northstar update that requests a decision",
    )
    private val subscriptionReaction = PrivacySubscriptionReaction(
        instruction = "Review the update, decide whether follow-up is required, and draft a response if useful.",
    )
    private val subscriptionApprovalDetail = PrivacySubscriptionApprovalDetail(
        id = watchRequest.id,
        subscriptionId = watchRequest.subscriptionId,
        workflowHandle = watchRequest.workflowHandle,
        integration = externalAgent,
        status = "pending",
        interpretedCondition = watchRequest.interpretedCondition,
        interpretation = watchRequest.interpretedCondition,
        workflowId = "workflow-example",
        integrationDeviceId = "integration-device-example",
        integrationDevice = PrivacySubscriptionIntegrationDevice(
            id = "integration-device-example",
            name = "Fictional OpenClaw integration",
            kind = "agent",
        ),
        workflow = PrivacySubscriptionWorkflow(
            id = "workflow-example",
            name = "Studio Northstar review",
            purpose = "Review fictional project updates",
        ),
        revisionId = "subscription-revision-example",
        revision = 1,
        createdAt = 1_782_000_000_000,
        expiresAt = 1_783_209_600_000,
        condition = subscriptionCondition,
        reaction = subscriptionReaction,
        categories = listOf("private communication"),
        policyRevision = "policy-revision-example",
    )
    private fun capture(
        name: String,
        dark: Boolean,
        fontScale: Float = 1f,
        content: @Composable () -> Unit,
    ) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            val density = LocalDensity.current
            CompositionLocalProvider(
                LocalInspectionMode provides true,
                LocalDensity provides Density(density.density, fontScale),
            ) {
                OmnesisTheme(darkTheme = dark, content = content)
            }
        }
    }

    /* ── Activity ── */

    @Test
    fun privacy_activity_light() = capture("privacy_activity_light", false) { activityContent() }

    @Test
    fun privacy_activity_dark() = capture("privacy_activity_dark", true) { activityContent() }

    @Test
    fun privacy_activity_feed_light() = capture("privacy_activity_feed_light", false) { feedContent() }

    @Test
    fun privacy_activity_feed_dark() = capture("privacy_activity_feed_dark", true) { feedContent() }

    @Test
    fun privacy_activity_empty_light() = capture("privacy_activity_empty_light", false) { emptyContent() }

    @Test
    fun privacy_activity_empty_dark() = capture("privacy_activity_empty_dark", true) { emptyContent() }

    @Test
    fun privacy_activity_failed_filter_light() =
        capture("privacy_activity_failed_filter_light", false) { failedFilterContent() }

    @Test
    fun privacy_activity_failed_filter_dark() =
        capture("privacy_activity_failed_filter_dark", true) { failedFilterContent() }

    @Test
    fun privacy_activity_no_match_light() =
        capture("privacy_activity_no_match_light", false) { noMatchContent() }

    @Test
    fun privacy_activity_no_match_dark() =
        capture("privacy_activity_no_match_dark", true) { noMatchContent() }

    /* ── The spine ── */

    @Test
    fun privacy_spine_shared_light() = capture("privacy_spine_shared_light", false) { spine(sharedExchange) }

    @Test
    fun privacy_spine_shared_dark() = capture("privacy_spine_shared_dark", true) { spine(sharedExchange) }

    @Test
    fun privacy_spine_oauth_principal_long_labels_light() =
        capture("privacy_spine_oauth_principal_long_labels_light", false) {
            spine(
                sharedExchange.copy(
                    externalAgent = PrivacyExternalAgentIdentity(
                        displayName = "Research planning and coordination assistant",
                        narrativeName = "Research planning assistant",
                        connectionName = "Shared studio planning workstation connection",
                        source = "principal",
                    ),
                ),
            )
        }

    @Test
    fun privacy_spine_pending_light() = capture("privacy_spine_pending_light", false) { spine(pendingExchange) }

    @Test
    fun privacy_spine_pending_dark() = capture("privacy_spine_pending_dark", true) { spine(pendingExchange) }

    @Test
    fun privacy_spine_blocked_light() = capture("privacy_spine_blocked_light", false) { spine(blockedExchange) }

    @Test
    fun privacy_spine_blocked_dark() = capture("privacy_spine_blocked_dark", true) { spine(blockedExchange) }

    @Test
    fun privacy_spine_generation_failed_light() =
        capture("privacy_spine_generation_failed_light", false) {
            spine(generationFailedExchange, events = emptyList())
        }

    @Test
    fun privacy_spine_generation_failed_dark() =
        capture("privacy_spine_generation_failed_dark", true) {
            spine(generationFailedExchange, events = emptyList())
        }

    @Test
    fun privacy_spine_review_failed_light() =
        capture("privacy_spine_review_failed_light", false) { spine(reviewFailedExchange) }

    @Test
    fun privacy_spine_review_failed_dark() =
        capture("privacy_spine_review_failed_dark", true) { spine(reviewFailedExchange) }

    @Test
    fun privacy_spine_unattended_draft_light() =
        capture("privacy_spine_unattended_draft_light", false) {
            spine(unattendedDraftExchange, events = unattendedEvents)
        }

    @Test
    fun privacy_spine_unattended_draft_dark() =
        capture("privacy_spine_unattended_draft_dark", true) {
            spine(unattendedDraftExchange, events = unattendedEvents)
        }

    @Test
    fun privacy_spine_drafting_light() =
        capture("privacy_spine_drafting_light", false) { spine(runningExchange, events = emptyList()) }

    @Test
    fun privacy_spine_drafting_dark() =
        capture("privacy_spine_drafting_dark", true) { spine(runningExchange, events = emptyList()) }

    /* ── The released answer, compared with the draft ── */

    @Test
    fun privacy_record_answer_diff_light() =
        capture("privacy_record_answer_diff_light", false) { record(answerDiff, releasedAnswer) }

    @Test
    fun privacy_record_answer_diff_dark() =
        capture("privacy_record_answer_diff_dark", true) { record(answerDiff, releasedAnswer) }

    @Test
    fun privacy_record_answer_identical_light() =
        capture("privacy_record_answer_identical_light", false) {
            // The gateway leaves this step no body of its own, so the record
            // states the release rather than repeating the draft.
            record(PrivacyAnswerComparisonWire(kind = "identical"), null)
        }

    @Test
    fun privacy_record_answer_identical_dark() =
        capture("privacy_record_answer_identical_dark", true) {
            record(PrivacyAnswerComparisonWire(kind = "identical"), null)
        }

    @Test
    fun privacy_record_answer_dissimilar_light() =
        capture("privacy_record_answer_dissimilar_light", false) {
            record(PrivacyAnswerComparisonWire(kind = "no_diff", reason = "dissimilar"), releasedAnswer)
        }

    @Test
    fun privacy_record_answer_dissimilar_dark() =
        capture("privacy_record_answer_dissimilar_dark", true) {
            record(PrivacyAnswerComparisonWire(kind = "no_diff", reason = "dissimilar"), releasedAnswer)
        }

    @Test
    fun privacy_record_answer_too_large_light() =
        capture("privacy_record_answer_too_large_light", false) {
            record(PrivacyAnswerComparisonWire(kind = "no_diff", reason = "too_large"), releasedAnswer)
        }

    @Test
    fun privacy_record_answer_too_large_dark() =
        capture("privacy_record_answer_too_large_dark", true) {
            record(PrivacyAnswerComparisonWire(kind = "no_diff", reason = "too_large"), releasedAnswer)
        }

    /* ── Prose against quotation ── */

    @Test
    fun privacy_quotes_light() = capture("privacy_quotes_light", false) { quoteGallery() }

    @Test
    fun privacy_quotes_dark() = capture("privacy_quotes_dark", true) { quoteGallery() }

    @Test
    fun privacy_quotes_large_text_light() =
        capture("privacy_quotes_large_text_light", false, fontScale = 1.5f) { quoteGallery() }

    @Test
    fun privacy_quotes_large_text_dark() =
        capture("privacy_quotes_large_text_dark", true, fontScale = 1.5f) { quoteGallery() }

    /** A held answer and the request that drew it, at a reader's larger text setting. */
    @Test
    fun privacy_approval_review_large_text_light() =
        capture("privacy_approval_review_large_text_light", false, fontScale = 1.5f) {
            approvalContent()
        }

    /* ── Policy ── */

    @Test
    fun privacy_policy_light() = capture("privacy_policy_light", false) { policyContent() }

    @Test
    fun privacy_policy_dark() = capture("privacy_policy_dark", true) { policyContent() }

    /* ── One approval, opened by id ── */

    @Test
    fun privacy_approval_review_light() = capture("privacy_approval_review_light", false) { approvalContent() }

    @Test
    fun privacy_approval_review_dark() = capture("privacy_approval_review_dark", true) { approvalContent() }

    @Test
    fun privacy_approval_unavailable_candidate_light() =
        capture("privacy_approval_unavailable_candidate_light", false) {
            approvalContent(approvalDetail.copy(candidateAnswer = null))
        }

    @Test
    fun privacy_approval_unavailable_candidate_dark() =
        capture("privacy_approval_unavailable_candidate_dark", true) {
            approvalContent(approvalDetail.copy(candidateAnswer = null))
        }

    @Test
    fun privacy_approval_decided_light() =
        capture("privacy_approval_decided_light", false) {
            approvalContent(approvalDetail.copy(status = "approved", resolvedAt = 1_782_000_040_000))
        }

    @Test
    fun privacy_approval_decided_dark() =
        capture("privacy_approval_decided_dark", true) {
            approvalContent(approvalDetail.copy(status = "approved", resolvedAt = 1_782_000_040_000))
        }

    /* ── Watches ── */

    @Test
    fun privacy_subscription_approval_light() = capture("privacy_subscription_approval_light", false) {
        subscriptionApprovalContent()
    }

    @Test
    fun privacy_subscription_approval_dark() = capture("privacy_subscription_approval_dark", true) {
        subscriptionApprovalContent()
    }

    @Test
    fun privacy_subscription_revision_light() = capture("privacy_subscription_revision_light", false) {
        subscriptionApprovalContent(
            PrivacySubscriptionApprovalUiState(
                loading = false,
                detail = subscriptionApprovalDetail.copy(revision = 2),
            ),
        )
    }

    @Test
    fun privacy_subscription_revision_dark() = capture("privacy_subscription_revision_dark", true) {
        subscriptionApprovalContent(
            PrivacySubscriptionApprovalUiState(
                loading = false,
                detail = subscriptionApprovalDetail.copy(revision = 2),
            ),
        )
    }

    /* ── Content builders ── */

    @Composable
    private fun privacy(
        state: PrivacyUiState,
        filter: PrivacyFeedFilter = PrivacyFeedFilter.ALL,
        directState: DirectAuditUiState = DirectAuditUiState(loading = false),
        tab: AuditTab = AuditTab.ANSWER,
    ) {
        PrivacyContent(
            state = state,
            onOpenMenu = {},
            onOpenExchange = { _, _ -> },
            onRetry = {},
            initialActivityFilter = filter,
            directState = directState,
            initialTab = tab,
        )
    }

    /** The landing screen as an operator meets it: one answer held, the rest a feed. */
    @Composable
    private fun activityContent() = privacy(
        PrivacyUiState(
            loading = false,
            exchanges = listOf(pendingExchange, blockedExchange, sharedExchange),
        ),
    )

    /** No pending decisions — the status filter, day axis, and quiet outcomes. */
    @Composable
    private fun feedContent() = privacy(
        PrivacyUiState(
            loading = false,
            exchanges = listOf(
                blockedExchange,
                generationFailedExchange,
                sharedExchange,
                sharedExchange.copy(
                    taskId = "task-second",
                    outcome = "shared",
                    createdAt = sharedExchange.createdAt - 86_400_000,
                    resolvedAt = sharedExchange.resolvedAt?.minus(86_400_000),
                    sharedAt = sharedExchange.sharedAt?.minus(86_400_000),
                ),
            ),
            subscriptionApprovals = listOf(watchRequest),
            subscriptionApprovalsTotalCount = 1,
            reviewerHealth = PrivacyReviewerHealth(
                status = "attention",
                recentOperationalFailureCount = 3,
                lastFailureAt = 1_782_000_000_000,
            ),
        ),
    )

    @Composable
    private fun emptyContent() = privacy(
        PrivacyUiState(
            loading = false,
        ),
    )

    @Composable
    private fun failedFilterContent() = privacy(
        state = PrivacyUiState(
            loading = false,
            exchanges = listOf(generationFailedExchange, sharedExchange, blockedExchange),
        ),
        filter = PrivacyFeedFilter.FAILED,
    )

    @Composable
    private fun noMatchContent() = privacy(
        state = PrivacyUiState(
            loading = false,
            exchanges = listOf(sharedExchange),
        ),
        filter = PrivacyFeedFilter.FAILED,
    )

    @Composable
    private fun policyContent() = PrivacyPolicyContent(
        state = PrivacyPolicyUiState(loading = false, policy = policy),
        onBack = {},
    )

    @Composable
    private fun spine(
        exchange: PrivacyExchangePresentation,
        events: List<PrivacyAuditEventSummary> = this.events,
    ) {
        PrivacyExchangeDetailContent(
            state = PrivacyExchangeDetailUiState(
                loading = false,
                conversation = conversation,
                exchanges = listOf(exchange),
                events = events.map { it.copy(taskId = exchange.taskId) },
                exchangePaging = CursorPagingState(),
            ),
            shown = listOf(exchange),
            onBack = {},
            onRetry = {},
        )
    }

    /**
     * The comparison where an operator meets it: on the spine, under the
     * release step it belongs to.
     */
    @Composable
    private fun record(comparison: PrivacyAnswerComparisonWire, releasedText: String?) {
        Box(
            Modifier
                .fillMaxSize()
                .background(OmTheme.colors.bgPrimary)
                .padding(OmSpacing.md),
        ) {
            PrivacyExchangeSpine(
                exchange = sharedExchange,
                // The release step is the one that carries the comparison, so
                // it stands in for the ledger's plain egress step here.
                events = events.filterNot { it.kind == "egress" } + releasedEvent(comparison, releasedText),
            )
        }
    }

    /**
     * Prose against quotation, side by side, with every kind of quoted text
     * these screens show. This is where the contrast between the two is judged:
     * the quote surface has to lift a quotation off the page without turning a
     * column of them into a column of boxes, and the typewriter face has to say
     * "recording" while staying quieter than the prose above it.
     */
    @Composable
    private fun quoteGallery() {
        val c = OmTheme.colors
        Column(
            Modifier
                .fillMaxWidth()
                .background(c.bgPrimary)
                .padding(OmSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        ) {
            galleryLabel("Prose Omnesis wrote")
            Text(
                "Omnesis removed details from this answer, then the external agent received the rest.",
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                color = c.textPrimary,
            )
            galleryLabel("The request, quoted")
            PrivacyQuote(
                "What changed in the Northstar project?",
                role = "question",
                style = MaterialTheme.typography.bodyLarge,
            )
            galleryLabel("The reviewer's summary, quoted")
            PrivacyQuote(
                "The schedule summary is allowed, but the exact location requires approval.",
                role = "privacy check summary",
                style = MaterialTheme.typography.bodySmall,
            )
            galleryLabel("The draft, quoted")
            PrivacyAnswerBlock(
                galleryDraft,
                role = "draft answer",
                style = MaterialTheme.typography.bodyMedium,
            )
            galleryLabel("An answer held pending a decision")
            PrivacyAnswerBlock(
                "The next Northstar review is in September.",
                role = "held answer",
                style = MaterialTheme.typography.bodyMedium,
                tint = privacyHeldAnswerTint(),
            )
        }
    }

    /** A draft carrying a heading and a list, so both take the quotation's face. */
    private val galleryDraft = """
        ## Northstar status

        The review is confirmed for September.

        - Scope agreed with the fictional design group
        - Budget still open
    """.trimIndent()

    @Composable
    private fun galleryLabel(text: String) = Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall.copy(
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
        ),
        color = OmTheme.colors.textMuted,
    )

    @Composable
    private fun approvalContent(detail: PrivacyApprovalDetail = approvalDetail) {
        PrivacyApprovalContent(
            state = PrivacyApprovalUiState(loading = false, detail = detail),
            onBack = {},
            onRetry = {},
        )
    }

    @Composable
    private fun subscriptionApprovalContent(
        state: PrivacySubscriptionApprovalUiState = PrivacySubscriptionApprovalUiState(
            loading = false,
            detail = subscriptionApprovalDetail,
        ),
    ) {
        PrivacySubscriptionApprovalContent(
            state = state,
            onBack = {},
            onRetry = {},
            onApprove = {},
            onDeny = {},
        )
    }

    /* ── Direct transcript fixtures (invented; never sourced from a real corpus) ── */

    private val directSessions = listOf(
        DirectAuditSession(
            id = "direct_session_two",
            ownerId = "owner_example",
            principalId = "principal_example",
            principalName = "Atlas",
            credentialId = "credential_example",
            grantId = "grant_example",
            explicitKey = "conversation:conversation_example",
            heuristicKey = "principal_example|credential_example",
            createdAt = 1_782_000_000_000,
            lastEventAt = 1_782_000_000_000,
            eventCount = 4,
        ),
        DirectAuditSession(
            id = "direct_session_one",
            ownerId = "owner_example",
            principalId = "principal_example",
            principalName = null,
            credentialId = "credential_example",
            grantId = "grant_example",
            explicitKey = null,
            heuristicKey = "principal_example|credential_example",
            createdAt = 1_781_999_000_000,
            lastEventAt = 1_781_999_000_000,
            eventCount = 1,
        ),
    )

    private val directEvents = listOf(
        DirectAuditEvent(
            sequence = 1,
            id = "directevent_one",
            sessionId = "direct_session_two",
            tool = "search_many",
            outcome = "ok",
            requestId = "request_example",
            display = DirectAuditEventDisplay(title = "search_many"),
            payloadTruncated = false,
            payloadBytes = 812,
            originalPayloadBytes = 812,
            createdAt = 1_782_000_000_000,
        ),
        DirectAuditEvent(
            sequence = 2,
            id = "directevent_two",
            sessionId = "direct_session_two",
            tool = "lookup_people",
            outcome = "ok",
            requestId = "request_example_two",
            display = DirectAuditEventDisplay(title = "lookup_people"),
            payloadTruncated = false,
            payloadBytes = 640,
            originalPayloadBytes = 640,
            createdAt = 1_782_000_005_000,
        ),
        DirectAuditEvent(
            sequence = 3,
            id = "directevent_three",
            sessionId = "direct_session_two",
            tool = "fetch_many",
            outcome = "refused",
            requestId = "request_example_three",
            display = DirectAuditEventDisplay(title = "fetch_many"),
            payloadTruncated = false,
            payloadBytes = 96,
            originalPayloadBytes = 96,
            createdAt = 1_782_000_010_000,
        ),
        DirectAuditEvent(
            sequence = 4,
            id = "directevent_four",
            sessionId = "direct_session_two",
            tool = "run_sql",
            outcome = "failed",
            requestId = "request_example_four",
            display = DirectAuditEventDisplay(title = "run_sql"),
            payloadTruncated = false,
            payloadBytes = 420,
            originalPayloadBytes = 420,
            createdAt = 1_782_000_015_000,
        ),
    )

    private fun directDocRef(id: String, title: String) = buildJsonObject {
        put("documentId", JsonPrimitive(id))
        put("sourceType", JsonPrimitive("email"))
        put("sourceId", JsonPrimitive("gmail"))
        put("title", JsonPrimitive(title))
    }

    private val directSearchPayload = buildJsonObject {
        put("tool", JsonPrimitive("search_many"))
        put(
            "args",
            buildJsonObject {
                put(
                    "queries",
                    buildJsonArray {
                        add(buildJsonObject { put("query", JsonPrimitive("marathon training plan")) })
                    },
                )
            },
        )
        put(
            "result",
            buildJsonObject {
                put("kind", JsonPrimitive("search.batch"))
                put(
                    "items",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("kind", JsonPrimitive("search.results"))
                                put("query", JsonPrimitive("marathon training plan"))
                                put(
                                    "results",
                                    buildJsonArray {
                                        add(directDocRef("doc_example_spring", "Spring training notes"))
                                        add(directDocRef("doc_example_venue", "Venue plan from Stellar Sound"))
                                    },
                                )
                            },
                        )
                    },
                )
            },
        )
        put("outcome", JsonPrimitive("ok"))
    }

    private val directPeoplePayload = buildJsonObject {
        put("tool", JsonPrimitive("lookup_people"))
        put("args", buildJsonObject { put("name", JsonPrimitive("Maya Reeves")) })
        put(
            "result",
            buildJsonObject {
                put("kind", JsonPrimitive("person.results"))
                put("query", JsonPrimitive("Maya Reeves"))
                put(
                    "results",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("canonicalId", JsonPrimitive("person_example_maya"))
                                put("displayName", JsonPrimitive("Maya Reeves"))
                                put(
                                    "aliases",
                                    buildJsonArray { add(JsonPrimitive("maya.reeves@example.com")) },
                                )
                            },
                        )
                    },
                )
            },
        )
        put("outcome", JsonPrimitive("ok"))
    }

    private val directRefusedPayload = buildJsonObject {
        put("tool", JsonPrimitive("fetch_many"))
        put(
            "args",
            buildJsonObject {
                put(
                    "documents",
                    buildJsonArray {
                        add(buildJsonObject { put("documentId", JsonPrimitive("doc_example_spring")) })
                    },
                )
            },
        )
        put("outcome", JsonPrimitive("refused"))
    }

    private val directErrorPayload = buildJsonObject {
        put("tool", JsonPrimitive("run_sql"))
        put("args", buildJsonObject { put("sql", JsonPrimitive("SELECT title FROM documents")) })
        put(
            "result",
            buildJsonObject {
                put("kind", JsonPrimitive("error"))
                put("code", JsonPrimitive("SQL_BINDER_ERROR"))
                put(
                    "message",
                    JsonPrimitive("Binder error at line 1\nHINT: no such column: venue_name"),
                )
            },
        )
        put("outcome", JsonPrimitive("failed"))
    }

    /* ── Answer agent-trace fixtures (invented; never sourced from a real corpus) ── */

    private fun traceAssistantMessage(vararg parts: JsonElement) = buildJsonObject {
        put("role", JsonPrimitive("assistant"))
        put("parts", buildJsonArray { parts.forEach { add(it) } })
    }

    private fun tracePartToolUse(id: String, tool: String, args: JsonElement) = buildJsonObject {
        put("kind", JsonPrimitive("tool_use"))
        put("toolCallId", JsonPrimitive(id))
        put("tool", JsonPrimitive(tool))
        put("args", args)
    }

    private fun tracePartToolResult(id: String, result: JsonElement) = buildJsonObject {
        put("kind", JsonPrimitive("tool_result"))
        put("toolCallId", JsonPrimitive(id))
        put("result", result)
    }

    private val tracedExchange = sharedExchange.copy(
        agentTraces = listOf(
            PrivacyAnswerAgentTrace(
                attempt = 1,
                provider = "example-provider",
                model = "example-model",
                sessionId = "session_example_one",
                messages = listOf(
                    traceAssistantMessage(
                        tracePartToolUse(
                            "call_example_one",
                            "search_many",
                            buildJsonObject {
                                put(
                                    "queries",
                                    buildJsonArray {
                                        add(
                                            buildJsonObject {
                                                put("query", JsonPrimitive("marathon training plan"))
                                            },
                                        )
                                    },
                                )
                            },
                        ),
                        tracePartToolResult(
                            "call_example_one",
                            buildJsonObject {
                                put("kind", JsonPrimitive("search.batch"))
                                put(
                                    "items",
                                    buildJsonArray {
                                        add(
                                            buildJsonObject {
                                                put("kind", JsonPrimitive("search.results"))
                                                put("query", JsonPrimitive("marathon training plan"))
                                                put(
                                                    "results",
                                                    buildJsonArray {
                                                        add(
                                                            directDocRef(
                                                                "doc_example_spring",
                                                                "Spring training notes",
                                                            ),
                                                        )
                                                    },
                                                )
                                            },
                                        )
                                    },
                                )
                            },
                        ),
                    ),
                ),
                createdAt = 1_781_999_010_000,
            ),
            PrivacyAnswerAgentTrace(
                attempt = 2,
                provider = "example-provider",
                model = "example-model",
                sessionId = "session_example_two",
                messages = listOf(
                    traceAssistantMessage(
                        tracePartToolUse(
                            "call_example_two",
                            "lookup_people",
                            buildJsonObject { put("name", JsonPrimitive("Maya Reeves")) },
                        ),
                    ),
                ),
                terminalStopReason = "context_window_exceeded",
                createdAt = 1_781_999_015_000,
                truncated = true,
                omittedParts = 2,
            ),
        ),
        agentTraceOmittedAttempts = 1,
    )

    @Composable
    private fun directContent(state: DirectAuditUiState = DirectAuditUiState(loading = false)) {
        privacy(
            state = PrivacyUiState(loading = false),
            directState = state,
            tab = AuditTab.DIRECT,
        )
    }

    @Composable
    private fun directDetailContent(state: DirectAuditDetailUiState) {
        DirectAuditDetailContent(
            state = state,
            onBack = {},
            onRetry = {},
        )
    }

    @Test
    fun privacy_audit_direct_light() = capture("privacy_audit_direct_light", false) {
        directContent(DirectAuditUiState(loading = false, sessions = directSessions))
    }

    @Test
    fun privacy_audit_direct_dark() = capture("privacy_audit_direct_dark", true) {
        directContent(DirectAuditUiState(loading = false, sessions = directSessions))
    }

    @Test
    fun privacy_audit_direct_empty_light() = capture("privacy_audit_direct_empty_light", false) {
        directContent(DirectAuditUiState(loading = false))
    }

    @Test
    fun privacy_audit_direct_empty_dark() = capture("privacy_audit_direct_empty_dark", true) {
        directContent(DirectAuditUiState(loading = false))
    }

    @Test
    fun privacy_audit_direct_unsupported_light() = capture("privacy_audit_direct_unsupported_light", false) {
        directContent(DirectAuditUiState(loading = false, unavailable = true))
    }

    @Test
    fun privacy_audit_direct_unsupported_dark() = capture("privacy_audit_direct_unsupported_dark", true) {
        directContent(DirectAuditUiState(loading = false, unavailable = true))
    }

    @Test
    fun privacy_audit_direct_detail_light() = capture("privacy_audit_direct_detail_light", false) {
        directDetailContent(
            DirectAuditDetailUiState(
                loading = false,
                session = directSessions[0],
                events = directEvents,
                payloads = mapOf(
                    "directevent_one" to directSearchPayload,
                    "directevent_two" to directPeoplePayload,
                    "directevent_three" to directRefusedPayload,
                    "directevent_four" to directErrorPayload,
                ),
            ),
        )
    }

    @Test
    fun privacy_audit_direct_detail_dark() = capture("privacy_audit_direct_detail_dark", true) {
        directDetailContent(
            DirectAuditDetailUiState(
                loading = false,
                session = directSessions[0],
                events = directEvents,
                payloads = mapOf(
                    "directevent_one" to directSearchPayload,
                    "directevent_two" to directPeoplePayload,
                    "directevent_three" to directRefusedPayload,
                    "directevent_four" to directErrorPayload,
                ),
            ),
        )
    }

    @Test
    fun privacy_answer_transcripts_light() = capture("privacy_answer_transcripts_light", false) {
        PrivacyAgentTranscripts(
            traces = tracedExchange.agentTraces,
            omittedAttempts = 0,
        )
    }

    @Test
    fun privacy_answer_transcripts_dark() = capture("privacy_answer_transcripts_dark", true) {
        PrivacyAgentTranscripts(
            traces = tracedExchange.agentTraces,
            omittedAttempts = 0,
        )
    }

    @Test
    fun privacy_spine_traces_light() = capture("privacy_spine_traces_light", false) {
        spine(tracedExchange)
    }

    @Test
    fun privacy_spine_traces_dark() = capture("privacy_spine_traces_dark", true) {
        spine(tracedExchange)
    }

    @Test
    fun privacy_audit_raw_sheet_light() = capture("privacy_audit_raw_sheet_light", false) {
        AuditRawJsonSheet(
            title = "Search — raw JSON",
            jsonText = auditRawJsonText(directSearchPayload),
            onDismiss = {},
        )
    }

    @Test
    fun privacy_audit_direct_detail_error_light() = capture("privacy_audit_direct_detail_error_light", false) {
        directDetailContent(
            DirectAuditDetailUiState(
                loading = false,
                error = IllegalStateException("gateway is away"),
            ),
        )
    }

    @Test
    fun privacy_audit_direct_detail_error_dark() = capture("privacy_audit_direct_detail_error_dark", true) {
        directDetailContent(
            DirectAuditDetailUiState(
                loading = false,
                error = IllegalStateException("gateway is away"),
            ),
        )
    }
}
