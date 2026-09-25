// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Answer privacy administration DTOs. These mirror
 * `packages/types/src/privacy.ts`; unknown fields are ignored by [OmnesisJson]
 * so a newer gateway can extend the audit without breaking the app.
 */
@Serializable
data class PrivacyPolicyDocument(
    val policy: String = "",
    val revision: String = "",
    val updatedAt: Long? = null,
)

@Serializable
data class PrivacyApprovalDetail(
    val id: String = "",
    val taskId: String = "",
    val workflowId: String = "",
    val conversationId: String = "",
    val workflowName: String = "",
    val externalAgent: PrivacyExternalAgentIdentity = PrivacyExternalAgentIdentity(),
    val status: String = "",
    val createdAt: Long = 0,
    val expiresAt: Long = 0,
    val resolvedAt: Long? = null,
    val workflowPurpose: String = "",
    val question: String = "",
    val candidateAnswer: String? = null,
    val sharedAt: Long? = null,
    val review: PrivacyReviewRecord = PrivacyReviewRecord(),
)

@Serializable
data class PrivacyApprovalEnvelope(
    val approval: PrivacyApprovalDetail,
)

/**
 * One held approval as the queue lists it — the summary shape, without the
 * candidate answer and review record the detail route carries.
 */
@Serializable
data class PrivacyApprovalSummary(
    val id: String = "",
    val taskId: String = "",
    val workflowId: String = "",
    val conversationId: String = "",
    val workflowName: String = "",
    val externalAgent: PrivacyExternalAgentIdentity = PrivacyExternalAgentIdentity(),
    val status: String = "",
    val createdAt: Long = 0,
    val expiresAt: Long = 0,
    val resolvedAt: Long? = null,
)

/**
 * One page of the approval queue, newest first. `totalCount` is the exact number
 * of approvals in the requested status with expired rows already excluded, so a
 * count can be read from a single-row page instead of walking the cursor. It has
 * no default: a gateway that omits it fails to decode rather than reporting the
 * page size as the backlog.
 */
@Serializable
data class PrivacyApprovalsPage(
    val approvals: List<PrivacyApprovalSummary> = emptyList(),
    val nextCursor: String? = null,
    val totalCount: Int,
)

@Serializable
data class PrivacyReviewRecord(
    val recipeVersion: String = "",
    val provider: String? = null,
    val model: String? = null,
    val confidence: Double? = null,
    val policyRevision: String = "",
    val fallbackCause: String? = null,
    val findings: List<PrivacyFinding> = emptyList(),
    val rationale: String = "",
    /** The policy family the answer was judged under; absent on records written before families were recorded. */
    val policyFamilyId: String? = null,
    val policyFamilyName: String? = null,
)

@Serializable
data class PrivacyFinding(
    val category: String = "",
    val detailLevel: String = "",
    val subject: String = "",
    val disposition: String = "",
    val description: String = "",
)

/**
 * Public answer-boundary result returned after an approval is resolved. The
 * released answer itself is deliberately not carried here: the client already
 * shows the exact candidate it approved, and the audit ledger is where the
 * release is recorded.
 */
@Serializable
data class PrivacyApprovalResolution(
    val status: String = "",
    val workflowId: String = "",
    val conversationId: String = "",
    val taskId: String = "",
    val reason: String? = null,
)

/**
 * The closed set of audit statuses a ledger step may render. Audit rows persist
 * a raw producer token — a reviewer decision, or a model's terminal stop reason
 * drawn from an open string — so the gateway maps that token onto this pair and
 * drops anything outside it. An absent status renders nothing at all rather than
 * arriving on screen styled as if it meant something.
 */
@Serializable
data class PrivacyAuditStatusDisplay(
    val code: String = "",
    val label: String = "",
)

/** The four codes this client knows how to style. */
private val PRIVACY_AUDIT_STATUS_CODES = setOf("allowed", "reduced", "held", "blocked")

