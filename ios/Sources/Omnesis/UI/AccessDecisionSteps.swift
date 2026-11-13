// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The question each decision screen asks, wherever it is shown.
enum AccessStepCopy {
    static func title(_ step: AccessFlowStep) -> String {
        switch step {
        case .overview: "What would you like to change?"
        case .name: "What should this access level be called?"
        case .permissions: "What should this connection be allowed to do?"
        case .answerData: "Which sources can Answer use?"
        case .directData, .directChoice: "Which sources can Direct read?"
        case .future: "What about new sources?"
        case .release: "How should answers be released?"
        case .review: "Review your changes"
        }
    }

    static func subtitle(_ step: AccessFlowStep) -> String? {
        switch step {
        case .directData, .directChoice:
            "Direct mode allows the agent to read allowed raw records directly without Answer’s privacy review."
        default: nil
        }
    }

    static let sameAsAnswer = "Use same sources and filters as Answer mode"
}

/// What stops a step from being left, under the controls that fix it.
struct AccessProblemText: View {
    let text: String?
    /// The space above the text, for a host that already spaces its rows.
    var top: CGFloat = 12

    var body: some View {
        if let text { Text(text).accessText(.rowSecondary, color: Theme.danger).padding(.top, top) }
    }
}

/// Which of Answer, Direct and Notes the level allows.
struct AccessPermissionsStep: View {
    @Binding var decisions: AccessDraftDecisions

    var body: some View {
        VStack(alignment: .leading, spacing: AccessUI.cardGap) {
            permission(
                "answer",
                detail: "Ask questions to the Omnesis agent using allowed sources. "
                    + "A privacy policy can review every answer before it is released."
            ).disabled(decisions.answerRequired)
            permission(
                "direct",
                detail: "Search and read raw matching records from allowed sources.",
                warning: "Direct is not protected by a privacy policy."
            )
            permission(
                "notes",
                detail: "Save notes with Tell Omnesis. The agent’s name is recorded with each note. "
                    + "This does not grant access to read existing notes."
            )
        }
        if decisions.answerRequired {
            Text("Answer is required by this integration.").accessText(.rowSecondary, color: AccessUI.secondary).padding(.top, 12)
        }
        AccessProblemText(text: decisions.problem(.permissions))
    }

    private func permission(_ capability: String, detail: String, warning: String? = nil) -> some View {
        let held = decisions.holds(capability)
        return Button { decisions.setHeld(capability, !held) } label: {
            AccessOptionCard(
                title: accessCapabilityName(capability),
                detail: detail,
                warning: warning,
                selected: held,
                control: .checkbox
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("access-permission-\(capability)")
    }
}

/// The source accounts one capability reads: a searchable list of accounts, each with what it shares and the way into its filter.
/// A `frozen` list only shows them: no search, nothing to tick or change, the rows muted.
@available(iOS 17.0, *)
struct AccessSourcesStep: View {
    @Binding var decisions: AccessDraftDecisions
    let capability: String
    var frozen = false
    let editFilter: (AccessSourceInstance) -> Void
    @State private var query = ""

    private var step: AccessFlowStep {
        capability == "answer" ? .answerData : .directData
    }

    var body: some View {
        let all = decisions.sources(capability)
        let visible = frozen ? all : accessSourcesMatching(all, query: query)
        if all.isEmpty {
            Text(accessNoConnectedAccountsMessage).accessText(.rowSecondary, color: AccessUI.secondary)
        } else {
            if !frozen { AccessSearchField(prompt: "Search sources", text: $query).padding(.bottom, 16) }
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 20) {
                    Text(decisions.allowedCountLabel(capability)).accessText(.rowSecondary, color: AccessUI.secondary).monospacedDigit()
                    Spacer(minLength: 0)
                    if !frozen {
                        bulkButton("Allow all", allowed: true, visible: visible)
                        bulkButton("Block all", allowed: false, visible: visible)
                    }
                }
                .padding(.bottom, 12)
                AccessDivider()
                ForEach(Array(visible.enumerated()), id: \.element.id) { index, source in
                    row(source, last: index == visible.count - 1)
                }
            }
            .opacity(frozen ? 0.5 : 1)
            .disabled(frozen)
            if visible.isEmpty {
                Text("No sources match this search.").accessText(.rowSecondary, color: AccessUI.secondary).padding(.top, 12)
            }
        }
        if !frozen { AccessProblemText(text: decisions.problem(step)) }
    }

