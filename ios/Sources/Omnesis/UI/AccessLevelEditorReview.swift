// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
extension AccessLevelEditorView {
    /// What the draft changes from the saved level, with the counts resolved so far.
    private var review: AccessLevelChangeReview {
        AccessLevelChangeReview(original: original, draft: draft, overview: overview, totals: scopeTotals)
    }

    @ViewBuilder var reviewContent: some View {
        if isEditing { changedDecisions } else { newLevelDecisions }
        AccessProblemText(text: decisions.wrappedValue.sourcesProblem)
    }

    @ViewBuilder private var changedDecisions: some View {
        let review = self.review
        let changed = review.changedTitles
        AccessSectionHeading("Changes", first: true)
        ForEach(Array(changed.enumerated()), id: \.element) { index, title in
            changedDecision(title, review: review)
            if index < changed.count - 1 { AccessDivider().padding(.vertical, AccessUI.rowPadding) }
        }
        let unchanged = review.unchangedLines
        if !unchanged.isEmpty {
            AccessSectionHeading("Unchanged")
            AccessUnchangedBlock(rows: unchanged)
        }
        AccessSectionHeading("Affected")
        affected
    }

    @ViewBuilder private func changedDecision(_ title: String, review: AccessLevelChangeReview) -> some View {
        switch title {
        case AccessDecisionTitle.name:
            decisionHeading(title, step: .name)
            AccessBeforeAfter(before: original.name, after: draft.name)
            AccessProblemText(text: nameProblem)
        case AccessDecisionTitle.permissions:
            decisionHeading(title, step: .permissions)
            AccessBeforeAfter {
                AccessCapabilityPills(holdings: review.before.capabilityHoldings)
            } after: {
                AccessCapabilityPills(holdings: review.after.capabilityHoldings)
            }
        case AccessDecisionTitle.answerData, AccessDecisionTitle.directData:
            let capability = title == AccessDecisionTitle.answerData ? "answer" : "direct"
            decisionHeading(title, step: capability == "answer" ? .answerData : .directData)
            let accounts = review.changedAccounts(capability)
            ForEach(Array(accounts.enumerated()), id: \.element.id) { index, source in
                accountChange(review.accountChange(capability, sourceId: source.id), capability: capability, source: source)
                    .padding(.top, index == 0 ? 0 : 20)
            }
        case AccessDecisionTitle.newSources:
            decisionHeading(title, step: .future)
            AccessBeforeAfter(before: review.before.newSourcesSummary, after: review.after.newSourcesSummary)
        default:
            decisionHeading(title, step: .release)
            AccessBeforeAfter(before: review.before.releaseSummary, after: review.after.releaseSummary)
        }
    }