@Serializable
data class PrivacyAuditEventDisplay(
    val title: String = "",
    val text: String? = null,
    val detail: String? = null,
    @SerialName("status") private val decodedStatus: PrivacyAuditStatusDisplay? = null,
    val provider: String? = null,
    val model: String? = null,
    val reductions: List<String> = emptyList(),
) {
    /**
     * The step's status, or null when it is absent, carries a code outside the
     * closed set, or arrives with a blank label. Enforced here so no consumer
     * can reach a raw producer token by reading `status.code` or `status.label`.
     */
    val status: PrivacyAuditStatusDisplay?
        get() = decodedStatus?.takeIf {
            it.code in PRIVACY_AUDIT_STATUS_CODES && it.label.isNotBlank()
        }
}

/* ── The released answer, compared with the draft it came from ────────────── */

/**
 * Which of the two texts a run belongs to: [EQUAL] to both the draft and the
 * shared answer, [REMOVED] to the draft alone, [ADDED] to the shared answer
 * alone.
 */
enum class PrivacyAnswerDiffOp { EQUAL, REMOVED, ADDED }

/** A run of characters inside one compared line. */
data class PrivacyAnswerDiffSpan(val op: PrivacyAnswerDiffOp, val text: String)

/**
 * One line of the comparison, in reading order. `spans` describes the line as a
 * word-level edit of its counterpart on the other side; null means the line has
 * no counterpart and is rendered whole, never that it is unchanged.
 */
data class PrivacyAnswerDiffLine(
    val op: PrivacyAnswerDiffOp,
    val text: String,
    val spans: List<PrivacyAnswerDiffSpan>?,
)

/**
 * How the answer that left this machine relates to the draft it was released
 * from. Computed by the gateway from the two full recorded strings, so every
 * client shows one comparison rather than three implementations of one.
 *
 * Nothing here attributes a change to a reduction the privacy check named: the
 * lines describe two strings, not the check's reasoning. [NoDiff] says only that
 * Omnesis declined to present the change as an edit — never that the answer was
 * rewritten.
 */
sealed interface PrivacyAnswerComparison {
    /** The released bytes are the draft's bytes; the release step carries no body of its own. */
    data object Identical : PrivacyAnswerComparison

    data class Diff(val lines: List<PrivacyAnswerDiffLine>) : PrivacyAnswerComparison

    data class NoDiff(val reason: Reason) : PrivacyAnswerComparison {
        enum class Reason { DISSIMILAR, TOO_LARGE }
    }
}

@Serializable
data class PrivacyAnswerDiffSpanWire(
    val op: String = "",
    val text: String = "",
)

@Serializable
data class PrivacyAnswerDiffLineWire(
    val op: String = "",
    val text: String = "",
    val spans: List<PrivacyAnswerDiffSpanWire>? = null,
)

@Serializable
data class PrivacyAnswerComparisonWire(
    val kind: String = "",
    val lines: List<PrivacyAnswerDiffLineWire> = emptyList(),
    val reason: String? = null,
)

private fun diffOp(op: String): PrivacyAnswerDiffOp? = when (op) {
    "equal" -> PrivacyAnswerDiffOp.EQUAL
    "removed" -> PrivacyAnswerDiffOp.REMOVED
    "added" -> PrivacyAnswerDiffOp.ADDED
    else -> null
}

/**
 * The spans of one line, or null wherever they cannot be trusted to describe it:
 * a run whose op this client does not know, a run belonging to the side this
 * line is not on, or a set that does not concatenate back to `text`. In each
 * case the line still renders whole from `text`, which is the recorded content.
 */
