// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// One exchange, told as a spine: who asked, what Omnesis drafted, what the
// privacy check decided, and every step the gateway recorded in between.
//
// The trust boundary is encoded structurally rather than described. Each band
// of the story is a zone that draws one unbroken vertical line down its whole
// height, all at the same x, so the left edge alone reads as a single spine:
// dashed outside the machine, a labelled hairline at the edge, solid and
// accented alongside the cards inside, then — only when something actually
// left — a second hairline and dashed again. Inside/outside is the whole point
// of this screen, and a reader can see it without reading a word.
//
// One telling, not two. The audit ledger and the story are the same events in
// the same order, so they are one column: the ledger supplies the order and the
// instants, the cards supply the prominence.
//
// The portal puts each instant in a gutter to the left of the rail, where the
// times line up as a scale. A phone has no room for a column beside the rail
// without taking a quarter of the line length off every card, so here the
// instant sits above the thing it stamps.

private let privacySharedOutcomes: Set<PrivacyExchangeOutcome> = [.shared, .sharedWithReductions]

// MARK: - The three cards

@available(iOS 17.0, *)
struct PrivacyExchangeSpine: View {
    let exchange: PrivacyExchangePresentation
    var events: [PrivacyAuditEventSummary] = []
    var busy: String?
    var actionError: String?
    var onApprove: () -> Void = {}
    var onDeny: () -> Void = {}

    /// The order and the day breaks are read once, here, rather than as
    /// computed properties: every moment on the spine consults both, so a
    /// property would re-scan the whole ledger and rebuild the set once per row.
    private let order: PrivacySpineOrder
    private let dayBreaks: Set<String>

