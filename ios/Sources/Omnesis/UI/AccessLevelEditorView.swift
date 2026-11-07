// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

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
    @State var impactConnectionCount = 0
    @State var labelCredential: String?
    @State var scopeLabels: [String: [ScopePreview.Item]] = [:]
    @State var error: Error?
    @State var nameTaken = false
    @State var levelInUse = false
    @State var conflict = false
    @State var filter: FilterRoute?
    struct FilterRoute: Identifiable {
        let source: AccessSourceInstance
        let capability: String
        var id: String {
            capability + source.id
        }
    }

    init(level: AccessLevelSummary?, overview: AccessOverview, previewConflict: Bool = false, saved: @escaping () -> Void = {}) {
        self.level = level
        _impactConnectionCount = State(initialValue: level?.connectionCount ?? 0)
        _overview = State(initialValue: overview)
        self.saved = saved
        _draft = State(initialValue: AccessLevelDraft(level: level, overview: overview))
        _baseline = State(initialValue: AccessLevelDraft(level: level, overview: overview))
        _conflict = State(initialValue: previewConflict)
        _error = State(initialValue: previewConflict ? GatewayClient.Error.serverError(status: 409, body: "stale-revision") : nil)
    }

    @State var navigation = AccessFlowNavigation()
    @State var confirmExit = false
    @State var answerDetailsExpanded = false
    @State var referenceDetailsExpanded: Set<String> = []
    @State var confirmReload = false
    @AccessibilityFocusState var questionFocused: Bool
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

    var body: some View {
        Form {
            Section {
                if isEditing { Text(original.name).font(.subheadline).foregroundStyle(Theme.textSecondary) }
                Text(question).font(.title2.bold()).accessibilityAddTraits(.isHeader).accessibilityFocused($questionFocused)
                if !isEditing, let index = draft.creationSteps.firstIndex(of: current) {
                    Text("Step \(index + 1) of \(draft.creationSteps.count)").font(.subheadline).foregroundStyle(Theme.textSecondary)
                }
            }
            switch current {
            case .overview: overviewContent
            case .permissions: permissionsContent
            case .answerData: dataContent("answer")
            case .directData: dataContent("direct")
            case .directChoice: directChoiceContent
            case .future: futureContent
            case .release: releaseContent
            case .review: reviewContent
            }
            if let error, !conflict {
                Section {
                    GatewayErrorView(context: "save this access level", error: error, onRetry: {
                        navigation.step = .review
                        navigation.started = true
                    })
                }
            }
        }
        .id(current)
        .tint(Theme.accent)
        .navigationTitle(isEditing ? "Edit access level" : "New access level")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .disabled(saving || reloading)
        .interactiveDismissDisabled(changedDraft || saving || reloading)
        .onAppear { if openedClient == nil { openedClient = store.access } }
        .task(id: labelContextKey) { await resolveLabels() }
        .onChange(of: draft.name) { _, _ in nameTaken = false }
        .onChange(of: draft.rule("answer") != nil) { _, enabled in if enabled { levelInUse = false } }
        .onChange(of: current) { _, _ in questionFocused = true }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { if changedDraft { confirmExit = true } else { dismiss() } }.disabled(saving || reloading)
            }
        }
        .safeAreaInset(edge: .top) {
            if conflict {
                VStack(alignment: .leading, spacing: 8) {
                    if missingLevel {
                        Text("This level was deleted. This draft cannot be saved.").font(.headline)
                        Text("Your comparison stays available here until you leave.").font(.subheadline)
                        Button("Return to access levels") {
                            if changedDraft { confirmExit = true } else { dismiss() }
                        }.frame(minHeight: 44)
                    } else if let recoveryFailure {
                        Text(recoveryFailure as? GatewayClient.Error == .invalidResponse
                            ? "The gateway returned an unreadable response. Your draft is kept."
                            : "The latest version could not be loaded. Your draft is kept.").font(.headline)
                        Button("Try loading latest again") { confirmReload = true }.frame(minHeight: 44)
                    } else {
                        Text("This level changed elsewhere. Your draft is kept.").font(.headline)
                        Button("Review latest version…") { confirmReload = true }.frame(minHeight: 44)
                    }
                }.padding().frame(maxWidth: .infinity, alignment: .leading).background(.bar).disabled(saving || reloading)
            } else if levelInUse {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Move integrations to another access level before removing Answer.").font(.headline)
                    if original.rule("answer") != nil {
                        Button("Restore Answer access") {
                            if draft.restoreAnswer(from: original) { levelInUse = false }
                        }.frame(minHeight: 44)
                    }
                }.padding().frame(maxWidth: .infinity, alignment: .leading).background(.bar).disabled(saving || reloading)
            }
        }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 16) {
                if current != .overview, current != .permissions || isEditing {
                    Button("Back") { navigation.back(draft: draft, isEditing: isEditing) }
                        .frame(minWidth: 60, minHeight: 44)
                }
                Button(action: advance) {
                    Text(primaryTitle).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(AccessPrimaryButtonStyle())
                .disabled(primaryDisabled)
            }.padding().background(.bar).disabled(saving || reloading)
        }
        .confirmationDialog("Discard your changes?", isPresented: $confirmExit, titleVisibility: .visible) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .confirmationDialog("Replace your draft with the latest version?", isPresented: $confirmReload, titleVisibility: .visible) {
            Button("Discard draft and reload", role: .destructive) { Task { await reload() } }
            Button("Keep draft", role: .cancel) {}
        } message: { Text("Your unsaved decisions will be discarded. Review the latest settings before making changes again.") }
        .sheet(item: $filter) { route in
            NavigationStack {
                SourceFilterEditorView(
                    source: route.source,
                    levelId: draft.id,
                    capability: route.capability,
                    initialPolicy: draft.rule(route.capability)?.scopePolicies.first { $0.sourceId == route.source.id },
                    authoringEnabled: overview.sourceFilters?.enabled == true,
                    client: openedClient,
                    displayHints: scopeLabels[route.capability + ":" + route.source.id] ?? [],
                    hintsChanged: { hints in
                        let key = route.capability + ":" + route.source.id
                        scopeLabels[key] = mergingScopeLabelHints(scopeLabels[key] ?? [], hints)
                    },
                    changed: { policy in draft.setPolicy(policy, sourceId: route.source.id, capability: route.capability) }
                )
            }
        }
    }

    var question: String {
        switch current {
        case .overview: "What would you like to change?"
        case .permissions: "What can this connection do?"
        case .answerData: "What can Answer use?"
        case .directData: "What can Direct read?"
        case .directChoice: "Use the same data for Direct?"
        case .future: "Allow sources connected later?"
        case .release: "How should answers be released?"
        case .review: isEditing ? "Review your changes" : "Review and name this access level"
        }
    }

    var primaryTitle: String {
        if current == .review { return saving ? "Saving…" : "Save access level" }
        if current == .overview { return "Review changes" }
        return isEditing ? "Done" : "Continue"
    }

    var primaryDisabled: Bool {
        saving || reloading || !draft.questionIsValid(current, overview: overview, original: original)
            || (current == .overview && !changedDraft)
            || (current == .review && isEditing && !changedDraft)
            || (current == .review && (!draft.valid || conflict || !validRelease || nameProblem != nil || allSourceProblems != nil))
    }

    var validRelease: Bool {
        draft.releaseIsValid(overview: overview)
    }

    func advance() {
        guard !primaryDisabled else { return }
        if current == .review { Task { await save() }
            return
        }
        navigation.advance(draft: draft, isEditing: isEditing)
    }

    func edit(_ destination: AccessFlowStep) {
        if destination == .directData, !draft.prepareDirectEditing(authoringEnabled: overview.sourceFilters?.enabled) { return }
        navigation.open(destination, isEditing: isEditing, draft: draft)
    }

    var reviewSources: [AccessSourceInstance] {
        let rules = original.serializedRules + draft.serializedRules
        let missing = Set(rules.flatMap { $0.boundary.sourceIds + $0.scopePolicies.map(\.sourceId) })
            .subtracting(Set(overview.sources.map(\.id)))
        return overview.sources + missing.sorted().map { AccessSourceInstance(id: $0, name: "Unavailable saved account", available: false) }
    }

    func accountDecision(_ value: AccessLevelDraft, _ capability: String, _ sourceId: String) -> AccessAccountDecision {
        AccessAccountDecision(draft: value, capability: capability, sourceId: sourceId, knownIds: overview.availableSourceIds)
    }

    func accountSummary(_ value: AccessLevelDraft, _ capability: String, _ source: AccessSourceInstance) -> String {
        let decision = accountDecision(value, capability, source.id)
        guard decision.capabilityEnabled else { return "Capability not allowed" }
        guard decision.allowed else { return "Not shared" }
        guard let rule = value.serializedRules.first(where: { $0.capability == capability }) else { return "Not shared" }
        return restrictionSummary(rule, source.id)
    }

    func restrictionSummary(_ rule: AccessGrantRule, _ sourceId: String) -> String {
        guard let policy = rule.scopePolicies.first(where: { $0.sourceId == sourceId }) else { return "All content" }
        return accessRestrictionSummary(policy, hints: scopeLabels[rule.capability + ":" + sourceId] ?? [])
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

    func resolveLabels() async {
        let context = labelContextKey
        if labelCredential != context.credential { scopeLabels = [:]
            labelCredential = context.credential
        }
        guard let client = try? (openedClient ?? store.access)?.authorized(for: store.access) else { return }
        for policy in context.policies.sorted(by: { ($0.audience.capability + $0.sourceId) < ($1.audience.capability + $1.sourceId) }) {
            guard !Task.isCancelled else { return }
            do {
                let preview = try await client.scopePreview(policy)
                guard !Task.isCancelled, store.access?.baseURL == client.baseURL, store.access?.token == client.token,
                      preview.sourceId == policy.sourceId else { return }
                let key = policy.audience.capability + ":" + policy.sourceId
                scopeLabels[key] = mergingScopeLabelHints(scopeLabels[key] ?? [], preview.items)
            } catch { /* Saved labels remain readable when optional lookup fails. */ }
        }
    }

    func canToggleSource(_ sourceId: String, allowed: Bool, rule: AccessGrantRule) -> Bool {
        var selection = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
        if selection.mode == .all { selection.setMode(.denylist, knownSourceIds: overview.availableSourceIds) }
        selection.setAllowed(!allowed, sourceId: sourceId)
        return draft.canSetBoundary(
            selection.boundary(knownSourceIds: overview.availableSourceIds),
            capability: rule.capability,
            authoringEnabled: overview.sourceFilters?.enabled
        )
    }

    func sources(for rule: AccessGrantRule) -> [AccessSourceInstance] {
        let referenced = Set(rule.boundary.sourceIds + rule.scopePolicies.map(\.sourceId))
        let missing = referenced.subtracting(Set(overview.sources.map(\.id))).sorted().map {
            AccessSourceInstance(id: $0, name: "Unavailable saved account", available: false)
        }
        return overview.sources + missing
    }

    func sourceProblem(_ capability: String) -> String? {
        draft.sourceProblem(capability, overview: overview, original: original)
    }

    var allSourceProblems: String? {
        ["answer", "direct"].compactMap { sourceProblem($0) }.first
    }

    var nameProblem: String? {
        if nameTaken { return "This name was just taken. Choose another." }
        return accessLevelNameProblem(draft.name, id: draft.id, levels: overview.levels)
    }

    func save() async {
        guard current == .review, !saving, !reloading, !conflict, draft.valid, validRelease, nameProblem == nil, allSourceProblems == nil,
              !isEditing || changedDraft else { return }
        guard let client = openedClient, store.access?.baseURL == client.baseURL, store.access?.token == client.token else {
            error = GatewayClient.Error.unauthorized
            return
        }
        saving = true
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
            guard store.access?.baseURL == client.baseURL, store.access?.token == client.token else { return }
            saved()
            dismiss()
        } catch {
            guard store.access?.baseURL == client.baseURL, store.access?.token == client.token else { return }
            switch accessLevelMutationCode(error) {
            case "level-name-taken": nameTaken = true
                self.error = nil
            case "level-in-use": levelInUse = true
                self.error = nil
            default: self.error = error
            }
            conflict = error.isAccessRevisionConflict
        }
    }

    func reload() async {
        guard !saving, !reloading else { return }
        reloading = true
        defer { reloading = false }
        guard let client = openedClient, store.access?.baseURL == client.baseURL, store.access?.token == client.token else {
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
            guard store.access?.baseURL == client.baseURL, store.access?.token == client.token else { return }
            overview = latest
            draft = AccessLevelDraft(level: level, overview: latest)
            baseline = draft
            impactConnectionCount = level.connectionCount
            recoveryFailure = nil
            missingLevel = false
            levelInUse = false
            conflict = false
            navigation = AccessFlowNavigation(step: .overview, started: true)
            error = nil
        } catch { recoveryFailure = error }
    }
}

extension Error {
    fileprivate var isAccessRevisionConflict: Bool {
        if let gatewayError = self as? GatewayClient.Error,
           case .serverError(let status, let body) = gatewayError {
            return status == 409 && (body.contains("stale") || body.contains("revision"))
        }
        return false
    }
}

#if DEBUG
#Preview("New access level") {
    NavigationStack { AccessLevelEditorView(level: nil, overview: PreviewMocks.accessOverview) }.environment(AppStore.preview())
}

#Preview("Saved restrictions with authoring unavailable") {
    let overview = PreviewMocks.scopeReadOnlyOverview
    NavigationStack { AccessLevelEditorView(level: overview.levels[0], overview: overview) }.environment(AppStore.preview())
}
#endif

#endif