private fun PrivacyAnswerDiffLineWire.resolveSpans(
    lineOp: PrivacyAnswerDiffOp,
): List<PrivacyAnswerDiffSpan>? {
    val wire = spans ?: return null
    val resolved = wire.map { span ->
        PrivacyAnswerDiffSpan(diffOp(span.op) ?: return null, span.text)
    }
    if (resolved.any { it.op != PrivacyAnswerDiffOp.EQUAL && it.op != lineOp }) return null
    if (resolved.joinToString("") { it.text } != text) return null
    return resolved.ifEmpty { null }
}

private fun PrivacyAnswerDiffLineWire.resolve(): PrivacyAnswerDiffLine? {
    val lineOp = diffOp(op) ?: return null
    return PrivacyAnswerDiffLine(lineOp, text, resolveSpans(lineOp))
}

/**
 * The comparison this client can state, or null when it cannot state one: an
 * unrecognised kind or reason, or a line whose op is unknown. A line is dropped
 * only by dropping the whole comparison, because a comparison missing lines
 * would be read as a complete account of what left the machine.
 */
private fun PrivacyAnswerComparisonWire.resolve(): PrivacyAnswerComparison? = when (kind) {
    "identical" -> PrivacyAnswerComparison.Identical
    "diff" -> resolveDiff()
    "no_diff" -> when (reason) {
        "dissimilar" -> PrivacyAnswerComparison.NoDiff(PrivacyAnswerComparison.NoDiff.Reason.DISSIMILAR)
        "too_large" -> PrivacyAnswerComparison.NoDiff(PrivacyAnswerComparison.NoDiff.Reason.TOO_LARGE)
        else -> null
    }
    else -> null
}

private fun PrivacyAnswerComparisonWire.resolveDiff(): PrivacyAnswerComparison? {
    if (lines.isEmpty()) return null
    return PrivacyAnswerComparison.Diff(lines.map { it.resolve() ?: return null })
}

@Serializable
data class PrivacyAuditEventSummary(
    val id: String = "",
    val taskId: String = "",
    val kind: String = "unknown",
    val createdAt: Long = 0,
    val display: PrivacyAuditEventDisplay = PrivacyAuditEventDisplay(),
    @SerialName("answerComparison")
    private val decodedAnswerComparison: PrivacyAnswerComparisonWire? = null,
) {
    /**
     * How this step's answer compares with the draft, or null when the gateway
     * computed none and whenever the wire shape is one this client cannot render
     * faithfully. Resolved here so no consumer can reach a raw wire token by
     * reading `kind` or `op` and styling it as if it meant something.
     */
    val answerComparison: PrivacyAnswerComparison?
        get() = decodedAnswerComparison?.resolve()
}

@Serializable
data class PrivacyConversationDetail(
    val id: String = "",
    val workflowId: String = "",
    val workflowName: String = "",
    val workflowPurpose: String = "",
    val externalAgent: PrivacyExternalAgentIdentity = PrivacyExternalAgentIdentity(),
    val title: String = "",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val taskCount: Int = 0,
    val latestStatus: String = "",
    val latestOutcome: String = "",
    val pendingApprovalCount: Int = 0,
    val workflowStatus: String = "",
    val workflowExpiresAt: Long = 0,
)

@Serializable
data class PrivacyConversationEnvelope(
    val conversation: PrivacyConversationDetail,
)

@Serializable
data class PrivacyExternalAgentIdentity(
    val displayName: String = "External agent",
    val source: String = "fallback",
    /** Gateway-authored short name for prose; absent on older gateways. */
    val narrativeName: String? = null,
    /** Known agent-integration harness, when the caller arrived through one. */
    val integrationSlug: String? = null,
    /** Operator-assigned OAuth credential label, when the caller is a principal. */
    val connectionName: String? = null,
)

@Serializable
data class PrivacyExchangeWorkflow(
    val name: String = "",
    val purpose: String = "",
)

@Serializable
data class PrivacyExchangeApproval(
    val id: String = "",
    val status: String = "",
    val expiresAt: Long = 0,
    val resolvedAt: Long? = null,
)

