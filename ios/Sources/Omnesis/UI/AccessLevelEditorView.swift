// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct AccessLevelEditorView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let level: AccessLevelSummary?
    @State private var overview: AccessOverview
    let saved: () -> Void
    @State private var draft: AccessLevelDraft
    @State private var openedClient: AccessClient?
    @State private var saving = false
    @State private var error: Error?
    @State private var conflict = false
    @State private var filter: FilterRoute?
    private struct FilterRoute: Identifiable {
        let source: AccessSourceInstance
        let capability: String
        var id: String {
            capability + source.id
        }
    }

    init(level: AccessLevelSummary?, overview: AccessOverview, previewConflict: Bool = false, saved: @escaping () -> Void = {}) {
        self.level = level
        _overview = State(initialValue: overview)
        self.saved = saved
        _draft = State(initialValue: AccessLevelDraft(level: level, overview: overview))
        _conflict = State(initialValue: previewConflict)
        _error = State(initialValue: previewConflict ? GatewayClient.Error.serverError(status: 409, body: "stale-revision") : nil)
    }

    var body: some View {
        Form {
            Section { TextField("Access level name", text: $draft.name) }
            Section("Permissions") {
                ForEach(["answer", "direct", "notes"], id: \.self) { capability in
                    Toggle(capability.capitalized, isOn: Binding(
                        get: { draft.rule(capability) != nil },
                        set: { draft.setEnabled(capability, $0, overview: overview) }
                    ))
                }
                if draft.rule("direct") != nil, draft.rule("answer") != nil {
                    if level == nil {
                        Toggle(
                            "Direct: same as Answer",
                            isOn: Binding(
                                get: { draft.directSameAsAnswer },
                                set: { draft.setDirectSameAsAnswer($0, authoringEnabled: overview.sourceFilters?.enabled) }
                            )
                        )
                        .disabled(!draft.directSameAsAnswer && !draft.canCopyAnswer(authoringEnabled: overview.sourceFilters?.enabled))
                    } else {
                        Button("Copy Answer settings to Direct") { draft.copyAnswer(authoringEnabled: overview.sourceFilters?.enabled) }
                            .disabled(!draft.canCopyAnswer(authoringEnabled: overview.sourceFilters?.enabled))
                        Text("Copies sources and filters once. Later changes stay separate.").font(.caption)
                    }
                }
            }
            if overview.sourceFilters?.enabled != true, draft.rules.contains(where: { !$0.scopePolicies.isEmpty }) {
                Section {
                    Text("Saved filters are read-only while filter editing is unavailable. You can still revoke capabilities.")
                        .font(.footnote)
                }
            }
            ForEach(["answer", "direct"], id: \.self) { capability in
                if let rule = draft.rule(capability), !(capability == "direct" && draft.directSameAsAnswer && draft.rule("answer") != nil) {
                    sourceSection(capability: capability, rule: rule)
                }
            }
            if let rule = draft.rule("answer") {
                Section("Privacy for Answer") {
                    Toggle("Review answers with a privacy policy", isOn: Binding(
                        get: { if case .reviewed = rule.release { true } else { false } },
                        set: { reviewed in
                            draft.setRule(rule.replacing(release: reviewed
                                    ? .reviewed(policyFamilyId: overview.defaultPolicyFamilyId ?? overview.policyFamilies.first?.id ?? "")
                                    : .unreviewed))
                        }
                    ))
                    if case .reviewed(let family) = rule.release {
                        Picker(
                            "Policy",
                            selection: Binding(
                                get: { family },
                                set: { draft.setRule(rule.replacing(release: .reviewed(policyFamilyId: $0))) }
                            )
                        ) {
                            ForEach(overview.policyFamilies) { Text($0.name).tag($0.id) }
                        }
                    } else { Text("No privacy reviewer checks these answers.").foregroundStyle(Theme.warning) }
                }
            }
            if let level = overview.levels
                .first(where: { $0.id == draft.id }) {
                Section { Text("Saving changes access for \(level.connectionCount) connections using this level.") }
            }
            if let error {
                Section {
                    Text(conflict ? "This level changed on the gateway. Your draft is retained. Reload and review before saving." :
                        GatewayErrorView.classify(error).title)
                        .foregroundStyle(Theme.danger)
                    if conflict { Button("Reload latest") { Task { await reload() } } }
                }
            }
        }
        .navigationTitle(level == nil ? "New access level" : "Edit access level")
        .onAppear { if openedClient == nil { openedClient = store.access } }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .disabled(!draft.valid || saving || conflict)
            }
        }
        .sheet(item: $filter) { route in
            NavigationStack {
                SourceFilterEditorView(
                    source: route.source,
                    levelId: draft.id,
                    capability: route.capability,
                    initialPolicy: draft.rule(route.capability)?.scopePolicies.first { $0.sourceId == route.source.id },
                    authoringEnabled: overview.sourceFilters?.enabled == true
                ) { policy in
                    draft.setPolicy(policy, sourceId: route.source.id, capability: route.capability)
                }
            }
        }
    }

    private func sourceSection(capability: String, rule: AccessGrantRule) -> some View {
        Section("\(capability.capitalized) sources") {
            Picker("Source list", selection: Binding(get: { rule.boundary.mode }, set: { mode in
                var selection = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
                selection.setMode(mode, knownSourceIds: overview.availableSourceIds)
                draft.setBoundary(
                    selection.boundary(knownSourceIds: overview.availableSourceIds),
                    capability: capability,
                    authoringEnabled: overview.sourceFilters?.enabled
                )
            })) {
                Text("All sources").tag(AccessSourceMode.all).disabled(!canSetMode(.all, rule: rule))
                Text("Only selected").tag(AccessSourceMode.allowlist).disabled(!canSetMode(.allowlist, rule: rule))
                Text("All except blocked").tag(AccessSourceMode.denylist).disabled(!canSetMode(.denylist, rule: rule))
            }
            ForEach(sources(for: rule)) { source in
                let allowed = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
                    .allowedSourceIds.contains(source.id)
                Toggle(source.name, isOn: Binding(get: { allowed }, set: { enabled in
                    var selection = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
                    if selection.mode == .all { selection.setMode(.denylist, knownSourceIds: overview.availableSourceIds) }
                    selection.setAllowed(enabled, sourceId: source.id)
                    draft.setBoundary(
                        selection.boundary(knownSourceIds: overview.availableSourceIds),
                        capability: capability,
                        authoringEnabled: overview.sourceFilters?.enabled
                    )
                })).disabled(!source.available || !canToggleSource(source.id, allowed: allowed, rule: rule))
                if accessFilterEntryVisible(
                    authoringEnabled: overview.sourceFilters?.enabled,
                    sourceAllowed: allowed,
                    hasDeclaration: source.scopes != nil,
                    hasSavedPolicy: rule.scopePolicies.contains { $0.sourceId == source.id }
                ) {
                    Button {
                        filter = FilterRoute(source: source, capability: capability)
                    } label: {
                        HStack { Text("Filter \(source.name)")
                            Spacer()
                            Text(rule.scopePolicies.contains { $0.sourceId == source.id } ? "Filtered" : "All content")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private func canToggleSource(_ sourceId: String, allowed: Bool, rule: AccessGrantRule) -> Bool {
        var selection = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
        if selection.mode == .all { selection.setMode(.denylist, knownSourceIds: overview.availableSourceIds) }
        selection.setAllowed(!allowed, sourceId: sourceId)
        return draft.canSetBoundary(
            selection.boundary(knownSourceIds: overview.availableSourceIds),
            capability: rule.capability,
            authoringEnabled: overview.sourceFilters?.enabled
        )
    }

    private func canSetMode(_ mode: AccessSourceMode, rule: AccessGrantRule) -> Bool {
        var selection = AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: overview.availableSourceIds)
        selection.setMode(mode, knownSourceIds: overview.availableSourceIds)
        return draft.canSetBoundary(
            selection.boundary(knownSourceIds: overview.availableSourceIds),
            capability: rule.capability,
            authoringEnabled: overview.sourceFilters?.enabled
        )
    }

    private func sources(for rule: AccessGrantRule) -> [AccessSourceInstance] {
        let missingPolicies = rule.scopePolicies.filter { policy in
            !overview.sources.contains { $0.id == policy.sourceId }
        }
        let missing = missingPolicies.map {
            AccessSourceInstance(id: $0.sourceId, name: $0.sourceId, available: false)
        }
        return overview.sources + missing
    }

    private func save() async {
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
        } catch { self.error = error
            conflict = error.isAccessRevisionConflict
        }
    }

    private func reload() async {
        guard let client = openedClient, store.access?.baseURL == client.baseURL, store.access?.token == client.token else {
            error = GatewayClient.Error.unauthorized
            return
        }
        do {
            let latest = try await client.overview()
            guard let level = latest.levels.first(where: { $0.id == draft.id }) else { return }
            guard store.access?.baseURL == client.baseURL, store.access?.token == client.token else { return }
            overview = latest
            draft = AccessLevelDraft(level: level, overview: latest)
            conflict = false
            error = nil
        } catch { self.error = error }
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
