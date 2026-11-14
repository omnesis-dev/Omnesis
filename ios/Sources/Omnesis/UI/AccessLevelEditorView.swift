// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Creates an access level or changes one: a page of decisions, one screen per decision, and a review before saving.
@available(iOS 17.0, *)
struct AccessLevelEditorView: View {
    @Environment(AppStore.self) var store
    @Environment(\.dismiss) var dismiss
    let level: AccessLevelSummary?
    @State var overview: AccessOverview
    let saved: () -> Void
    @State var baseline: AccessLevelDraft
    @State var draft: AccessLevelDraft
    @State var openedClient: AccessClient?
    @State var saving = false
    @State var reloading = false
    @State var recoveryFailure: Error?
    @State var missingLevel = false
    @State var labelCredential: String?
    @State var scopeLabels: [String: [ScopeItemHint]] = [:]
    @State var scopeTotals: [ScopePolicy: AccessFilterTotals] = [:]
    @State var error: Error?
    /// The gateway's sentence for a save it refused for a reason the owner can act on.
    @State var refusal: String?
    @State var nameTaken = false
    @State var levelInUse = false
    @State var conflict = false
    @State var filter: AccessFilterRoute?
    @State var policyText: AccessPolicyTextRoute?
    @State var navigation: AccessFlowNavigation
    @State var confirmExit = false
    @State var confirmReload = false
    @AccessibilityFocusState var questionFocused: Bool

    init(
        level: AccessLevelSummary?,
        overview: AccessOverview,
        previewConflict: Bool = false,
        previewStep: AccessFlowStep? = nil,
        previewChange: (inout AccessLevelDraft) -> Void = { _ in },
        previewLabels: [String: [ScopeItemHint]] = [:],
        previewTotals: [ScopePolicy: AccessFilterTotals] = [:],
        saved: @escaping () -> Void = {}
    ) {
        self.level = level
        _navigation = State(initialValue: previewStep.map { AccessFlowNavigation(step: $0, started: true) } ?? AccessFlowNavigation())
        _overview = State(initialValue: overview)
        self.saved = saved
        var changed = AccessLevelDraft(level: level, overview: overview)
        previewChange(&changed)
        _draft = State(initialValue: changed)
        _scopeLabels = State(initialValue: previewLabels)
        _scopeTotals = State(initialValue: previewTotals)
        _baseline = State(initialValue: AccessLevelDraft(level: level, overview: overview))
        _conflict = State(initialValue: previewConflict)
        _error = State(initialValue: previewConflict ? GatewayClient.Error.serverError(status: 409, body: "stale-revision") : nil)
    }

    var original: AccessLevelDraft {
        baseline
    }

    var isEditing: Bool {
        level != nil
    }

    var changedDraft: Bool {
        draft.hasChanges(from: original)
    }

    var current: AccessFlowStep {
        navigation.current(isEditing: isEditing)
    }

    /// One question opened with Change from the level page or a review: Cancel undoes that question only.
    var inDecision: Bool {
        current != .overview && current != .review && (isEditing || navigation.returnToReview)
    }

    /// The first page of the flow, which leaves it rather than stepping back.
    var atEntry: Bool {
        isEditing ? current == .overview : current == draft.creationSteps.first
    }

    /// The draft as the shared decision steps read and change it.
    var decisions: Binding<AccessDraftDecisions> {
        Binding(
            get: { AccessDraftDecisions(draft: draft, overview: overview, original: original) },
            set: { draft = $0.draft }
        )
    }

