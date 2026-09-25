// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Vocabulary shared by every Privacy surface: the closed status maps, the
// plain-language copy, and the grouping rules.
//
// Deliberately free of SwiftUI so the wording and the tone selection are unit
// testable in the sim-less logic lane. Views map `PrivacyTone` onto colours;
// nothing here knows what a colour is.

/// Outcome tones, split by the one question a reader scanning this screen is
/// asking: did an answer reach the caller? Two of these say yes, two say no,
/// and the rest have not reached an answer — which is what the view layer
/// paints, so that the answer is legible before the label is read.
enum PrivacyTone: Equatable, Sendable {
    /// Something left the machine.
    case released
    /// Something left, with detail removed first.
    case reduced
    /// Waiting on the owner.
    case review
    /// Nothing left, and nothing is pending.
    case kept
    /// Still in flight.
    case waiting
    /// Nothing left because something broke.
    case failed
}

struct PrivacyOutcomeDisplay: Equatable, Sendable {
    let tone: PrivacyTone
    let label: String
}

/// The closed set a feed row or spine may render. Anything else reads as
/// "Checking" rather than arriving on screen as a raw token.
func privacyOutcomeDisplay(_ outcome: PrivacyExchangeOutcome) -> PrivacyOutcomeDisplay {
    switch outcome {
    case .checking:
        PrivacyOutcomeDisplay(tone: .waiting, label: "Checking")
    case .needsReview:
        PrivacyOutcomeDisplay(tone: .review, label: "Needs your review")
    case .ready:
        PrivacyOutcomeDisplay(tone: .waiting, label: "Approved, waiting for agent")
    case .shared:
        PrivacyOutcomeDisplay(tone: .released, label: "Shared with the agent")
    case .sharedWithReductions:
        PrivacyOutcomeDisplay(tone: .reduced, label: "Shared with details removed")
    case .notShared:
        PrivacyOutcomeDisplay(tone: .kept, label: "Not shared")
    case .failed:
        PrivacyOutcomeDisplay(tone: .failed, label: "Nothing shared; check failed")
    case .canceled:
        PrivacyOutcomeDisplay(tone: .kept, label: "Canceled")
    case .unknown:
        PrivacyOutcomeDisplay(tone: .waiting, label: "Checking")
    }
}

func privacyExchangeOutcomeDisplay(_ exchange: PrivacyExchangePresentation) -> PrivacyOutcomeDisplay {
    let display = privacyOutcomeDisplay(exchange.outcome)
    let agentName = externalAgentRecipientName(exchange.externalAgent)
    switch exchange.outcome {
    case .ready:
        return PrivacyOutcomeDisplay(tone: display.tone, label: "Approved, waiting for \(agentName)")
    case .shared:
        return PrivacyOutcomeDisplay(tone: display.tone, label: "Shared with \(agentName)")
    case .sharedWithReductions:
        return PrivacyOutcomeDisplay(
            tone: display.tone,
            label: "Shared with \(agentName), with details removed"
        )
    case .failed:
        return PrivacyOutcomeDisplay(
            tone: .failed,
            label: privacyAnswerGenerationFailed(exchange)
                ? "Nothing shared; answer failed"
                : "Nothing shared; privacy check failed"
        )
    default:
        return display
    }
}

func privacyAuditStatusTone(_ code: PrivacyAuditStatusDisplay.Code) -> PrivacyTone {
    switch code {
    case .allowed: .released
    case .reduced: .reduced
    case .held: .review
    case .blocked: .kept
    }
}

// MARK: - The caller's name

/// The principal's complete recorded display name. The narrative uses the
/// server's shorter form when present, or derives one below for compatibility.
func externalAgentFullName(_ agent: PrivacyExternalAgent?) -> String {
    let name = agent?.displayName.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return name.isEmpty ? "External agent" : name
}

/// Some display names trail the registry slug used to connect — `Atlas
/// (openclaw)`. Only a bare lowercase token in trailing parentheses is treated
/// as a slug, so a principal genuinely named `Acme (support desk)` keeps every
/// word.
private let privacyAgentSlugSuffix = #"\s*\([a-z0-9][a-z0-9._\-]*\)$"#

