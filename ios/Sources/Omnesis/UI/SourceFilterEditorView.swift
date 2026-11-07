// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct SourceFilterEditorView: View {
    @Environment(AppStore.self) var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let source: AccessSourceInstance
    let authoringEnabled: Bool
    let changed: (ScopePolicy?) -> Void
    let displayHints: [ScopePreview.Item]
    let hintsChanged: ([ScopePreview.Item]) -> Void
    let parentClient: AccessClient?
    @State var labelHints: [ScopePreview.Item] = []
    @State var policy: ScopePolicy
    @State var preview: ScopePreview?
    @State var previewedPolicy: ScopePolicy?
    @State var openedClient: AccessClient?
    @State var error: Error?
    @State var loading = false
    @State private var previewGeneration = 0
    @State private var picking = false
    @State private var retainedRefs: [ScopeRef] = []
    var refs: [ScopeRef] {
        policy.rules.first?.match ?? []
    }

    private var writable: Bool {
        authoringEnabled && policy.editable
    }

    private var previewKey: ScopePolicy {
        policy
    }

    init(
        source: AccessSourceInstance,
        levelId: String,
        capability: String,
        initialPolicy: ScopePolicy?,
        authoringEnabled: Bool,
        preview: ScopePreview? = nil,
        client: AccessClient? = nil,
        displayHints: [ScopePreview.Item] = [],
        hintsChanged: @escaping ([ScopePreview.Item]) -> Void = { _ in },
        changed: @escaping (ScopePolicy?) -> Void
    ) {
        _openedClient = State(initialValue: client)
        self.parentClient = client
        self.displayHints = displayHints
        self.hintsChanged = hintsChanged
        _labelHints = State(initialValue: mergingScopeLabelHints(displayHints, preview?.sourceId == source.id ? preview?.items ?? [] : []))
        self.initialPolicy = initialPolicy
        self.capability = capability
        _mode = State(initialValue: ScopeFilterMode(
            policy: initialPolicy ?? .empty(sourceId: source.id, levelId: levelId, capability: capability),
            hasSavedPolicy: initialPolicy != nil
        ))
        self.source = source
        self.authoringEnabled = authoringEnabled
        self.changed = changed
        var initial = initialPolicy ?? .empty(sourceId: source.id, levelId: levelId, capability: capability)
        initial.audience = .init(accessLevel: levelId, capability: capability)
        _policy = State(initialValue: initial)
        _previewedPolicy = State(initialValue: preview == nil ? nil : initial)
        _preview = State(initialValue: preview)
    }

    @State private var step: ScopeFilterStep = .mode
    @State private var mode: ScopeFilterMode
    @State var pickerSession = ScopePickerSession()
    @State private var confirmExit = false
    private let initialPolicy: ScopePolicy?
    private let capability: String
    private var dirty: Bool {
        scopeFilterHasChanges(initial: initialPolicy, policy: policy, mode: mode)
    }

    private var commit: ScopeFilterCommit {
        ScopeFilterCommitState(
            mode: mode,
            policy: policy,
            sourceId: source.id,
            authoringEnabled: authoringEnabled,
            preview: preview,
            previewedPolicy: previewedPolicy,
            loading: loading,
            hasError: error != nil
        ).decision
    }

    private var preparationStatuses: [ScopeKindReadiness] {
        mode == .all ? [] : scopePreparationStatuses(policy: policy, readiness: preview?.readiness ?? source.scopeReadiness ?? [])
    }

    private var canApply: Bool {
        commit != .blocked
    }

    var body: some View {
        Form {
            Section {
                Text("\(capability.capitalized) · \(accessSourceDisplayName(source))").font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                Text(!writable ? "Saved restriction" : step == .mode ? "What should be shared?" : step == .matches ? "Choose what matches" :
                    "Review this restriction")
                    .font(.title2.bold()).accessibilityAddTraits(.isHeader)
                if !writable { Text("This saved restriction remains active. Editing is unavailable.") }
                if writable, step != .review, mode != .all, !refs.isEmpty {
                    Text(accessRestrictionSummary(mode.applying(to: policy), hints: visibleLabelHints)).font(.subheadline)
                }
            }
            if step == .mode {
                if writable {
                    Section {
                        modeOption(
                            .all,
                            title: "All content",
                            detail: "Remove the restriction. All content in this account becomes available."
                        )
                        modeOption(.only, title: "Only matching content", detail: "Share content that matches any selected item.")
                        modeOption(
                            .except,
                            title: "Everything except matching content",
                            detail: "Hide content that matches any selected item."
                        )
                    }.disabled(!writable)
                }
                if !writable { Section { Text(accessRestrictionSummary(initialPolicy, hints: visibleLabelHints))
                    ForEach(Array(refs.enumerated()), id: \.offset) { index, ref in selectedItem(index, ref: ref) }
                } header: { Text("Saved restriction").foregroundStyle(Theme.textSecondary) } }
            } else if step == .matches {
                Section {
                    if writable { Button("Add matches…") { picking = true }.frame(minHeight: 44) }
                    if refs
                        .isEmpty {
                        Text(mode == .only ? "No content will be shared until you add a match." :
                            "No exceptions selected. All content will be shared.").font(.subheadline)
                    }
                    DisclosureGroup("View selected matches (\(refs.count))") {
                        ForEach(Array(refs.enumerated()), id: \.offset) { index, ref in selectedItem(index, ref: ref) }
                    }
                }
                Section {
                    Text(
                        "Content matching any selection \(mode == .only ? "is shared" : "is hidden"). "
                            + "Other content \(mode == .only ? "stays hidden" : "remains shared")."
                    )
                    .font(.subheadline)
                }
            } else {
                Section {
                    Text(mode == .all ? "All content · this removes the account’s restriction" : accessRestrictionSummary(
                        policy,
                        hints: visibleLabelHints
                    ))
                    if policy.rules.first?.match
                        .contains(where: { ref in source.scopes?.items.first { $0.kind == ref.kind }?.picker == "tree" }) == true {
                        Text("Selected folders include descendants and files added later. Moving content can change whether it matches.")
                            .font(.subheadline)
                    }
                }
                ForEach(Array(preparationStatuses.enumerated()), id: \.offset) { _, item in
                    Section {
                        Text(item.message ?? "Preparing \(item.kind) filters")
                        if let processed = item.processed {
                            Text("\(processed) processed\(item.pending.map { ", \($0) pending" } ?? "")")
                        }
                        ForEach(item.behindCollectors ?? [], id: \.deviceId) { Text("Update collector: \($0.name)") }
                        Button("Check again") { Task { await refresh() } }.frame(minHeight: 44).disabled(loading)
                    }
                }
                if !policy.withinLimits { Section { Text("Choose at most 256 identifiers or items.").foregroundStyle(Theme.danger) } }
                if mode != .all, let preview, preview.sourceId != source.id {
                    Section { Text("This preview belongs to another account. Refresh before applying.")
                        Button("Refresh preview") { Task { await refresh() } }.frame(minHeight: 44)
                    }
                }
                if loading, mode != .all { Section { ProgressView("Checking current content…") } }
                if let error, mode != .all {
                    Section {
                        Text(scopePreviewFailureMessage(error, classifiedFallbackTitle: GatewayErrorView.classify(error).title))
                        if scopePreviewCanRetry(error) {
                            Button("Retry preview") { Task { await refresh() } }.frame(minHeight: 44).disabled(loading)
                        }
                    }
                }
                if let preview, previewedPolicy == policy, preview.sourceId == source.id, !loading, error == nil, mode != .all {
                    Section {
                        LabeledContent("Allowed") { Text("\(preview.visible)").foregroundStyle(Theme.textPrimary) }
                        LabeledContent("Hidden") { Text("\(preview.hidden)").foregroundStyle(Theme.textPrimary) }
                        LabeledContent("Unknown · hidden") { Text("\(preview.unknown)").foregroundStyle(Theme.textPrimary) }
                        Text("Content with uncertain required facts stays hidden.").font(.subheadline)
                        DisclosureGroup("Examples") {
                            ForEach(preview.samples, id: \.documentId) { sample in
                                VStack(alignment: .leading) {
                                    Text(sample.title)
                                    Text(sample.unknown ? "Unknown · hidden" : sample.visible ? "Allowed" : "Hidden").font(.subheadline)
                                        .foregroundStyle(Theme.textSecondary)
                                }
                            }
                        }
                    } header: {
                        Text(policy.readyToSave(preview.readiness) ? "Current preview" : "Preview during preparation")
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                if let preview, previewedPolicy == policy, !loading, error == nil, writable, mode != .all {
                    ForEach(Array((preview.identifierProposals ?? []).enumerated()), id: \.offset) { _, proposal in
                        Section {
                            DisclosureGroup("Additional identifiers for \(proposal.label)") {
                                Text(proposal.identifiers.map(\.value).joined(separator: ", "))
                                Button("Include these identifiers") {
                                    guard policy.rules[0].match.indices.contains(proposal.itemIndex),
                                          policy.rules[0].match[proposal.itemIndex].kind == "participant" else { return }
                                    let old = policy.rules[0].match[proposal.itemIndex].identifiers ?? []
                                    policy.rules[0].match[proposal.itemIndex].identifiers = Array(Set(old + proposal.identifiers))
                                        .sorted { $0.value < $1.value }
                                }.frame(minHeight: 44)
                            }
                        }
                    }
                }
            }
        }
        .onAppear { if openedClient == nil { openedClient = store.access } }
        .tint(Theme.accent)
        .navigationTitle("\(capability.capitalized) restriction")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(dirty)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if dirty { confirmExit = true } else { dismiss() } } } }
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 16) {
                if step != .mode {
                    Button("Back") { step = step == .review && mode != .all ? .matches : .mode }
                        .frame(minWidth: 60, minHeight: 44)
                }
                Button(action: advance) {
                    Text(primaryTitle).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(AccessPrimaryButtonStyle())
                .disabled(!writable || (step == .review && !canApply))
            }.padding().background(.bar)
        }
        .alert("Discard restriction changes?", isPresented: $confirmExit) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .onChange(of: store.access?.baseURL) { _, _ in pickerSession = .init()
            picking = false
            labelHints = []
            previewedPolicy = nil
            error = GatewayClient.Error.unauthorized
        }
        .onChange(of: store.access?.token) { _, _ in pickerSession = .init()
            picking = false
            labelHints = []
            previewedPolicy = nil
            error = GatewayClient.Error.unauthorized
        }
        .onChange(of: displayHints) { _, hints in
            if (try? openedClient?.authorized(for: store.access)) != nil { labelHints = mergingScopeLabelHints(labelHints, hints) }
        }
        .task(id: step == .review ? nil : policy) { if step != .review { await resolveDisplayHints() } }
        .onChange(of: policy) { _, _ in previewedPolicy = nil }
        .id(step)
        .task(id: step == .review && mode != .all ? previewKey : nil) { if step == .review, mode != .all { await refresh() } }
        .sheet(isPresented: $picking) {
            NavigationStack {
                SourceFilterPickerView(
                    source: source,
                    capability: capability,
                    client: openedClient,
                    selectedRefs: refs,
                    session: pickerSession,
                    sessionChanged: { adoptPickerSession($0) },
                    selected: { ref in
                        policy.appendMatchIfMissing(ref)
                    }
                )
            }
        }
    }

    private var primaryTitle: String {
        guard step == .review else { return "Continue" }
        if mode == .all { return "Apply all content" }
        return mode == .only && refs.isEmpty ? "Block all content" : "Apply restriction"
    }

    private func advance() {
        if step == .review {
            finish()
        } else if step == .mode {
            if mode == .all {
                retainedRefs = refs
            } else if refs.isEmpty, !retainedRefs.isEmpty {
                policy.rules[0].match = retainedRefs
            }
            policy = mode.applying(to: policy)
            step = mode == .all ? .review : .matches
        } else {
            step = .review
        }
    }

    private func modeOption(_ value: ScopeFilterMode, title: String, detail: String) -> some View {
        Button { mode = value } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: mode == value ? "checkmark.circle.fill" : "circle").accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).foregroundStyle(Color.primary)
                    Text(detail).font(.subheadline).foregroundStyle(Theme.textSecondary)
                }
            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.vertical, 8)
        }.accessibilityAddTraits(mode == value ? .isSelected : [])
    }

    private func finish() {
        guard case .apply(let value) = commit else { return }
        guard let client = openedClient, store.access?.baseURL == client.baseURL, store.access?.token == client.token else {
            error = GatewayClient.Error.unauthorized
            return
        }
        hintsChanged(visibleLabelHints)
        changed(value)
        dismiss()
    }

    @ViewBuilder
    private func selectedItem(_ index: Int, ref: ScopeRef) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 12) {
                itemDetails(index, ref: ref)
                removeItem(index)
            }
        } else {
            HStack {
                itemDetails(index, ref: ref)
                Spacer()
                removeItem(index)
            }
        }
    }

    @ViewBuilder
    private func removeItem(_ index: Int) -> some View {
        if writable {
            Button("Remove", role: .destructive) { policy.rules[0].match.remove(at: index) }.buttonStyle(.borderless)
        }
    }

    private func refresh() async {
        guard policy.editable else { return }
        if openedClient == nil { openedClient = store.access }
        guard let client = openedClient, store.access?.baseURL == client.baseURL, store.access?.token == client.token else {
            if openedClient != nil { error = GatewayClient.Error.unauthorized }
            return
        }
        let requestedPolicy = policy
        previewGeneration += 1
        let generation = previewGeneration
        previewedPolicy = nil
        loading = true
        defer { if generation == previewGeneration { loading = false } }
        do {
            let value = try await client.scopePreview(requestedPolicy)
            try Task.checkCancellation()
            guard store.access?.baseURL == client.baseURL, store.access?.token == client.token else { return }
            guard policy == requestedPolicy, generation == previewGeneration else { return }
            guard value.sourceId == source.id else { error = GatewayClient.Error.invalidResponse
                return
            }
            previewedPolicy = requestedPolicy
            preview = value
            labelHints = mergingScopeLabelHints(labelHints, value.items)
            error = nil
        } catch is CancellationError {} catch {
            guard !Task.isCancelled, policy == requestedPolicy, generation == previewGeneration else { return }
            self.error = error
        }
    }
}

#if DEBUG
#Preview("Choose a restriction") {
    NavigationStack {
        SourceFilterEditorView(
            source: PreviewMocks.scopeEditorSource,
            levelId: "scope-level",
            capability: "answer",
            initialPolicy: PreviewMocks.scopeEditorPolicy,
            authoringEnabled: true,
            preview: PreviewMocks.scopeEditorPreview
        ) { _ in }
    }.environment(AppStore.preview())
}

#Preview("Read-only restriction") {
    NavigationStack {
        SourceFilterEditorView(
            source: PreviewMocks.scopeEditorSource,
            levelId: "scope-level",
            capability: "answer",
            initialPolicy: PreviewMocks.scopeEditorPolicy,
            authoringEnabled: false,
            preview: PreviewMocks.scopePreparingPreview
        ) { _ in }
    }.environment(AppStore.preview())
}
#endif

#endif