    var body: some View {
        AccessFrame {
            AccessTopBar(title: isEditing ? "Edit access level" : AccessConnectionCopy.newLevel) { leadingAction } trailing: {
                if !isEditing, !inDecision, !atEntry { AccessBarButton("Cancel") { leave() } }
            }
        } content: {
            AccessScroll {
                notices
                AccessHeader(
                    caption: current == .overview ? original.name : nil,
                    title: question,
                    subtitle: AccessStepCopy.subtitle(current)
                )
                .accessibilityFocused($questionFocused)
                stepContent
                AccessProblemText(text: refusal, top: 16)
                if let error, !conflict {
                    GatewayErrorView(context: "save this access level", error: error, onRetry: {
                        navigation.step = .review
                        navigation.started = true
                    }).padding(.top, 16)
                }
            }
        } footer: {
            AccessFooter {
                Button(action: advance) { Text(primaryTitle) }.buttonStyle(AccessPrimaryButtonStyle()).disabled(primaryDisabled)
            }
        }
        .id(current)
        .disabled(saving || reloading)
        .interactiveDismissDisabled(changedDraft || saving || reloading)
        .onAppear { if openedClient == nil { openedClient = store.access } }
        .task(id: labelContextKey) { await resolveLabels() }
        .onChange(of: draft.name) { _, _ in nameTaken = false }
        .onChange(of: draft) { _, _ in refusal = nil }
        .onChange(of: draft.rule("answer") != nil) { _, enabled in if enabled { levelInUse = false } }
        .onChange(of: current) { _, _ in questionFocused = true }
        .alert("Discard your changes?", isPresented: $confirmExit) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .alert("Replace your draft with the latest version?", isPresented: $confirmReload) {
            Button("Discard draft and reload", role: .destructive) { Task { await reload() } }
            Button("Keep draft", role: .cancel) {}
        } message: { Text("Your unsaved decisions will be discarded. Review the latest settings before making changes again.") }
        .accessFilterEditor($filter, decisions: decisions, labels: $scopeLabels, client: openedClient)
        .navigationDestination(item: $policyText) { PrivacyPolicyScreen(familyId: $0.familyId, name: $0.name) }
    }

    @ViewBuilder private var leadingAction: some View {
        if inDecision {
            AccessBarButton("Cancel") { if let entered = navigation.cancelDecision() { draft = entered } }
        } else if atEntry {
            AccessBarButton("Close") { leave() }
        } else {
            AccessBarButton("Back") { navigation.back(draft: draft, isEditing: isEditing) }
        }
    }

    @ViewBuilder private var stepContent: some View {
        switch current {
        case .overview:
            let name = AccessDecisionLine(title: AccessDecisionTitle.name, value: draft.name, step: .name)
            // The first row brings its own padding; without it the rows would start 24 under the title plus that.
            VStack(spacing: 0) { AccessDecisionRows(lines: [name] + decisions.wrappedValue.decisionLines) { edit($0) } }
                .padding(.top, -AccessUI.rowPadding)
        case .name: AccessLevelNameField(name: $draft.name, problem: nameProblem)
        case .permissions: AccessPermissionsStep(decisions: decisions)
        case .answerData: AccessSourcesStep(decisions: decisions, capability: "answer") { filter = .init(source: $0, capability: "answer") }
        case .directData:
            AccessDirectDataStep(decisions: decisions, offersLink: isEditing) { filter = .init(source: $0, capability: "direct") }
        case .directChoice: AccessDirectChoiceStep(decisions: decisions)
        case .future: AccessNewSourcesStep(decisions: decisions)
        case .release: AccessReleaseStep(decisions: decisions) { policyText = .init(familyId: $0.id, name: $0.name) }
        case .review: reviewContent
        }
    }

    /// Leaves the flow, asking first when that would discard decisions.
    func leave() {
        if changedDraft { confirmExit = true } else { dismiss() }
    }