    init(
        exchange: PrivacyExchangePresentation,
        events: [PrivacyAuditEventSummary] = [],
        busy: String? = nil,
        actionError: String? = nil,
        onApprove: @escaping () -> Void = {},
        onDeny: @escaping () -> Void = {}
    ) {
        self.exchange = exchange
        self.events = events
        self.busy = busy
        self.actionError = actionError
        self.onApprove = onApprove
        self.onDeny = onDeny

        let order = privacySpineOrder(exchange: exchange, events: events)
        self.order = order
        let shared = privacySharedOutcomes.contains(exchange.outcome)
        let released = shared || order.released != nil || !order.afterRelease.isEmpty
        var moments: [(id: String, at: Int64?)] = [("asked", order.askedAt)]
        for item in order.inside {
            let at = item.event?.createdAt
                ?? (item.isCheck ? exchange.resolvedAt : nil)
            moments.append((item.id, at))
        }
        if released { moments.append(("received", order.released?.createdAt ?? exchange.sharedAt)) }
        for event in order.afterRelease {
            moments.append((event.id, event.createdAt))
        }
        self.dayBreaks = privacyDayBreaks(moments)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PrivacySpineZone(band: .outside) {
                moment(id: "asked", at: order.askedAt) { requestCard }
            }
            PrivacyBoundaryLine(label: "your machine")
            PrivacySpineZone(band: .inside, reachesForward: released) { insideMoments }
            if released {
                PrivacyBoundaryLine(label: "left your machine")
                PrivacySpineZone(band: .received, reachesForward: false) { receivedMoments }
            }
        }
    }

    /// Whether anything crossed back out: an answer that was released, one that
    /// was collected, or a step recorded after the release.
    ///
    /// The crossing is drawn when the ledger says something crossed. An answer
    /// the operator approved but the caller has not collected has a release
    /// step and no receipt, and dropping the whole band on that state would
    /// take the release — and every step after it — off the one screen that
    /// accounts for what left.
    private var released: Bool {
        shared || order.released != nil || !order.afterRelease.isEmpty
    }

    private var receivedAt: Int64? {
        order.released?.createdAt ?? exchange.sharedAt
    }

    /// The instant a card carries when no step recorded one. Only the decision
    /// card has a second source for it.
    private func momentFallback(_ item: PrivacySpineMoment) -> Int64? {
        item.isCheck ? exchange.resolvedAt : nil
    }

    /// One moment: when it happened, then what happened.
    ///
    /// Zero is how a record says it has no instant rather than a moment in 1970,
    /// so a step stamped that way carries no time at all.
    private func moment(
        id: String,
        at: Int64?,
        @ViewBuilder content: () -> some View
    )
        -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            if let at, at > 0 {
                PrivacyMomentLabel(at: at, showsDay: dayBreaks.contains(id))
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var agentName: String {
        externalAgentNarrativeName(exchange.externalAgent)
    }

    private var agentFacts: PrivacyExternalAgentFacts {
        privacyExternalAgentFacts(exchange.externalAgent)
    }

    private var shared: Bool {
        privacySharedOutcomes.contains(exchange.outcome)
    }

    private var pending: Bool {
        privacyExchangeIsPendingReview(exchange)
    }

    // MARK: Card 1 — outside

    private var requestCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                PrivacyActorLine(kind: .external, label: "\(agentName) asked")
                Spacer(minLength: Theme.Spacing.sm)
                Text(privacyRelativeDate(exchange.createdAt))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
            PrivacyQuote(text: exchange.question, role: "question", size: 16)
            // OAuth records name the principal and optional connection;
            // legacy records retain their caller label.
            Divider().background(Theme.borderLight)
            factRow(agentFacts.identityLabel, value: agentFacts.principal)
            if let connectionName = agentFacts.connection {
                factRow("Connection", value: connectionName)
            }
            factRow("Workflow", value: workflowName)
            factRow("Stated purpose", value: workflowPurpose)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(
                    Theme.border,
                    style: StrokeStyle(lineWidth: 1, dash: [5, 4])
                )
        }
    }

    private var workflowName: String {
        let name = exchange.workflow.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Unnamed workflow" : name
    }

    private var workflowPurpose: String {
        let purpose = exchange.workflow.purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        return purpose.isEmpty ? "None supplied." : purpose
    }

    // MARK: Cards 2 and 3 — inside

    /// The moments inside the machine stand on the page, not in a container of
    /// their own. What holds them together is the band: the hairline that opens
    /// it and the solid rail beside it. A panel around them would say the same
    /// thing a second time, and cost a level of nesting to say it.
    private var insideMoments: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(order.inside, id: \.id) { item in
                moment(id: item.id, at: item.event?.createdAt ?? momentFallback(item)) {
                    switch item {
                    case .draft(let event):
                        draftCard(event)
                        // The stored local-generation attempts sit under the
                        // draft card, where the portal nests its own agent
                        // transcripts. The traces ride on the exchange, so no
                        // extra spine state is needed to reach them here.
                        PrivacyAgentTranscriptsView(
                            traces: exchange.agentTraces,
                            omittedAttempts: exchange.agentTraceOmittedAttempts
                        )
                    case .check(let event): decisionCard(event)
                    case .step(let event): PrivacyLedgerStep(event: event)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var receivedMoments: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            moment(id: "received", at: receivedAt) { receivedLine }
            ForEach(order.afterRelease) { event in
                moment(id: event.id, at: event.createdAt) { PrivacyLedgerStep(event: event) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func draftCard(_ event: PrivacyAuditEventSummary?) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            PrivacyActorLine(kind: .omnesis, label: privacyDraftActorLabel(exchange))
            if let answer = privacyDisplayedAnswer(exchange) {
                PrivacyAnswerBlock(answer: answer.text, role: answer.role)
                if !shared {
                    Text("This draft has not left this machine.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                }
            } else {
                // One sentence, not two: with no draft to show, the "has not
                // left" note below would only repeat this line.
                Text(privacyUnavailableDraftCopy(exchange))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if privacyAnswerGenerationFailed(exchange) {
                failureLines
            }
            if let model = modelLine(event) {
                Text(model)
                    .font(Theme.monospace(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            privacyAnswerGenerationFailed(exchange)
                ? Theme.danger.opacity(0.08)
                : Theme.bgSecondary
        )
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                .stroke(
                    privacyAnswerGenerationFailed(exchange) ? Theme.danger : Theme.borderLight,
                    lineWidth: 1
                )
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    /// What went wrong, in both registers: the sentence a reader acts on, and
    /// beneath it the code plus whatever disposition the provider reported —
    /// the part that says which knob to turn.
    @ViewBuilder
    private var failureLines: some View {
        if let message = privacyFailureMessage(exchange) {
            Text(message)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.danger)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let detail = privacyFailureDetailLine(exchange) {
            Text(detail)
                .font(Theme.monospace(size: 10))
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    /// The reviewer's own words, from wherever this exchange keeps them.
    ///
    /// The record carries a rationale and the ledger step carries the sentence
    /// the reviewer wrote; they are usually the same words, and an exchange
    /// whose record kept no rationale still has the step. Reading only the
    /// record would lose the reviewer's account entirely on those.
    private func reviewRationale(_ event: PrivacyAuditEventSummary?) -> String? {
        trimmed(exchange.review?.rationale) ?? trimmed(event?.display.text)
    }

    private func decisionCard(_ event: PrivacyAuditEventSummary?) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            PrivacyActorLine(kind: .check, label: "Privacy check")
            Text(privacyExchangeDecisionCopy(exchange))
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if privacyReviewFailed(exchange) {
                failureLines
            }
            if let rationale = reviewRationale(event) {
                // The sentence above is Omnesis's own account of the outcome;
                // this is the reviewer's, in its words.
                PrivacyQuote(text: rationale, role: "privacy check summary", size: 13)
            }
            PrivacyFindingChips(findings: privacyReviewFindings(exchange.review))
            reductions
            if let reviewModel = modelLine(event ?? firstEvent(.privacyReview)) {
                Text("Checked by \(reviewModel).")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
            if let policy = exchange.review?.reviewedPolicy {
                PrivacyReviewedUnderRow(policy: policy)
            }
            if let actionError {
                PrivacyBanner(text: actionError)
            }
            if pending {
                decisionActions
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(privacyReviewFailed(exchange) ? Theme.danger.opacity(0.08) : Theme.bgSecondary)
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                .stroke(
                    privacyReviewFailed(exchange) ? Theme.danger : Theme.borderLight,
                    lineWidth: 1
                )
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    @ViewBuilder
    private var reductions: some View {
        if !exchange.reductions.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text("Details removed before sharing")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
                ForEach(Array(exchange.reductions.enumerated()), id: \.offset) { _, item in
                    Text("• \(item)")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var decisionActions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Spacing.sm) { shareButton
                denyButton
            }
            VStack(spacing: Theme.Spacing.sm) { shareButton
                denyButton
            }
        }
        .padding(.top, Theme.Spacing.xs)
    }

    private var shareButton: some View {
        Button(action: onApprove) {
            Text(busy == "approve" ? "Approving…" : "Share once")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.accent)
        .disabled(busy != nil || exchange.candidateAwaitingReview == nil)
    }

    private var denyButton: some View {
        Button(role: .destructive, action: onDeny) {
            Text(busy == "deny" ? "Not sharing…" : "Don’t share")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(busy != nil)
    }

    // MARK: Back outside

    private var receivedLine: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            // The release, then the receipt it led to: a caller cannot have
            // received an answer before it was let go.
            if let release = order.released {
                PrivacyLedgerStep(event: release)
            }
            // Only when it was actually collected. A released answer the caller
            // has not come back for has crossed the boundary without anyone
            // receiving it, and the release step above says so.
            if shared {
                Text(receivedText)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var receivedText: String {
        guard let sharedAt = exchange.sharedAt else {
            return "\(agentName) received this answer."
        }
        return "\(agentName) received this answer \(privacyRelativeDate(sharedAt))."
    }

    // MARK: Helpers

    private func firstEvent(_ kind: PrivacyAuditEventKind) -> PrivacyAuditEventSummary? {
        events.first { $0.kind == kind }
    }

    private func modelLine(_ event: PrivacyAuditEventSummary?) -> String? {
        let parts = [event?.display.provider, event?.display.model].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " / ")
    }

    private func trimmed(_ value: String?) -> String? {
        let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    private func factRow(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
                .textCase(.uppercase)
            Text(value)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

#endif