    private func bulkButton(_ title: String, allowed: Bool, visible: [AccessSourceInstance]) -> some View {
        let next = decisions.selection(settingAllowed: allowed, for: visible, capability: capability)
        return Button { if let next { decisions.setSourceSelection(next, capability: capability) } } label: {
            Text(title)
                .accessText(.label, color: next == nil ? AccessUI.muted : Theme.accent)
                .padding(.vertical, 12)
                .contentShape(.rect)
                .padding(.vertical, -12)
        }
        .buttonStyle(.plain)
        .disabled(next == nil)
    }

    private func row(_ source: AccessSourceInstance, last: Bool) -> some View {
        let next = decisions.selection(toggling: source, capability: capability)
        return AccessAccountRow(
            source: source,
            selected: decisions.isAllowed(source.id, capability: capability),
            status: decisions.status(source, capability: capability),
            last: last,
            toggle: frozen ? nil : { if let next { decisions.setSourceSelection(next, capability: capability) } },
            trailing: {
                if !frozen, decisions.filterEntryVisible(source, capability: capability) {
                    AccessChangeButton(label: "Change \(capability) filter for \(accessAccountLineText(source))") { editFilter(source) }
                }
            }
        )
        .accessibilityIdentifier("access-source-\(source.id)")
    }
}

/// Direct's sources on a level being edited. While Direct follows Answer, Answer's list is shown frozen with the way to
/// give Direct a list of its own; while Direct has its own list, that list is editable with the way back to Answer's.
/// Switching only changes the draft, so Cancel undoes it. A level without Answer shows Direct's list alone.
@available(iOS 17.0, *)
struct AccessDirectDataStep: View {
    @Binding var decisions: AccessDraftDecisions
    /// Whether this screen offers following Answer's sources; a flow that asks that on its own screen passes false.
    let offersLink: Bool
    let editFilter: (AccessSourceInstance) -> Void

    var body: some View {
        if offersLink, decisions.holds("answer") {
            if decisions.directSameAsAnswer {
                Text("Uses the same sources and filters as Answer mode.")
                    .accessText(.subtitle)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 12)
                action("Choose different sources", same: false)
                AccessSourcesStep(decisions: $decisions, capability: "answer", frozen: true) { _ in }
            } else {
                action(AccessStepCopy.sameAsAnswer, same: true)
                AccessSourcesStep(decisions: $decisions, capability: "direct", editFilter: editFilter)
            }
        } else {
            AccessSourcesStep(decisions: $decisions, capability: "direct", editFilter: editFilter)
        }
    }

    private func action(_ title: String, same: Bool) -> some View {
        Button(title) { decisions.setDirectSameAsAnswer(same) }
            .buttonStyle(AccessSecondaryButtonStyle())
            .disabled(!decisions.canUseAnswerSourcesForDirect)
            .padding(.bottom, 20)
            .accessibilityIdentifier(same ? "access-direct-same-as-answer" : "access-direct-own-sources")
    }
}

/// Whether Direct reads what Answer reads. Answer's accounts are listed while it does.
@available(iOS 17.0, *)
struct AccessDirectChoiceStep: View {
    @Binding var decisions: AccessDraftDecisions

    var body: some View {
        VStack(spacing: AccessUI.cardGap) {
            Button { decisions.setDirectSameAsAnswer(true) } label: {
                AccessOptionCard(title: AccessStepCopy.sameAsAnswer, selected: decisions.directSameAsAnswer)
            }
            .buttonStyle(.plain)
            .disabled(!decisions.canUseAnswerSourcesForDirect)
            Button { decisions.setDirectSameAsAnswer(false) } label: {
                AccessOptionCard(title: "Choose different sources", selected: !decisions.directSameAsAnswer)
            }.buttonStyle(.plain)
        }
        if decisions.directSameAsAnswer {
            let shared = decisions.sources("answer").filter { decisions.isAllowed($0.id, capability: "answer") }
            Color.clear.frame(height: AccessUI.headerGap - AccessUI.rowPadding)
            ForEach(Array(shared.enumerated()), id: \.element.id) { index, source in
                AccessAccountRow(source: source, status: decisions.status(source, capability: "answer"), last: index == shared.count - 1)
            }
            if shared.isEmpty { Text("No sources selected for Answer.").accessText(.rowSecondary, color: AccessUI.secondary) }
        }
    }
}