    /// What stands between the draft and saving it, above the page's caption.
    @ViewBuilder var notices: some View {
        if conflict {
            if missingLevel {
                AccessBanner(message: "This access level was deleted. This draft cannot be saved.", action: "Return to access levels") {
                    leave()
                }
            } else if let recoveryFailure {
                let unreadable = recoveryFailure as? GatewayClient.Error == .invalidResponse
                AccessBanner(
                    message: unreadable
                        ? "The gateway returned an unreadable response. Your changes are kept."
                        : "The latest access level could not be loaded. Your changes are kept.",
                    action: "Try loading latest again"
                ) { confirmReload = true }
            } else {
                AccessBanner(
                    message: "This access level changed elsewhere. Your changes are kept. Load the latest version before saving.",
                    action: "Load the latest version and discard my changes"
                ) { confirmReload = true }
            }
        } else if levelInUse {
            AccessBanner(
                message: "Integrations on this access level ask it for answers. Put them on another level before removing Answer.",
                action: original.rule("answer") == nil ? nil : "Restore Answer access"
            ) { if draft.restoreAnswer(from: original) { levelInUse = false } }
        }
    }

    var question: String {
        current == .review && !isEditing ? "Ready to create this access level?" : AccessStepCopy.title(current)
    }

    var primaryTitle: String {
        if current == .review {
            guard isEditing else { return saving ? "Creating…" : "Create access level" }
            return saving ? "Saving…" : "Save changes"
        }
        if current == .overview { return "Review changes" }
        return inDecision ? "Done" : "Continue"
    }

    var primaryDisabled: Bool {
        saving || reloading || currentProblem != nil
            || (current == .overview && !changedDraft)
            || (current == .review && isEditing && !changedDraft)
            || (current == .review && (conflict || !sendable))
    }

    /// What stops the page from being left as it stands, or nil.
    var currentProblem: String? {
        current == .name ? nameProblem : decisions.wrappedValue.problem(current)
    }

    /// Whether the draft can be saved: its name can be used and none of its decisions has a problem.
    var sendable: Bool {
        nameProblem == nil && decisions.wrappedValue.blockingProblem == nil
    }

    func advance() {
        guard !primaryDisabled else { return }
        if current == .review {
            Task { await save() }
            return
        }
        navigation.advance(draft: draft, isEditing: isEditing)
    }

    /// Opens a decision from its row. A level being edited asks about Direct's sources on one screen, in their current state.
    func edit(_ destination: AccessFlowStep) {
        navigation.open(isEditing && destination == .directChoice ? .directData : destination, isEditing: isEditing, draft: draft)
    }

    func labelHints(_ capability: String, _ sourceId: String) -> [ScopeItemHint] {
        scopeLabels[capability + ":" + sourceId] ?? []
    }

    struct LabelContext: Hashable {
        var credential: String
        var policies: Set<ScopePolicy>
    }

    var labelContextKey: LabelContext {
        LabelContext(
            credential: (store.access?.baseURL.absoluteString ?? "") + ":" + (store.access?.token ?? ""),
            policies: Set(original.serializedRules.flatMap(\.scopePolicies) + draft.serializedRules.flatMap(\.scopePolicies))
        )
    }

    /// Names and counts for every saved and drafted filter, which the lists and the review print. Each account's
    /// editor gives the source's words for its items; counts the gateway is still working out are asked for again.
    func resolveLabels() async {
        let context = labelContextKey
        if let labelCredential, labelCredential != context.credential {
            scopeLabels = [:]
            scopeTotals = [:]
        }
        labelCredential = context.credential
        guard let client = try? (openedClient ?? store.access)?.authorized(for: store.access) else { return }
        var fields: [String: [FilterEditorField]] = [:]
        for policy in context.policies.sorted(by: { ($0.audience.capability + $0.sourceId) < ($1.audience.capability + $1.sourceId) }) {
            guard !Task.isCancelled else { return }
            do {
                if fields[policy.sourceId] == nil {
                    fields[policy.sourceId] = try await client.filterEditor(sourceId: policy.sourceId).fields
                }
                guard let preview = try await scopeSettledPreview(policy, client: client) else { continue }
                guard !Task.isCancelled, client.isCurrent(store.access), preview.sourceId == policy.sourceId else { return }
                let key = policy.audience.capability + ":" + policy.sourceId
                scopeLabels[key] = mergingScopeLabelHints(
                    scopeLabels[key] ?? [],
                    scopeItemHints(preview, fields: fields[policy.sourceId] ?? [])
                )
                // A gone account's preview names its entries but counts nothing.
                if preview.connected {
                    scopeTotals[canonicalAccessPolicy(policy)] = .init(shared: preview.visible, hidden: preview.hidden)
                }
            } catch { /* Saved labels remain readable when optional lookup fails. */ }
        }
    }