/// The name the narrative uses. Which integration a principal arrived through
/// is implementation detail in a plain-language story — a reader needs "Atlas
/// asked". `externalAgentFullName` retains the complete recorded name.
func externalAgentNarrativeName(_ agent: PrivacyExternalAgent?) -> String {
    let serverName = agent?.narrativeName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !serverName.isEmpty { return serverName }
    let name = externalAgentFullName(agent)
    guard let range = name.range(of: privacyAgentSlugSuffix, options: .regularExpression) else {
        return name
    }
    let stripped = name
        .replacingCharacters(in: range, with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return stripped.isEmpty ? name : stripped
}

/// A concrete recipient in a sentence, with a grammatical fallback for old or
/// orphaned records.
func externalAgentRecipientName(_ agent: PrivacyExternalAgent?) -> String {
    let name = externalAgentNarrativeName(agent)
    return name == "External agent" ? "the external agent" : name
}

/// The optional name of the particular installation or session credential.
/// The principal is the actor; this is useful supporting context when the same
/// principal connects from more than one client.
func externalAgentConnectionName(_ agent: PrivacyExternalAgent?) -> String? {
    let name = agent?.connectionName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return name.isEmpty ? nil : name
}

struct PrivacyExternalAgentFacts: Equatable, Sendable {
    let identityLabel: String
    let principal: String
    let connection: String?
}

/// The identity rows shown with a concrete exchange. Kept here so identities
/// with and without a connection stay testable without rendering SwiftUI.
func privacyExternalAgentFacts(_ agent: PrivacyExternalAgent?) -> PrivacyExternalAgentFacts {
    PrivacyExternalAgentFacts(
        identityLabel: agent?.source == .principal ? "Principal" : "Caller",
        principal: externalAgentFullName(agent),
        connection: externalAgentConnectionName(agent)
    )
}

// MARK: - Review copy

/// Causes that mean the automatic check could not run at all, rather than that
/// it ran and found something. Their findings are meaningless, so they are
/// suppressed and the copy says the check was unavailable.
///
/// A closed list, not a catch-all: the reviewer's context-window and
/// output-limit failures carry a rationale that says exactly what happened, and
/// a cause a newer gateway invented is more usefully read as an ordinary hold —
/// hiding findings the portal and Android both show would make this the one
/// surface that tells the operator less. Every cause here or not, nothing has
/// left the machine either way.
private let privacyAutomaticCheckFallbacks: Set<PrivacyReviewFallbackCause> = [
    .notConfigured,
    .requestFailed,
    .invalidOutput,
    .lowConfidence,
]

func privacyReviewUnavailable(_ cause: PrivacyReviewFallbackCause?) -> Bool {
    guard let cause else { return false }
    return privacyAutomaticCheckFallbacks.contains(cause)
}

struct PrivacyPauseCopy: Equatable, Sendable {
    let title: String
    let message: String
    /// Whether `message` is the reviewer's own sentence rather than copy
    /// Omnesis wrote. The two are shown differently — the reviewer's words are
    /// quoted — so the reader can tell whose account they are reading.
    let quotesTheReviewer: Bool
}

/// Why Omnesis is holding an answer, in the owner's language.
func privacyPauseCopy(
    fallbackCause: PrivacyReviewFallbackCause?,
    rationale: String?
)
    -> PrivacyPauseCopy {
    if privacyReviewUnavailable(fallbackCause) {
        return PrivacyPauseCopy(
            title: "Automatic privacy check unavailable",
            message: "Omnesis could not verify this answer automatically, so nothing was shared. "
                + "Review the exact answer shown above.",
            quotesTheReviewer: false
        )
    }
    if fallbackCause == .hardStop {
        return PrivacyPauseCopy(
            title: "This answer cannot be shared",
            message: "Omnesis detected information that its privacy boundary does not allow to leave.",
            quotesTheReviewer: false
        )
    }
    let reason = rationale?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return PrivacyPauseCopy(
        title: "Your privacy policy asks you to decide",
        message: reason.isEmpty
            ? "Nothing will be shared unless you approve this exact answer."
            : reason,
        quotesTheReviewer: !reason.isEmpty
    )
}

func privacyPauseCopy(_ review: PrivacyExchangeReview?) -> PrivacyPauseCopy {
    privacyPauseCopy(fallbackCause: review?.fallbackCause, rationale: review?.rationale)
}

func privacyPauseCopy(_ review: PrivacyReviewRecord) -> PrivacyPauseCopy {
    privacyPauseCopy(fallbackCause: review.fallbackCause, rationale: review.rationale)
}

/// What a ledger step's body is a quotation of, or nil when the step speaks in
/// Omnesis's own voice.
///
/// The gateway fills `display.text` with a bounded preview of the exchange's
/// own words for these five kinds — the question, the draft, the reduced draft,
/// the reviewer's rationale, the answer that left — and with a sentence it
/// wrote itself for every other. The switch is exhaustive so a kind added later
/// has to be placed on one side or the other rather than defaulting to prose.
func privacyAuditQuotedBodyRole(_ kind: PrivacyAuditEventKind) -> String? {
    switch kind {
    case .externalRequest: "question"
    case .candidateGenerated: "draft answer"
    case .reductionGenerated: "reduced answer"
    case .privacyReview: "privacy check summary"
    case .released: "answer that was shared"
    case .agentTrace, .approvalRequested, .approvalResolved, .denied, .failed, .truncated,
         .egress, .unknown:
        nil
    }
}

/// Findings are only meaningful when the check actually ran.
func privacyReviewFindings(
    fallbackCause: PrivacyReviewFallbackCause?,
    findings: [PrivacyFinding]
)
    -> [PrivacyFinding] {
    privacyReviewUnavailable(fallbackCause) ? [] : findings
}

func privacyReviewFindings(_ review: PrivacyExchangeReview?) -> [PrivacyFinding] {
    guard let review else { return [] }
    return privacyReviewFindings(fallbackCause: review.fallbackCause, findings: review.findings)
}

func privacyReviewFindings(_ review: PrivacyReviewRecord) -> [PrivacyFinding] {
    privacyReviewFindings(fallbackCause: review.fallbackCause, findings: review.findings)
}

struct PrivacyDisplayedAnswer: Equatable, Sendable {
    let text: String
    let role: String
}

/// Selects the text for the draft card without changing its trust meaning.
/// Nullish precedence mirrors the portal; a present-but-blank value is treated
/// as unavailable instead of falling through to text with a different role.
func privacyDisplayedAnswer(_ exchange: PrivacyExchangePresentation) -> PrivacyDisplayedAnswer? {
    let selected: (text: String?, role: String) = if exchange.draftAnswer != nil {
        (exchange.draftAnswer, "draft answer")
    } else if exchange.pendingCandidate != nil {
        (exchange.pendingCandidate, "draft answer")
    } else {
        (exchange.sharedAnswer, "answer that was shared")
    }
    guard let text = selected.text,
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return PrivacyDisplayedAnswer(text: text, role: selected.role)
}

func privacyExchangeNeedsPolling(_ exchange: PrivacyExchangePresentation?) -> Bool {
    exchange?.status == .running
}

/// Foreground reloads always win over periodic refreshes. A poll may begin only
/// while no other load is active; a foreground load may supersede an older poll.
struct PrivacyExchangeLoadArbiter {
    private var generation = 0
    private var foregroundLoads = 0
    private var backgroundLoad = false

    mutating func begin(background: Bool) -> Int? {
        if background, foregroundLoads > 0 || backgroundLoad { return nil }
        generation += 1
        if background { backgroundLoad = true } else { foregroundLoads += 1 }
        return generation
    }

    mutating func finish(background: Bool) {
        if background { backgroundLoad = false } else { foregroundLoads -= 1 }
    }

    func owns(_ candidate: Int) -> Bool {
        generation == candidate
    }

    mutating func invalidate() {
        generation += 1
    }
}

func privacyDraftActorLabel(_ exchange: PrivacyExchangePresentation) -> String {
    if privacyAnswerGenerationFailed(exchange) { return "Omnesis could not draft an answer" }
    return privacyExchangeNeedsPolling(exchange) && privacyDisplayedAnswer(exchange) == nil
        ? "Omnesis is drafting an answer"
        : "Omnesis drafted an answer"
}

func privacyUnavailableDraftCopy(_ exchange: PrivacyExchangePresentation) -> String {
    privacyExchangeNeedsPolling(exchange)
        ? "No draft has been recorded yet. Nothing has left this machine."
        : "The draft is not available. Nothing about it left this machine."
}

private func privacyTitleCase(_ value: String) -> String {
    let spaced = value.replacingOccurrences(of: "_", with: " ")
    return spaced
        .split(separator: " ", omittingEmptySubsequences: true)
        .map { word -> String in
            guard let first = word.first else { return "" }
            return String(first).uppercased() + word.dropFirst()
        }
        .joined(separator: " ")
}

func privacyFindingLabel(_ finding: PrivacyFinding) -> String {
    if finding.subject == .otherPerson || finding.subject == .multiplePeople {
        return "Another person"
    }
    let raw = finding.category.trimmingCharacters(in: .whitespacesAndNewlines)
    let category = privacyTitleCase(raw.isEmpty ? "Sensitive information" : raw)
    guard finding.detailLevel == .exact, !category.hasPrefix("Exact ") else { return category }
    return "Exact \(category.lowercased())"
}

/// De-duplicated, order-preserving chips. Capped so one noisy review cannot
/// turn a card into a wall of labels.
func privacyFindingLabels(_ findings: [PrivacyFinding], limit: Int = 4) -> [String] {
    var seen = Set<String>()
    var labels: [String] = []
    for finding in findings {
        let label = privacyFindingLabel(finding)
        guard seen.insert(label).inserted else { continue }
        labels.append(label)
        if labels.count == limit { break }
    }
    return labels
}

// MARK: - The decision, as a sentence

private func privacyIsHardStop(_ exchange: PrivacyExchangePresentation) -> Bool {
    exchange.review?.fallbackCause == .hardStop
}

private func privacyIsPostApprovalHardStop(_ exchange: PrivacyExchangePresentation) -> Bool {
    guard privacyIsHardStop(exchange) else { return false }
    if exchange.userDecision == .approvedButBlocked { return true }
    return exchange.approval?.status == .approved || exchange.approval?.status == .denied
}

/// The privacy decision phrased as a full sentence for the spine's third card.
/// Every branch ends by saying whether anything left the machine, because that
/// is the only fact a reader of this screen is actually here for.
func privacyExchangeDecisionCopy(_ exchange: PrivacyExchangePresentation) -> String {
    if let explicitDecision = privacyExplicitDecisionCopy(exchange) {
        return explicitDecision
    }
    if exchange.outcome == .notShared, exchange.denialReason == .approvalNotAvailable {
        return "The privacy check recommended approval, but this request has no approval flow. "
            + "Omnesis did not share the answer."
    }
    let agentName = externalAgentRecipientName(exchange.externalAgent)
    switch exchange.outcome {
    case .shared:
        return "Your policy allowed this answer, and \(agentName) received it."
    case .sharedWithReductions:
        return "Omnesis removed details from this answer, then \(agentName) received the rest."
    case .ready:
        return "Omnesis approved this answer, but \(agentName) has not received it yet."
    case .needsReview:
        return "Omnesis is holding this answer until you decide. Nothing has been shared."
    case .checking:
        return "Omnesis is still checking this answer. Nothing has been shared."
    case .failed:
        if privacyReviewUnavailable(exchange.review?.fallbackCause) {
            return "Omnesis could not verify this automatically. Nothing was shared."
        }
        return privacyAnswerGenerationFailed(exchange)
            ? "The privacy check did not run because Omnesis produced no answer. Nothing was shared."
            : "The privacy check failed. Nothing was shared."
    case .canceled:
        return "The request was canceled. Nothing was shared."
    case .notShared, .unknown:
        return "Nothing was shared."
    }
}

private func privacyExplicitDecisionCopy(_ exchange: PrivacyExchangePresentation) -> String? {
    if privacyIsHardStop(exchange) {
        return privacyIsPostApprovalHardStop(exchange)
            ? "You approved this once, but Omnesis blocked it. Nothing was shared."
            : "Omnesis blocked this answer automatically. Nothing was shared."
    }
    switch exchange.userDecision {
    case .approvedButBlocked:
        return "You approved this once, but Omnesis blocked it. Nothing was shared."
    case .approved:
        let agentName = externalAgentRecipientName(exchange.externalAgent)
        return exchange.outcome == .ready
            ? "You approved this once. \(agentName) has not received it yet."
            : "You shared this once, and \(agentName) received it."
    case .denied:
        return "You chose not to share. Nothing was shared."
    case .expired:
        return "The review expired. Nothing was shared."
    case nil:
        return nil
    }
}

/// The gateway's reviewed, safe failure explanation, or nil.
func privacyFailureMessage(_ exchange: PrivacyExchangePresentation) -> String? {
    let message = exchange.failure?.message.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return message.isEmpty ? nil : message
}

/// The machine-readable half of a failure: its code and, when the gateway
/// vetted one out of the provider's envelope, that disposition — e.g.
/// `http_api_error · HTTP 404 · NOT_FOUND · param=model`. Nil when the
/// exchange carries no failure at all, so a caller renders no empty line.
func privacyFailureDetailLine(_ exchange: PrivacyExchangePresentation) -> String? {
    guard let failure = exchange.failure else { return nil }
    var parts: [String] = []
    let code = failure.code.trimmingCharacters(in: .whitespacesAndNewlines)
    if !code.isEmpty { parts.append(code) }
    let detail = failure.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !detail.isEmpty { parts.append(detail) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

func privacyAnswerGenerationFailed(_ exchange: PrivacyExchangePresentation) -> Bool {
    if exchange.outcome != .failed { return false }
    if let stage = exchange.failure?.stage, stage != .unknown { return stage == .answerGeneration }
    return privacyDisplayedAnswer(exchange) == nil && !privacyTechnicalReviewFailed(exchange)
}

func privacyReviewFailed(_ exchange: PrivacyExchangePresentation) -> Bool {
    if exchange.outcome == .failed, let stage = exchange.failure?.stage, stage != .unknown {
        return stage == .privacyCheck
    }
    return privacyTechnicalReviewFailed(exchange)
        || (exchange.outcome == .failed && privacyDisplayedAnswer(exchange) != nil)
}

private func privacyTechnicalReviewFailed(_ exchange: PrivacyExchangePresentation) -> Bool {
    switch exchange.review?.fallbackCause {
    case .notConfigured, .requestFailed, .contextWindowExceeded, .outputTruncated,
         .invalidOutput, .lowConfidence:
        true
    default:
        false
    }
}

// MARK: - The released answer, against the draft

/// The heading a release's comparison carries, and the sentence under it.
struct PrivacyAnswerComparisonCopy: Equatable, Sendable {
    let title: String
    let detail: String?
}

/// What the record may say about how a release relates to the draft it came
/// from. Every branch describes the comparison rather than the answer: Omnesis
/// declining to present a change as an edit is a statement about what it was
/// willing to compute, not a finding about what the answer says.
func privacyAnswerComparisonCopy(
    _ comparison: PrivacyAnswerComparison
)
    -> PrivacyAnswerComparisonCopy {
    switch comparison {
    case .identical:
        PrivacyAnswerComparisonCopy(
            title: "This answer left exactly as drafted.",
            detail: nil
        )
    case .diff:
        PrivacyAnswerComparisonCopy(
            title: "Compared with the draft",
            detail: nil
        )
    case .noDiff(.dissimilar):
        PrivacyAnswerComparisonCopy(
            title: "No line-by-line comparison",
            detail: "Omnesis did not present this release as an edit of the draft, "
                + "so the released answer is shown in full above."
        )
    case .noDiff(.tooLarge):
        PrivacyAnswerComparisonCopy(
            title: "No line-by-line comparison",
            detail: "These answers are longer than this comparison runs on, "
                + "so the released answer is shown in full above."
        )
    case .noDiff(.unspecified):
        PrivacyAnswerComparisonCopy(
            title: "No line-by-line comparison",
            detail: "Omnesis produced no comparison for this release, "
                + "so the released answer is shown in full above."
        )
    }
}

/// The marker that carries draft-only versus sent without colour. Rendered in a
/// fixed-width column, so the two glyphs line up whatever font resolves.
func privacyAnswerDiffMarker(_ op: PrivacyAnswerDiffOp) -> String {
    switch op {
    case .equal: " "
    case .removed: "−"
    case .added: "+"
    }
}

/// The key to the markers, and — only where some line carries a word-level
/// breakdown — to the decorations inside those lines. Both encodings are
/// legible without colour, so the key explains shapes rather than hues.
func privacyAnswerDiffLegend(_ lines: [PrivacyAnswerDiffLine]) -> [String] {
    var entries = ["− in the draft only", "+ in what was sent"]
    if lines.contains(where: { $0.spans != nil }) {
        entries.append("struck-through and underlined words are the change inside a line")
    }
    return entries
}

/// What a listener hears for one line. Draft-only versus sent is spoken, never
/// left to the marker or the colour, and a line that is nothing but spacing is
/// announced rather than passed over in silence — a release that dropped a
/// blank line dropped something.
func privacyAnswerDiffLineLabel(_ line: PrivacyAnswerDiffLine) -> String {
    let body = privacyAnswerDiffSpokenText(line.text)
    switch line.op {
    case .equal:
        return "Unchanged. \(body)"
    case .removed:
        guard let changed = privacyAnswerDiffChangeSummary(line, op: .removed) else {
            return "In the draft only. \(body)"
        }
        return "Draft line. \(body) Removed: \(changed)."
    case .added:
        guard let changed = privacyAnswerDiffChangeSummary(line, op: .added) else {
            return "In what was sent only. \(body)"
        }
        return "Sent line. \(body) Added: \(changed)."
    }
}

private func privacyAnswerDiffSpokenText(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Blank line." : text
}

/// The changed words of one side, spoken. A run of spaces has no spoken form,
/// so it is named instead of read out: dropping it would hide a change that is
/// exactly that.
private func privacyAnswerDiffChangeSummary(
    _ line: PrivacyAnswerDiffLine,
    op: PrivacyAnswerDiffOp
)
    -> String? {
    guard let spans = line.spans else { return nil }
    let changed = spans.filter { $0.op == op }
    guard !changed.isEmpty else { return nil }
    return changed
        .map { span in
            let spoken = span.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return spoken.isEmpty ? "spacing" : spoken
        }
        .joined(separator: ", ")
}

// MARK: - Feed shape

/// A pending item is an exchange, so it lives in the feed rather than behind a
/// separate tab — but it is pinned to the top as a full review card.
func privacyExchangeIsPendingReview(_ exchange: PrivacyExchangePresentation) -> Bool {
    exchange.outcome == .needsReview && exchange.approval?.status == .pending
}

/// The number on the drawer's Privacy entry, read from the gateway's own
/// ledger counts rather than from anything a screen happens to have loaded.
///
/// Both routes report a `totalCount` for the whole matching set, so one row is
/// requested and the count is taken from the envelope. `status=pending`
/// already excludes a decision whose deadline has lapsed, so an expired held
/// answer never sits on the badge.
///
/// A request for a standing watch is the same kind of open decision, and is
/// counted alongside held answers wherever that surface exists. It is
/// best-effort on its own: a gateway that does not serve the route must not
/// take the held answers down with it.
func privacyPendingDecisionTotal(
    client: PrivacyClient,
    includesWatchRequests: Bool
) async throws
    -> Int {
    let heldAnswers = try await client.listApprovals(status: "pending", limit: 1).totalCount
    guard includesWatchRequests else { return heldAnswers }
    let watchRequests = try? await client.listSubscriptionApprovals(status: "pending", limit: 1)
    return heldAnswers + (watchRequests?.totalCount ?? 0)
}

/// Everything a pinned review card needs to let the owner decide in place.
///
/// Built from the feed's exchange alone, or from the approval detail once it
/// loads. The exchange carries the held candidate, the question and the
/// reviewer's reasoning — enough to decide without another detail request.
struct PrivacyPendingReview: Equatable {
    let approvalId: String
    let conversationId: String
    let taskId: String
    let agentName: String
    let question: String
    let candidateAnswer: String?
    let createdAt: Int64
    let pause: PrivacyPauseCopy
    let findings: [PrivacyFinding]

    var candidateAvailable: Bool {
        guard let candidateAnswer else { return false }
        return !candidateAnswer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Fails unless the exchange is genuinely awaiting a decision, so a card
    /// offering Share/Don’t-share can never be built from a settled exchange.
    init?(exchange: PrivacyExchangePresentation) {
        guard privacyExchangeIsPendingReview(exchange), let approval = exchange.approval else {
            return nil
        }
        approvalId = approval.id
        conversationId = exchange.conversationId
        taskId = exchange.taskId
        agentName = externalAgentNarrativeName(exchange.externalAgent)
        question = exchange.question
        candidateAnswer = exchange.pendingCandidate
        createdAt = exchange.createdAt
        pause = privacyPauseCopy(exchange.review)
        findings = privacyReviewFindings(exchange.review)
    }

    init(detail: PrivacyApprovalDetail) {
        approvalId = detail.id
        conversationId = detail.conversationId
        taskId = detail.taskId
        agentName = externalAgentNarrativeName(detail.externalAgent)
        question = detail.question
        candidateAnswer = detail.candidateAnswer
        createdAt = detail.createdAt
        pause = privacyPauseCopy(detail.review)
        findings = privacyReviewFindings(detail.review)
    }
}

// MARK: - The spine's running order

/// Steps that are themselves a crossing of the trust boundary.
private let privacyCrossingKinds: Set<PrivacyAuditEventKind> = [.released, .egress]

/// One moment on the spine: what happened, and when.
///
/// Three of an exchange's recorded steps are its landmarks and become cards;
/// every other step becomes a quiet row in the place the ledger put it.
enum PrivacySpineMoment: Equatable {
    case draft(PrivacyAuditEventSummary?)
    case check(PrivacyAuditEventSummary?)
    case step(PrivacyAuditEventSummary)

    var event: PrivacyAuditEventSummary? {
        switch self {
        case .draft(let event), .check(let event): event
        case .step(let event): event
        }
    }

    /// Stable across a re-read of the same exchange, and distinct between the
    /// two cards when neither has a recorded step to be identified by.
    var id: String {
        if let event { return event.id }
        switch self {
        case .draft: return "draft"
        case .check: return "check"
        case .step: return "step"
        }
    }

    /// Whether this is the decision card, which is the one moment with a second
    /// source for its instant when no step recorded it.
    var isCheck: Bool {
        if case .check = self { return true }
        return false
    }
}

struct PrivacySpineOrder: Equatable {
    let askedAt: Int64
    let inside: [PrivacySpineMoment]
    let released: PrivacyAuditEventSummary?
    let afterRelease: [PrivacyAuditEventSummary]
}

/// The spine's running order, taken from the ledger rather than invented here.
///
/// The gateway returns an exchange's steps in the order they happened, so that
/// order is the story's order and nothing on the screen has to guess at it.
/// What is *not* recorded still gets a card: a draft card that is missing says
/// Omnesis is still drafting, and the decision card carries the buttons that
/// resolve a pending exchange — neither may go missing because nothing wrote a
/// step down.
func privacySpineOrder(
    exchange: PrivacyExchangePresentation,
    events: [PrivacyAuditEventSummary]
)
    -> PrivacySpineOrder {
    let askedIndex = events.firstIndex { $0.kind == .externalRequest }
    let asked = askedIndex.map { events[$0] }
    // Dropped by position rather than by id: a payload whose steps arrive
    // without ids would otherwise have every one of them match the request's
    // and the whole ledger would vanish.
    var rest = events
    if let askedIndex { rest.remove(at: askedIndex) }
    // The first step that is itself a crossing ends the inside band. A release
    // and an outbound response are both things that left, and a ledger can
    // record the second without the first — putting a step titled "Outbound
    // response" under the "your machine" rail, on the one screen whose claim is
    // that its left edge can be read without reading a word.
    let crossing = rest.firstIndex { privacyCrossingKinds.contains($0.kind) }
    let beforeRelease = crossing.map { Array(rest[..<$0]) } ?? rest
    let released = crossing.flatMap { rest[$0].kind == .released ? rest[$0] : nil }
    let afterRelease = crossing.map {
        Array(rest[(released == nil ? $0 : rest.index(after: $0))...])
    } ?? []

    var inside: [PrivacySpineMoment] = []
    var hasDraft = false
    var hasCheck = false
    for event in beforeRelease {
        if event.kind == .candidateGenerated, !hasDraft {
            hasDraft = true
            inside.append(.draft(event))
        } else if event.kind == .privacyReview, !hasCheck {
            hasCheck = true
            inside.append(.check(event))
        } else {
            inside.append(.step(event))
        }
    }
    if !hasDraft { inside.insert(.draft(nil), at: 0) }
    if !hasCheck { inside.append(.check(nil)) }

    return PrivacySpineOrder(
        askedAt: asked?.createdAt ?? exchange.createdAt,
        inside: inside,
        released: released,
        afterRelease: afterRelease
    )
}

/// Which moments open a new day.
///
/// Every moment on the spine states its time; only the ones that begin a new
/// day state the date as well. An exchange usually happens inside one minute,
/// so repeating the same date down twelve rows would bury the only number that
/// moves; an exchange held overnight for approval spans two, and the reader has
/// to see where.
func privacyDayBreaks(_ moments: [(id: String, at: Int64?)]) -> Set<String> {
    var breaks: Set<String> = []
    var previous: String?
    for moment in moments {
        // Zero is how a record says it has no instant rather than a moment in
        // 1970, and every surface that prints one has to agree about that.
        guard let at = moment.at, at > 0 else { continue }
        let day = privacyDayKey(at)
        if day != previous {
            breaks.insert(moment.id)
            previous = day
        }
    }
    return breaks
}

/// The calendar day an instant falls on, in the reader's own zone.
func privacyDayKey(_ millis: Int64) -> String {
    let date = Date(timeIntervalSince1970: Double(millis) / 1000)
    let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
    return "\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
}

// MARK: - Resolution

struct PrivacyResolutionCopy: Equatable, Sendable {
    let ok: Bool
    let title: String
    let message: String
}

/// What to tell the owner right after they decide.
func privacyResolutionCopy(
    _ response: PrivacyApprovalResolution,
    agentName: String? = nil
)
    -> PrivacyResolutionCopy {
    let trimmedAgentName = agentName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let recipient = trimmedAgentName.isEmpty ? "the external agent" : trimmedAgentName
    return switch response.status {
    case .released, .releasedWithReductions:
        PrivacyResolutionCopy(
            ok: true,
            title: "Answer approved",
            message: "The answer is ready for \(recipient) when it returns."
        )
    case .approvalRequired:
        PrivacyResolutionCopy(
            ok: false,
            title: "Still waiting for your decision",
            message: "Nothing was shared."
        )
    case .denied:
        switch response.reason {
        case "hard_stop":
            PrivacyResolutionCopy(
                ok: false,
                title: "Answer blocked",
                message: "You approved this answer once, but Omnesis blocked it "
                    + "before anything was shared."
            )
        case "expired":
            PrivacyResolutionCopy(
                ok: false,
                title: "Approval expired",
                message: "Nothing was shared."
            )
        default:
            PrivacyResolutionCopy(
                ok: true,
                title: "Answer not shared",
                message: "Nothing was shared."
            )
        }
    }
}