/**
 * The review record as an exchange carries it. The policy family the answer
 * was judged under is named by id and by the name it had at review time; both
 * are absent on records written before families were recorded.
 */
@Serializable
data class PrivacyExchangeReview(
    val fallbackCause: String? = null,
    val findings: List<PrivacyFinding> = emptyList(),
    val rationale: String = "",
    val policyFamilyId: String? = null,
    val policyFamilyName: String? = null,
)

/**
 * The reviewed, safe explanation of why Omnesis did not complete an exchange.
 * Supplied by the gateway rather than derived from an audit payload here, which
 * could carry private request context.
 */
@Serializable
data class PrivacyExchangeFailure(
    val code: String = "",
    val message: String = "",
    val stage: String? = null,
    /**
     * One vetted line of provider disposition behind the sentence — `HTTP 404 · NOT_FOUND ·
     * param=model`. Composed by the gateway (never by this client, which has no audit payload
     * to read) and absent from a gateway that predates it.
     */
    val detail: String? = null,
)

@Serializable
data class PrivacyExchangePresentation(
    val taskId: String = "",
    val conversationId: String = "",
    val workflowId: String = "",
    val externalAgent: PrivacyExternalAgentIdentity = PrivacyExternalAgentIdentity(),
    val workflow: PrivacyExchangeWorkflow = PrivacyExchangeWorkflow(),
    val question: String = "",
    val status: String = "",
    /**
     * Absent only from a payload this client could not fully read. "Checking"
     * is the honest reading of that: the exchange's fate is unknown here, and
     * announcing a definite failure would misreport it.
     */
    val outcome: String = "checking",
    val createdAt: Long = 0,
    val resolvedAt: Long? = null,
    val sharedAt: Long? = null,
    val sharedAnswer: String? = null,
    /** Local operator-visible draft; its presence does not imply external egress. */
    val draftAnswer: String? = null,
    val pendingCandidate: String? = null,
    val reductions: List<String> = emptyList(),
    val approval: PrivacyExchangeApproval? = null,
    val userDecision: String? = null,
    val denialReason: String? = null,
    val review: PrivacyExchangeReview? = null,
    val failure: PrivacyExchangeFailure? = null,
    /**
     * Local-only, bounded generation transcripts, oldest attempt first. Absent
     * (empty) on gateways from before the traces projection — no tool section,
     * no error.
     */
    val agentTraces: List<PrivacyAnswerAgentTrace> = emptyList(),
    /** Stored attempts omitted because of projection size/count/shape limits. */
    val agentTraceOmittedAttempts: Int = 0,
)

/**
 * One bounded local-generation attempt behind an exchange. Mirrors
 * `PrivacyAnswerAgentTrace` in `@omnesis/types/privacy`.
 *
 * Every field tolerates absence so an older or newer gateway never fails the
 * whole exchange decode. [messages] stays raw JSON: a part this client cannot
 * read is skipped when pairing tool calls, never fatal to the attempt.
 */
@Serializable
data class PrivacyAnswerAgentTrace(
    /** Original one-based ordinal, including attempts omitted from this view. */
    val attempt: Int = 0,
    val provider: String = "",
    val model: String = "",
    val sessionId: String = "",
    val messages: List<JsonElement> = emptyList(),
    val terminalStopReason: String? = null,
    val createdAt: Long = 0,
    /** True when projection limits omitted part of this stored attempt. */
    val truncated: Boolean = false,
    /** Exact number of omitted observable parts, when the audit marker records it. */
    val omittedParts: Int? = null,
)

/** One conversation's exchanges, oldest first, so a detail view reads top-down. */
@Serializable
data class PrivacyExchangePresentationPage(
    val exchanges: List<PrivacyExchangePresentation> = emptyList(),
    val previousCursor: String? = null,
)

/**
 * The Privacy landing feed: every exchange the owner has, newest first, across
 * all conversations. Flat because an exchange is the unit — grouping by
 * conversation collapses several exchanges into one row whose title, timestamp
 * and outcome each describe a different event.
 */
