// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct SourceFilterPickerView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let source: AccessSourceInstance
    let selected: (ScopeRef) -> Void
    @State private var kind = ""
    @State private var query = ""
    @State private var parentId: String?
    @State private var ancestors: [ScopeOption] = []
    @State private var options: ScopeOptions?
    @State private var openedClient: AccessClient?
    @State private var error: Error?
    @State private var loading = false
    @State private var identifierType = ""
    @State private var typed = ""
    private var searchKey: String {
        "\(kind):\(query):\(parentId ?? "")"
    }

    private var declaration: SourceScopes
        .Item? {
        source.scopes?.items.first { $0.kind == kind } ?? options?.scopes.items.first { $0.kind == kind }
    }

    private var ready: Bool {
        (options?.readiness ?? source.scopeReadiness ?? []).first { $0.kind == kind }?.ready == true
    }

    private var typedId: ScopeIdentifier? {
        guard declaration?.identifiers?.contains(identifierType) == true else { return nil }
        return scopeTypedIdentifier(typed, type: identifierType)
    }

    init(source: AccessSourceInstance, options: ScopeOptions? = nil, typedInput: String = "", selected: @escaping (ScopeRef) -> Void) {
        self.source = source
        self.selected = selected
        _options = State(initialValue: options)
        _typed = State(initialValue: typedInput)
    }

    var body: some View {
        List {
            Picker("Item type", selection: $kind) {
                ForEach(source.scopes?.items ?? options?.scopes.items ?? [], id: \.kind) { item in
                    Text(item.noun?.many ?? "People").tag(item.kind)
                }
            }
            TextField("Search", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
            if !ready {
                Text(options?.readiness.first { $0.kind == kind }?
                    .message ?? "These facts are still being prepared. Try again after preparation finishes.")
            }
            if kind == "participant" {
                Section("Type an identifier") {
                    Picker("Identify by", selection: $identifierType) {
                        ForEach(declaration?.identifiers ?? [], id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    TextField(
                        identifierType == "phone" ? "International phone number" : identifierType == "domain" ? "example.org" :
                            "person@example.org",
                        text: $typed
                    )
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    if !typed.isEmpty {
                        Text(typedId.map { "Matches \($0.type): \($0.value)" } ?? "Enter a valid \(identifierType) identifier.")
                            .font(.caption)
                    }
                    Button("Add identifier") {
                        if let typedId { selected(.init(kind: "participant", label: typedId.value, identifiers: [typedId]))
                            dismiss()
                        }
                    }.disabled(!ready || typedId == nil)
                }
            }
            if declaration?.picker == "tree" {
                Section {
                    Text("Includes subfolders and files added later.").font(.footnote)
                    if parentId != nil { Button("Back to parent") {
                        _ = ancestors.popLast()
                        parentId = ancestors.last?.ref.id
                    } }
                }
            }
            Section("Suggestions") {
                ForEach(Array((options?.items ?? []).enumerated()), id: \.offset) { _, item in
                    HStack {
                        Button {
                            selected(item.ref)
                            dismiss()
                        } label: {
                            VStack(alignment: .leading) { Text(item.label)
                                Text("\(item.count) matching documents").font(.caption).foregroundStyle(.secondary)
                            }
                        }.disabled(!ready)
                        if item.hasChildren == true { Button("Browse") { ancestors.append(item)
                            parentId = item.ref.id
                        }.buttonStyle(.borderless) }
                    }
                }
                if let next = options?.nextCursor { Button("Load more") { Task { await load(cursor: next) } }.disabled(loading) }
            }
            if loading { ProgressView("Loading items…") }
            if let error { Text(GatewayErrorView.classify(error).title)
                Button("Retry") { Task { await load() } }
            }
        }
        .navigationTitle("Add item")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .task(id: "\(kind):\(query):\(parentId ?? "")") { await load() }
        .onAppear { kind = source.scopes?.items.first?.kind ?? "participant"
            identifierType = source.scopes?.items.first { $0.kind == "participant" }?.identifiers?.first ?? "email"
        }
        .onChange(of: kind) { _, _ in parentId = nil
            ancestors = []
        }
    }

    private func load(cursor: String? = nil) async {
        guard !kind.isEmpty else { return }
        if openedClient == nil { openedClient = store.access }
        guard let client = openedClient, store.access?.baseURL == client.baseURL, store.access?.token == client.token else {
            if openedClient != nil { error = GatewayClient.Error.unauthorized }
            return
        }
        let requestKey = searchKey
        if cursor == nil { options = nil }
        loading = true
        defer { loading = false }
        do {
            var value = try await client.scopeOptions(sourceId: source.id, kind: kind, query: query, parentId: parentId, cursor: cursor)
            try Task.checkCancellation()
            guard store.access?.baseURL == client.baseURL, store.access?.token == client.token else { return }
            guard searchKey == requestKey else { return }
            if cursor != nil { value.items = (options?.items ?? []) + value.items }
            options = value
            error = nil
            if !(declaration?.identifiers ?? []).contains(identifierType),
               let first = declaration?.identifiers?.first { identifierType = first }
        } catch is CancellationError {} catch {
            guard !Task.isCancelled, searchKey == requestKey else { return }
            self.error = error
        }
    }
}

#if DEBUG
#Preview("Folders") {
    NavigationStack {
        SourceFilterPickerView(source: PreviewMocks.scopeFolderSource, options: PreviewMocks.scopeFolderOptions) { _ in }
    }.environment(AppStore.preview())
}

#Preview("Invalid typed phone") {
    NavigationStack {
        SourceFilterPickerView(source: PreviewMocks.scopeParticipantSource, typedInput: "maya@example.org") { _ in }
    }.environment(AppStore.preview())
}
#endif

#endif