/// What happens to a source connected later, asked once per list of sources.
struct AccessNewSourcesStep: View {
    @Binding var decisions: AccessDraftDecisions

    var body: some View {
        let capabilities = decisions.newSourceCapabilities
        ForEach(Array(capabilities.enumerated()), id: \.element) { index, capability in
            AccessSectionHeading(decisions.newSourcesHeading(capability), first: index == 0)
            VStack(spacing: AccessUI.cardGap) {
                choice(false, capability, title: "Keep new sources blocked", detail: "I will allow each new source when I am ready.")
                choice(
                    true,
                    capability,
                    title: "Allow new sources automatically",
                    detail: "New sources will be included without another approval."
                )
            }
        }
    }

    private func choice(_ allowed: Bool, _ capability: String, title: String, detail: String) -> some View {
        let chosen = decisions.allowsNewSources(capability) == allowed
        let next = decisions.selection(allowingNewSources: allowed, capability: capability)
        return Button { if let next { decisions.setSourceSelection(next, capability: capability) } } label: {
            AccessOptionCard(title: title, detail: detail, selected: chosen)
        }
        .buttonStyle(.plain)
        .disabled(!chosen && next == nil)
    }
}

/// How answers leave: through a privacy policy the owner picks, or without review.
struct AccessReleaseStep: View {
    @Binding var decisions: AccessDraftDecisions
    /// Opens the full text of a policy, so it can be read before answers are released through it.
    let readPolicy: (AccessPolicyFamilySummary) -> Void

    private var reviewedFamily: String? {
        if case .reviewed(let family) = decisions.release { return family }
        return nil
    }

    var body: some View {
        let overview = decisions.overview
        VStack(alignment: .leading, spacing: AccessUI.cardGap) {
            Button {
                if reviewedFamily == nil { decisions.setRelease(.reviewed(policyFamilyId: overview.startingPolicyFamilyId)) }
            } label: {
                AccessOptionCard(
                    title: "Review answers with a privacy policy",
                    detail: "The selected privacy policy reviews each answer before it is released.",
                    selected: reviewedFamily != nil
                )
            }.buttonStyle(.plain)
            if let family = reviewedFamily {
                let chosen = overview.policyFamilies.first { $0.id == family }
                Menu {
                    ForEach(overview.policyFamilies) { policy in
                        Button(policy.name) { decisions.setRelease(.reviewed(policyFamilyId: policy.id)) }
                    }
                } label: {
                    HStack(spacing: 12) {
                        Text(chosen?.name ?? "Choose a policy").accessText(.rowTitle).fontWeight(.regular)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(AccessUI.secondary)
                            .accessibilityHidden(true)
                    }
                    .modifier(AccessFieldBox())
                    .contentShape(.rect)
                }
                .accessibilityLabel("Privacy policy")
                .accessibilityValue(chosen?.name ?? "")
                if let chosen {
                    Button { readPolicy(chosen) } label: {
                        Text("Read this policy").accessText(.label, color: Theme.accent).frame(minHeight: 32)
                    }
                    .buttonStyle(.plain)
                }
            }
            Button { decisions.setRelease(.unreviewed) } label: {
                AccessOptionCard(
                    title: "Release without privacy review",
                    detail: "The agent can only see data from allowed records, but no privacy reviewer checks the answer.",
                    selected: decisions.release == .unreviewed
                )
            }.buttonStyle(.plain)
        }
        AccessProblemText(text: decisions.problem(.release))
    }
}

