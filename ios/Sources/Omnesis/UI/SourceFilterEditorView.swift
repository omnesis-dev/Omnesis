// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct SourceFilterEditorView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let source: AccessSourceInstance
    let authoringEnabled: Bool
    let changed: (ScopePolicy?) -> Void
    @State private var policy: ScopePolicy
    @State private var preview: ScopePreview?
    @State private var previewedPolicy: ScopePolicy?
    @State private var openedClient: AccessClient?
    @State private var error: Error?
    @State private var loading = false
    @State private var picking = false
    private var refs: [ScopeRef] {
        policy.rules.first?.match ?? []
    }

    private var writable: Bool {
        authoringEnabled && policy.editable
    }

    private var ready: Bool {
        policy.readyToSave(preview?.readiness ?? source.scopeReadiness ?? [])
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
        changed: @escaping (ScopePolicy?) -> Void
    ) {
        self.source = source
        self.authoringEnabled = authoringEnabled
        self.changed = changed
        var initial = initialPolicy ?? .empty(sourceId: source.id, levelId: levelId, capability: capability)
        initial.audience = .init(accessLevel: levelId, capability: capability)
        _policy = State(initialValue: initial)
        _previewedPolicy = State(initialValue: preview == nil ? nil : initial)
        _preview = State(initialValue: preview)
    }

    var body: some View {
        Form {
            Section {
                Text(source.name).font(.headline)
                if !writable { Text("This saved restriction remains active. Filter editing is unavailable on this gateway.") }
                if policy.editable {
                    if dynamicTypeSize.isAccessibilitySize {
                        modePicker.pickerStyle(.inline)
                    } else {
                        modePicker
                    }
                    Text(refs
                        .isEmpty ?
                        (policy.otherwise == "share" ? "Shares all content from this source." : "Shares nothing from this source.") :
                        (policy.rules[0].action == "share" ? "Shares content matching any item in this list." :
                            "Shares everything except content matching any item in this list."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("Selected items") {
                ForEach(Array(refs.enumerated()), id: \.offset) { index, ref in
                    selectedItem(index, ref: ref)
                }
                if writable { Button("Add item") { picking = true } }
            }
            ForEach(Array((preview?.readiness ?? source.scopeReadiness ?? []).enumerated()), id: \.offset) { _, item in
                if !item.ready || !(item.behindCollectors ?? []).isEmpty {
                    Section {
                        Text(item.message ?? "Preparing \(item.kind) filters")
                        if let processed = item
                            .processed { Text("\(processed) processed\(item.pending.map { ", \($0) pending" } ?? "")").font(.caption) }
                        ForEach(item.behindCollectors ?? [], id: \.deviceId) { Text("Update collector: \($0.name)").font(.caption) }
                    }
                }
            }
            if let preview {
                Section("Preview") {
                    LabeledContent("Visible", value: "\(preview.visible)")
                    LabeledContent("Hidden", value: "\(preview.hidden)")
                    LabeledContent("Unknown, hidden", value: "\(preview.unknown)")
                    Text("Documents with uncertain required facts stay hidden.").font(.caption)
                    ForEach(preview.samples, id: \.documentId) { sample in
                        VStack(alignment: .leading) {
                            Text(sample.title)
                            Text(sample.unknown ? "Unknown · hidden" : sample.visible ? "Visible" : "Hidden").font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if writable, previewedPolicy == policy, !loading {
                    ForEach(Array((preview.identifierProposals ?? []).enumerated()), id: \.offset) { _, proposal in
                        let count = proposal.identifiers.count
                        Section {
                            Text("Omnesis knows \(count) more \(count == 1 ? "address" : "addresses") for \(proposal.label).")
                            Text(proposal.identifiers.map(\.value).joined(separator: ", ")).font(.caption)
                            Button("Add these addresses") {
                                guard policy.rules[0].match.indices.contains(proposal.itemIndex),
                                      policy.rules[0].match[proposal.itemIndex].kind == "participant" else { return }
                                let old = policy.rules[0].match[proposal.itemIndex].identifiers ?? []
                                policy.rules[0].match[proposal.itemIndex].identifiers = Array(Set(old + proposal.identifiers))
                                    .sorted { $0.value < $1.value }
                            }
                        }
                    }
                }
            }
            if !policy
                .withinLimits { Section { Text("A filter can contain at most 256 identifiers or items.").foregroundStyle(Theme.danger) } }
            if loading { Section { ProgressView("Updating preview…") } }
            if let error { Section { Text(GatewayErrorView.classify(error).title)
                Button("Retry preview") { Task { await refresh() } }
            } }
            if writable { Section { Button("Remove filter", role: .destructive) { finish(nil) } } }
        }
        .navigationTitle("Source filter")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { finish(policy) }
                    .disabled(!writable || !ready || !policy.withinLimits || previewedPolicy != policy || loading || error != nil)
            }
        }
        .task(id: previewKey) { await refresh() }
        .sheet(isPresented: $picking) {
            NavigationStack { SourceFilterPickerView(source: source) { ref in
                if !refs.contains(ref) { policy.rules[0].match.append(ref) }
            }
            }
        }
    }

    private func finish(_ value: ScopePolicy?) {
        changed(value)
        dismiss()
    }

    private var modePicker: some View {
        Picker("Share", selection: Binding(get: { policy.rules[0].action }, set: { action in
            policy.rules[0].action = action
            policy.otherwise = action == "share" ? "hide" : "share"
        })) {
            Text("Only these").tag("share")
            Text("Everything except these").tag("hide")
        }.disabled(!writable)
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

    private func itemDetails(_ index: Int, ref: ScopeRef) -> some View {
        VStack(alignment: .leading) {
            Text(previewItem(index)?.label ?? ref.label ?? ref.id ?? "Person")
            if let identifiers = ref.identifiers {
                Text(identifiers.map(\.value).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
            }
            if let item = previewItem(index) {
                Text(item.missing == true ? "No longer available · saved ID retained" : "\(item.count) matching documents")
                    .font(.caption)
            }
        }
    }

    @ViewBuilder
    private func removeItem(_ index: Int) -> some View {
        if writable {
            Button("Remove", role: .destructive) { policy.rules[0].match.remove(at: index) }.buttonStyle(.borderless)
        }
    }

    private func previewItem(_ index: Int) -> ScopePreview.Item? {
        guard previewedPolicy == policy, let items = preview?.items, items.indices.contains(index) else { return nil }
        return items[index]
    }

    private func refresh() async {
        guard policy.editable else { return }
        if openedClient == nil { openedClient = store.access }
        guard let client = openedClient, store.access?.baseURL == client.baseURL, store.access?.token == client.token else {
            if openedClient != nil { error = GatewayClient.Error.unauthorized }
            return
        }
        let requestedPolicy = policy
        loading = true
        defer { loading = false }
        do {
            let value = try await client.scopePreview(requestedPolicy)
            try Task.checkCancellation()
            guard store.access?.baseURL == client.baseURL, store.access?.token == client.token else { return }
            guard policy == requestedPolicy else { return }
            previewedPolicy = requestedPolicy
            preview = value
            error = nil
        } catch is CancellationError {} catch {
            guard !Task.isCancelled, policy == requestedPolicy else { return }
            self.error = error
        }
    }
}

#if DEBUG
#Preview("Filter") {
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

#Preview("Preparing") {
    NavigationStack {
        SourceFilterEditorView(
            source: PreviewMocks.scopeEditorSource,
            levelId: "scope-level",
            capability: "answer",
            initialPolicy: PreviewMocks.scopeEditorPolicy,
            authoringEnabled: true,
            preview: PreviewMocks.scopePreparingPreview
        ) { _ in }
    }.environment(AppStore.preview())
}
#endif

#endif