    /// Why the name cannot be used: the gateway refused it as taken, or it fails the check made as it is typed.
    var nameProblem: String? {
        nameTaken ? accessLevelNameTakenMessage : accessLevelNameProblem(draft.name, id: draft.id, levels: overview.levels)
    }
}

@available(iOS 17.0, *)
extension AccessLevelEditorView {
    func save() async {
        guard current == .review, !saving, !reloading, !conflict, sendable, !isEditing || changedDraft else { return }
        guard let client = openedClient, client.isCurrent(store.access) else {
            error = GatewayClient.Error.unauthorized
            return
        }
        saving = true
        refusal = nil
        defer { saving = false }
        do {
            if let revision = draft.expectedRevision {
                _ = try await client.updateLevel(
                    id: draft.id,
                    name: draft.name.trimmingCharacters(in: .whitespacesAndNewlines),
                    rules: draft.serializedRules,
                    expectedRevision: revision,
                    expectedFilterRevisions: draft.expectedFilterRevisions
                )
            } else { _ = try await client.createLevel(
                name: draft.name.trimmingCharacters(in: .whitespacesAndNewlines),
                rules: draft.serializedRules
            ) }
            guard client.isCurrent(store.access) else { return }
            saved()
            dismiss()
        } catch {
            guard client.isCurrent(store.access) else { return }
            let failure = accessLevelSaveFailure(error, isEditing: isEditing)
            switch failure {
            case .nameTaken: nameTaken = true
            case .levelInUse: levelInUse = true
            case .missingLevel: missingLevel = true
            case .refused(let sentence): refusal = sentence
            case .revisionConflict, .other: break
            }
            self.error = failure == .revisionConflict || failure == .other ? error : nil
            conflict = failure == .missingLevel || failure == .revisionConflict
        }
    }

    func reload() async {
        guard !saving, !reloading else { return }
        reloading = true
        defer { reloading = false }
        guard let client = openedClient, client.isCurrent(store.access) else {
            recoveryFailure = GatewayClient.Error.unauthorized
            return
        }
        do {
            let latest = try await client.overview()
            guard let level = latest.levels.first(where: { $0.id == draft.id }) else {
                missingLevel = true
                recoveryFailure = GatewayClient.Error.notFound
                return
            }
            guard client.isCurrent(store.access) else { return }
            overview = latest
            draft = AccessLevelDraft(level: level, overview: latest)
            baseline = draft
            recoveryFailure = nil
            missingLevel = false
            levelInUse = false
            conflict = false
            navigation = AccessFlowNavigation(step: .overview, started: true)
            error = nil
        } catch { recoveryFailure = error }
    }
}

#if DEBUG
#Preview("New access level") {
    NavigationStack { AccessLevelEditorView(level: nil, overview: PreviewMocks.accessCanonicalOverview) }.environment(AppStore.preview())
}

#Preview("Level page") {
    let overview = PreviewMocks.accessCanonicalOverview
    NavigationStack { AccessLevelEditorView(level: overview.levels[0], overview: overview) }.environment(AppStore.preview())
}

#Preview("Level changed elsewhere") {
    let overview = PreviewMocks.accessCanonicalOverview
    NavigationStack { AccessLevelEditorView(level: overview.levels[0], overview: overview, previewConflict: true) }
        .environment(AppStore.preview())
}

#Preview("Saved filters with authoring unavailable") {
    let overview = PreviewMocks.scopeReadOnlyOverview
    NavigationStack { AccessLevelEditorView(level: overview.levels[0], overview: overview, previewStep: .answerData) }
        .environment(AppStore.preview())
}
#endif

#endif