/// The level's decisions as rows: each with its value and, where the host lets it change, the way into it.
@available(iOS 17.0, *)
struct AccessDecisionRows: View {
    let lines: [AccessDecisionLine]
    var change: ((AccessFlowStep) -> Void)?

    var body: some View {
        ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
            AccessRow(last: index == lines.count - 1) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(line.title).accessText(.rowTitle)
                        if !line.value.isEmpty {
                            Text(line.value)
                                .accessText(.rowSecondary, color: AccessUI.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let holdings = line.holdings { AccessCapabilityPills(holdings: holdings).padding(.top, 4) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let change { AccessChangeButton(label: "Change \(line.title)") { change(line.step) } }
                }
            }
        }
    }
}

/// The account whose filter is open, and the capability it filters.
struct AccessFilterRoute: Identifiable {
    let source: AccessSourceInstance
    let capability: String

    var id: String {
        capability + ":" + source.id
    }
}

@available(iOS 17.0, *)
extension View {
    /// Presents the filter editor for one account of the decisions, and writes the filter it applies back to them.
    /// `labels` keeps the names the editor resolved, keyed by capability and account.
    func accessFilterEditor(
        _ route: Binding<AccessFilterRoute?>,
        decisions: Binding<AccessDraftDecisions>,
        labels: Binding<[String: [ScopePreview.Item]]>,
        client: AccessClient?
    )
        -> some View {
        sheet(item: route) { route in
            NavigationStack {
                SourceFilterEditorView(
                    source: route.source,
                    levelId: decisions.wrappedValue.levelId,
                    capability: route.capability,
                    initialPolicy: decisions.wrappedValue.policy(route.source.id, capability: route.capability),
                    authoringEnabled: decisions.wrappedValue.authoringEnabled,
                    client: client,
                    displayHints: labels.wrappedValue[route.id] ?? [],
                    hintsChanged: { labels.wrappedValue[route.id] = mergingScopeLabelHints(labels.wrappedValue[route.id] ?? [], $0) },
                    changed: { decisions.wrappedValue.setPolicy($0, sourceId: route.source.id, capability: route.capability) }
                )
            }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
private struct AccessDecisionStepsPreview: View {
    @State var decisions = AccessDraftDecisions(
        draft: AccessLevelDraft(level: PreviewMocks.accessCanonicalOverview.levels[0], overview: PreviewMocks.accessCanonicalOverview),
        overview: PreviewMocks.accessCanonicalOverview,
        original: AccessLevelDraft(level: PreviewMocks.accessCanonicalOverview.levels[0], overview: PreviewMocks.accessCanonicalOverview)
    )
    let step: AccessFlowStep

    var body: some View {
        AccessScroll {
            AccessHeader(title: AccessStepCopy.title(step), subtitle: AccessStepCopy.subtitle(step))
            switch step {
            case .permissions: AccessPermissionsStep(decisions: $decisions)
            case .directChoice: AccessDirectChoiceStep(decisions: $decisions)
            case .future: AccessNewSourcesStep(decisions: $decisions)
            case .release: AccessReleaseStep(decisions: $decisions) { _ in }
            case .overview: AccessDecisionRows(lines: decisions.decisionLines) { _ in }
            case .directData: AccessDirectDataStep(decisions: $decisions, offersLink: true) { _ in }
            default: AccessSourcesStep(decisions: $decisions, capability: "answer") { _ in }
            }
        }
        .background(Theme.bgPrimary)
        .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("Permissions") { AccessDecisionStepsPreview(step: .permissions) }

@available(iOS 17.0, *)
#Preview("Sources") { AccessDecisionStepsPreview(step: .answerData) }

@available(iOS 17.0, *)
#Preview("Direct choice") { AccessDecisionStepsPreview(step: .directChoice) }

@available(iOS 17.0, *)
#Preview("Direct data") { AccessDecisionStepsPreview(step: .directData) }

@available(iOS 17.0, *)
#Preview("New sources") { AccessDecisionStepsPreview(step: .future) }

@available(iOS 17.0, *)
#Preview("Release") { AccessDecisionStepsPreview(step: .release) }

@available(iOS 17.0, *)
#Preview("Decision rows") { AccessDecisionStepsPreview(step: .overview) }
#endif
#endif