@Serializable
data class PrivacyExchangeFeedPage(
    val exchanges: List<PrivacyExchangePresentation> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class PrivacyReviewerHealth(
    val status: String = "ok",
    val recentOperationalFailureCount: Int = 0,
    val lastFailureAt: Long? = null,
)

@Serializable
data class PrivacyAuditEventPage(
    val events: List<PrivacyAuditEventSummary> = emptyList(),
    val previousCursor: String? = null,
)

@Serializable
data class PrivacySubscriptionCondition(
    val kind: String = "natural-language",
    val description: String = "",
)

@Serializable
data class PrivacySubscriptionReaction(
    val kind: String = "agent-workflow",
    val instruction: String = "",
)

@Serializable
data class PrivacyInterpretedCondition(
    val summary: String = "",
    val pushDetail: String = "existence",
)

@Serializable
data class PrivacySubscriptionIntegrationDevice(
    val id: String,
    val name: String,
    val kind: String,
)

@Serializable
data class PrivacySubscriptionWorkflow(
    val id: String,
    val name: String,
    val purpose: String,
)

@Serializable
data class PrivacySubscriptionApprovalSummary(
    val id: String = "",
    val subscriptionId: String = "",
    val workflowHandle: String = "",
    val integration: PrivacyExternalAgentIdentity = PrivacyExternalAgentIdentity(),
    val status: String = "pending",
    val interpretedCondition: PrivacyInterpretedCondition = PrivacyInterpretedCondition(),
    val revisionId: String = "",
    val revision: Int = 0,
    val createdAt: Long = 0,
    val expiresAt: Long = 0,
    val resolvedAt: Long? = null,
)

@Serializable
data class PrivacySubscriptionApprovalDetail(
    val id: String,
    val subscriptionId: String,
    val workflowHandle: String,
    val integration: PrivacyExternalAgentIdentity,
    val status: String,
    val interpretedCondition: PrivacyInterpretedCondition,
    val interpretation: PrivacyInterpretedCondition,
    val workflowId: String,
    val integrationDeviceId: String,
    val integrationDevice: PrivacySubscriptionIntegrationDevice,
    val workflow: PrivacySubscriptionWorkflow,
    val revisionId: String,
    val revision: Int,
    val createdAt: Long,
    val expiresAt: Long,
    val resolvedAt: Long? = null,
    val condition: PrivacySubscriptionCondition,
    val reaction: PrivacySubscriptionReaction,
    val categories: List<String>,
    val policyRevision: String,
)

@Serializable
data class PrivacySubscriptionApprovalsEnvelope(
    val approvals: List<PrivacySubscriptionApprovalSummary> = emptyList(),
    val nextCursor: String? = null,
    val totalCount: Int = approvals.size,
)

@Serializable
data class PrivacySubscriptionApprovalEnvelope(
    val approval: PrivacySubscriptionApprovalDetail,
)

@Serializable
data class PrivacySubscriptionDetail(
    val id: String = "",
    val workflowHandle: String = "",
    val integration: PrivacyExternalAgentIdentity = PrivacyExternalAgentIdentity(),
    val status: String = "",
    val interpretedCondition: PrivacyInterpretedCondition = PrivacyInterpretedCondition(),
    val revisionId: String = "",
    val revision: Int = 0,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val expiresAt: Long = 0,
    val revokedAt: Long? = null,
    val firingCount: Int = 0,
    val lastFiredAt: Long? = null,
    val condition: PrivacySubscriptionCondition = PrivacySubscriptionCondition(),
    val reaction: PrivacySubscriptionReaction = PrivacySubscriptionReaction(),
    val categories: List<String> = emptyList(),
    val policyRevision: String = "",
)

@Serializable
data class PrivacySubscriptionEnvelope(
    val subscription: PrivacySubscriptionDetail,
)

@Serializable
data class PrivacySubscriptionFiring(
    val id: String = "",
    val subscriptionId: String = "",
    val revisionId: String = "",
    val workflowHandle: String = "",
    val createdAt: Long = 0,
    val deliveryStatus: String = "",
    val acceptedAt: Long? = null,
    /**
     * The watch this disclosure came from, and its journal sequence. Together they are the join
     * back to the runtime's own record of the same firing, so one watch's history can be read as
     * a single list rather than two ledgers that never quite line up. Absent on a disclosure
     * recorded before the columns existed, or one that did not come from a watch.
     */
    val watchId: String? = null,
    val seq: Int? = null,
)

@Serializable
data class PrivacySubscriptionFiringPage(
    val firings: List<PrivacySubscriptionFiring> = emptyList(),
    val nextCursor: String? = null,
)

@Serializable
data class SubscriptionApprovalDecisionBody(
    val decision: String,
)

/* ── The Direct transcript boundary: raw corpus reads, grouped into sessions ── */

/**
 * One Direct transcript session, newest first. Direct rows are unreviewed
 * reads (never releases), so this shape carries no release vocabulary.
 * Mirrors `DirectAuditSession` in `packages/gateway/src/privacy/direct-audit.ts`.
 */
@Serializable
data class DirectAuditSession(
    val id: String = "",
    val ownerId: String = "",
    val principalId: String = "",
    /** Operator-approved display name, null when the principal row is gone. */
    val principalName: String? = null,
    val credentialId: String = "",
    val grantId: String = "",
    /** Caller grouping key, "conversation:<id>" or "workflow:<id>"; null when heuristically grouped. */
    val explicitKey: String? = null,
    val heuristicKey: String = "",
    val createdAt: Long = 0,
    val lastEventAt: Long = 0,
    val eventCount: Int = 0,
)

@Serializable
data class DirectAuditSessionsResponse(
    val sessions: List<DirectAuditSession> = emptyList(),
)

/**
 * The small display pair a transcript event carries inline. The bounded
 * arguments and result live behind the event route, not here.
 */
@Serializable
data class DirectAuditEventDisplay(
    val title: String = "",
    val text: String? = null,
)

/**
 * One tool call inside a session, oldest first. Mirrors `DirectAuditEvent`
 * in `packages/gateway/src/privacy/direct-audit.ts`.
 */
@Serializable
data class DirectAuditEvent(
    val sequence: Int = 0,
    val id: String = "",
    val sessionId: String = "",
    val tool: String = "",
    /** "ok" | "refused" | "cancelled" | "timed_out" | "failed". Read as a plain string. */
    val outcome: String = "",
    val requestId: String = "",
    val display: DirectAuditEventDisplay = DirectAuditEventDisplay(),
    val payloadTruncated: Boolean = false,
    val payloadBytes: Int = 0,
    val originalPayloadBytes: Int = 0,
    val createdAt: Long = 0,
)

@Serializable
data class DirectAuditSessionEventsResponse(
    val events: List<DirectAuditEvent> = emptyList(),
)

/**
 * One event with its bounded `{tool,args,result,outcome}` payload. The
 * payload is absent (null) when the record carries no result
 * (refused/failed calls) — callers read that as "No result recorded", never
 * a typed arm.
 */
@Serializable
data class DirectAuditEventDetail(
    val sequence: Int = 0,
    val id: String = "",
    val sessionId: String = "",
    val tool: String = "",
    val outcome: String = "",
    val requestId: String = "",
    val display: DirectAuditEventDisplay = DirectAuditEventDisplay(),
    val payloadTruncated: Boolean = false,
    val payloadBytes: Int = 0,
    val originalPayloadBytes: Int = 0,
    val createdAt: Long = 0,
    val payload: JsonElement? = null,
)

@Serializable
data class DirectAuditEventEnvelope(
    val event: DirectAuditEventDetail,
)