    /// A changed decision's name, with the way back into it.
    private func decisionHeading(_ title: String, step: AccessFlowStep) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).accessText(.rowTitle).accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            AccessChangeButton(label: "Change \(title)") { edit(step) }
        }
        .padding(.bottom, 10)
    }

    /// One account whose share changed: each side's line with the items of the filter that side holds under it, or,
    /// when both sides hold a filter, both lines and then one list marking what the change adds and removes.
    private func accountChange(_ change: AccessAccountChange, capability: String, source: AccessSourceInstance) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            AccessAccountLine(source: source).padding(.bottom, 10)
            VStack(alignment: .leading, spacing: 8) {
                AccessBeforeAfterLine(side: .before) { sideValue(change.before, color: AccessUI.secondary) }
                sideItems(change.before.items, capability: capability, source: source)
                AccessBeforeAfterLine(side: .after) { sideValue(change.after, color: Theme.textPrimary) }
                sideItems(change.after.items, capability: capability, source: source)
            }
            if !change.merged.isEmpty {
                referenceRows(change.merged, capability: capability, source: source).padding(.top, 6)
            }
        }
    }

    /// A side's counts, when it holds a filter whose counts are known, with its pill beside them when one line holds
    /// both and under them when it does not.
    private func sideValue(_ side: AccessAccountSide, color: Color) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { sideParts(side, color: color) }
            VStack(alignment: .leading, spacing: 6) { sideParts(side, color: color) }
        }
    }

    @ViewBuilder private func sideParts(_ side: AccessAccountSide, color: Color) -> some View {
        if let counts = side.counts { Text(counts).accessText(.subtitle, color: color) }
        AccessPill(status: side.status)
    }

    /// The items of the filter one side holds, unmarked, aligned under that side's value.
    @ViewBuilder private func sideItems(_ refs: [ScopeRef], capability: String, source: AccessSourceInstance) -> some View {
        if !refs.isEmpty {
            referenceRows(refs.map { .init(ref: $0, change: .kept) }, capability: capability, source: source)
                .padding(.leading, AccessUI.beforeAfterLabelWidth)
                .padding(.bottom, 4)
        }
    }

    private func referenceRows(_ deltas: [ScopeRefDelta], capability: String, source: AccessSourceInstance) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(deltas.enumerated()), id: \.offset) { index, delta in
                let hint = scopeLabelHint(for: delta.ref, in: labelHints(capability, source.id))
                AccessFilterItemRow(
                    ref: delta.ref,
                    named: hint,
                    scopes: source.scopes,
                    count: hint?.missing == true ? nil : hint?.count,
                    change: delta.change,
                    last: index == deltas.count - 1
                )
            }
        }
    }

    @ViewBuilder private var newLevelDecisions: some View {
        AccessLevelNameField(name: $draft.name, problem: nameProblem)
        Color.clear.frame(height: 10)
        AccessDecisionRows(lines: decisions.wrappedValue.decisionLines) { edit($0) }
    }

    /// Who the saved change reaches, and when it takes effect for them.
    @ViewBuilder private var affected: some View {
        let usage = overview.levels.first { $0.id == draft.id }.map { AccessLevelUsage(level: $0, overview: overview) }
        if let usage, usage.inUse {
            VStack(alignment: .leading, spacing: 10) {
                AccessLevelUsageNames(usage: usage)
                Text(accessLevelImpactDetail).accessText(.rowSecondary, color: AccessUI.secondary).padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text("No connections use this access level yet.").accessText(.rowSecondary, color: AccessUI.secondary)
        }
    }
}

#if DEBUG
#Preview("Review a renamed level") {
    let overview = PreviewMocks.accessCanonicalOverview
    NavigationStack {
        AccessLevelEditorView(
            level: overview.levels[0],
            overview: overview,
            previewStep: .review,
            previewChange: PreviewMocks.accessNameChange
        )
    }.environment(AppStore.preview())
}

#Preview("Review a changed filter") {
    let overview = PreviewMocks.accessCanonicalOverview
    NavigationStack {
        AccessLevelEditorView(
            level: overview.levels[0],
            overview: overview,
            previewStep: .review,
            previewChange: PreviewMocks.accessFilterChange,
            previewLabels: PreviewMocks.accessCanonicalLabels,
            previewTotals: PreviewMocks.accessCanonicalTotals
        )
    }.environment(AppStore.preview())
}

#Preview("Review Direct switched off") {
    let overview = PreviewMocks.accessDirectAsAnswerOverview
    NavigationStack {
        AccessLevelEditorView(
            level: overview.levels[0],
            overview: overview,
            previewStep: .review,
            previewChange: PreviewMocks.accessDirectRemoved,
            previewLabels: PreviewMocks.accessCanonicalLabels,
            previewTotals: PreviewMocks.accessCanonicalTotals
        )
    }.environment(AppStore.preview())
}

#Preview("Review a new level") {
    NavigationStack {
        AccessLevelEditorView(
            level: nil,
            overview: PreviewMocks.accessCanonicalOverview,
            previewStep: .review,
            previewChange: PreviewMocks.accessNewLevel
        )
    }.environment(AppStore.preview())
}
#endif
#endif
