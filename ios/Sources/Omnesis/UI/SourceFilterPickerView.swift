// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct SourceFilterPickerView: View {
    @Environment(AppStore.self) var store
    @Environment(\.dismiss) var dismiss
    let source: AccessSourceInstance
    let capability: String?
    let selectedRefs: [ScopeRef]
    let selected: (ScopeRef) -> Void
    @State var kind = ""
    @State var query = ""
    @State var parentId: String?
    @State var ancestors: [ScopeOption] = []
    @State var options: ScopeOptions?
    @State var openedClient: AccessClient?
    @State var error: Error?
    @State var loading = false
    @State var identifierType = ""
    @State var typed = ""
    @State var positions: [ScopePickerLocation: ScopePickerPosition] = [:]
    @State var catalogues: [ScopePickerLocation: ScopeOptions] = [:]
    @State var optionsLocation: ScopePickerLocation?
    @State var viewport = CGRect.zero
    @State var visibleFrames: [ScopePickerAnchor: CGRect] = [:]
    @State var restoringPosition = false
    @State var restorationIssued = false
    @State var loadGeneration = 0

    var searchKey: String {
        "\(source.id):\(kind):\(query):\(parentId ?? "")"
    }

    var declaration: SourceScopes
        .Item? {
        source.scopes?.items.first { $0.kind == kind } ?? options?.scopes.items.first { $0.kind == kind }
    }

    var ready: Bool {
        if loading || error != nil { return false }
        if let options, options.sourceId != source.id { return false }
        return
            (options?.readiness ?? source.scopeReadiness ?? []).first { $0.kind == kind }?.ready == true
    }

    var typedId: ScopeIdentifier? {
        guard declaration?.identifiers?.contains(identifierType) == true else { return nil }
        return scopeTypedIdentifier(typed, type: identifierType)
    }

    init(
        source: AccessSourceInstance,
        options: ScopeOptions? = nil,
        typedInput: String = "",
        capability: String? = nil,
        client: AccessClient? = nil,
        selectedRefs: [ScopeRef] = [],
        session: ScopePickerSession = .init(),
        sessionChanged: @escaping (ScopePickerSession) -> Void = { _ in },
        selected: @escaping (ScopeRef) -> Void
    ) {
        let session = session.retained(for: source.id)
        let declarations = source.scopes?.items ?? options?.scopes.items ?? []
        let defaultKind = typedInput.isEmpty ? declarations.first?.kind : declarations.first { !($0.identifiers ?? []).isEmpty }?.kind
        let initialKind = session.kind.isEmpty ? defaultKind ?? "" : session.kind
        var seed = session
        seed.kind = initialKind
        let location = seed.location(for: source.id)
        let initialOptions = options ?? session.catalogues[location]
        _openedClient = State(initialValue: client)
        self.source = source
        self.capability = capability
        self.selectedRefs = selectedRefs
        self.selected = selected
        self.sessionChanged = sessionChanged
        _options = State(initialValue: initialOptions)
        _optionsLocation = State(initialValue: initialOptions == nil ? nil : location)
        _positions = State(initialValue: session.positions)
        _restoringPosition = State(initialValue: session.positions[location] != nil)
        _catalogues = State(initialValue: session.catalogues)
        _kind = State(initialValue: initialKind)
        _query = State(initialValue: session.query)
        _parentId = State(initialValue: session.parentId)
        _ancestors = State(initialValue: session.ancestors)
        _identifierType = State(initialValue: session.identifierType.isEmpty ? source.scopes?.items
            .first(where: { !($0.identifiers ?? []).isEmpty })?.identifiers?.first ?? "" : session.identifierType)
        _typed = State(initialValue: typedInput.isEmpty ? session.typed : typedInput)
        _enteringIdentifier = State(initialValue: session.enteringIdentifier || !typedInput.isEmpty)
    }

    let sessionChanged: (ScopePickerSession) -> Void
    @State var enteringIdentifier = false

    var session: ScopePickerSession {
        var saved = ScopePickerSession(
            kind: kind,
            query: query,
            parentId: parentId,
            ancestors: ancestors,
            identifierType: identifierType,
            typed: typed,
            enteringIdentifier: enteringIdentifier,
            sourceId: source.id,
            positions: positions,
            catalogues: catalogues
        )
        if let options, optionsLocation == location, options.sourceId == source.id { saved.catalogues[location] = options }
        return saved
    }

    var body: some View {
        let key = location
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if enteringIdentifier {
                        GroupBox { Text("Enter an exact identifier").font(.title2.bold()).accessibilityAddTraits(.isHeader) }
                    }
                    if enteringIdentifier {
                        GroupBox {
                            if (declaration?.identifiers?.count ?? 0) > 1 {
                                Picker("Identify by", selection: $identifierType) {
                                    ForEach(declaration?.identifiers ?? [], id: \.self) { Text($0.capitalized).tag($0) }
                                }.frame(minHeight: 44)
                            } else { Text(identifierType.capitalized) }
                            TextField(
                                identifierType == "phone" ? "International phone number" : identifierType == "domain" ? "example.org" :
                                    "person@example.org",
                                text: $typed
                            )
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(identifierType == "phone" ? .phonePad : .emailAddress)
                            .frame(minHeight: 44)
                            if !typed.isEmpty {
                                Text(typedId.map { "Matches \($0.type): \($0.value)" } ?? "Enter a valid \(identifierType) identifier.")
                                    .font(.subheadline)
                            }
                            Text("Matches use this exact identifier. Other identifiers are not added automatically.").font(.subheadline)
                                .foregroundStyle(Theme.textSecondary)
                        }
                    } else {
                        GroupBox {
                            if (source.scopes?.items ?? options?.scopes.items ?? []).count > 1 {
                                Picker("Match by", selection: $kind) {
                                    ForEach(source.scopes?.items ?? options?.scopes.items ?? [], id: \.kind) { item in
                                        Text(item.noun?.many ?? "People").tag(item.kind)
                                    }
                                }.frame(minHeight: 44)
                            }
                            TextField("Search", text: $query)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .frame(minHeight: 44)
                            if !(declaration?.identifiers ?? []).isEmpty {
                                Button("Enter an exact identifier instead") { enteringIdentifier = true }.frame(minHeight: 44)
                            }
                        }
                        .id(ScopePickerAnchor.top)
                        .background {
                            GeometryReader { geometry in
                                Color.clear.preference(
                                    key: ScopePickerFramesKey.self,
                                    value: [key: [.top: geometry.frame(in: .named("scope-picker-scroll"))]]
                                )
                            }
                        }
                        if declaration?.picker == "tree" {
                            GroupBox("Location") {
                                Text((["All folders"] + ancestors.map(\.label)).joined(separator: " › "))
                                    .accessibilityLabel("Current folder: " + (ancestors.last?.label ?? "All folders"))
                                if parentId != nil {
                                    Button("Back to parent folder") { var updated = session
                                        updated.goToParent()
                                        ancestors = updated.ancestors
                                        parentId = updated.parentId
                                    }.frame(minHeight: 44)
                                    if let folder = ancestors
                                        .last { Button("Select this folder") { select(folder.ref) }.frame(minHeight: 44).disabled(!ready) }
                                }
                                Text("Selected folders include descendants and files added later.").font(.subheadline)
                                    .foregroundStyle(Theme.textSecondary)
                            }
                        }
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Results").font(.headline)
                            ForEach(pickerRows) { row in
                                let item = row.option
                                HStack(spacing: 12) {
                                    Button { select(item.ref) } label: {
                                        HStack(alignment: .top, spacing: 12) {
                                            Image(systemName: selectedRefs
                                                .contains { scopeRefIdentityMatches($0, item.ref) } ? "checkmark.square.fill" : "square")
                                                .accessibilityHidden(true)
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(item.label).foregroundStyle(Color.primary)
                                                Text("\(item.count) matches").font(.subheadline).foregroundStyle(Theme.textSecondary)
                                            }
                                        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                    }.buttonStyle(.borderless).disabled(!ready).accessibilityLabel("Select \(item.label)")
                                    if item.hasChildren == true {
                                        Button { ancestors.append(item)
                                            parentId = item.ref.id
                                        } label: {
                                            Image(systemName: "chevron.right").frame(minWidth: 44, minHeight: 44)
                                        }.buttonStyle(.borderless).accessibilityLabel("Browse inside \(item.label)")
                                    }
                                }
                                .padding(12)
                                .background(.background, in: .rect(cornerRadius: 12))
                                .id(row.id)
                                .background {
                                    GeometryReader { geometry in
                                        Color.clear.preference(
                                            key: ScopePickerFramesKey.self,
                                            value: [key: [row.id: geometry.frame(in: .named("scope-picker-scroll"))]]
                                        )
                                    }
                                }
                            }
                            if let next = options?
                                .nextCursor {
                                Button("Load more") { Task { await load(cursor: next) } }.frame(minHeight: 44).disabled(loading)
                            }
                            if !loading, options?.items.isEmpty == true { Text("No matching items. Try another search.") }
                        }
                    }
                    if !ready {
                        GroupBox {
                            Text(options?.readiness.first { $0.kind == kind }?
                                .message ?? "These facts are being prepared. Try again when preparation finishes.")
                        }
                    }
                    if loading { GroupBox { ProgressView("Loading items…") } }
                    if let error {
                        GroupBox { GatewayErrorView(context: "load matching items", error: error, onRetry: { Task { await load() } }) }
                    }
                }.padding(16)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .coordinateSpace(name: "scope-picker-scroll")
            .background {
                GeometryReader { geometry in
                    Color.clear.preference(key: ScopePickerViewportKey.self, value: [key: CGRect(
                        x: 0,
                        y: geometry.safeAreaInsets.top,
                        width: geometry.size.width,
                        height: geometry.size.height - geometry.safeAreaInsets.top - geometry.safeAreaInsets.bottom
                    )])
                }
            }
            .onPreferenceChange(ScopePickerViewportKey.self) { values in
                if let value = values[key] { viewport = value
                    restorePosition(proxy: proxy)
                }
            }
            .onPreferenceChange(ScopePickerFramesKey.self) { values in
                if let frames = values[key] { observeFrames(frames, proxy: proxy) }
            }
            .task(id: key) { await openLocation(proxy: proxy) }
        }
        .safeAreaInset(edge: .top) {
            Text((capability.map { $0.capitalized + " · " } ?? "") + accessSourceDisplayName(source))
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(.bar)
        }
        .tint(Theme.accent)
        .navigationTitle("Choose a match")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(enteringIdentifier ? "Back" : "Back to matches") {
                    if enteringIdentifier { enteringIdentifier = false } else { dismiss() }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if enteringIdentifier {
                Button {
                    if let typedId { select(.init(kind: kind, label: typedId.value, identifiers: [typedId])) }
                } label: {
                    Text("Add identifier").frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accessPrimary)
                .foregroundStyle(Color.white)
                .padding()
                .background(.bar)
                .disabled(!ready || typedId == nil)
            }
        }
        .onDisappear { sessionChanged(session) }
        .onChange(of: store.access?.baseURL.absoluteString) { _, _ in options = nil
            catalogues = [:]
            positions = [:]
            dismiss()
        }
        .onChange(of: store.access?.token) { _, _ in options = nil
            catalogues = [:]
            positions = [:]
            dismiss()
        }
        .onChange(of: source.id) { _, _ in options = nil
            dismiss()
        }
        .onChange(of: kind) { old, new in
            var updated = session
            updated.kind = old
            updated.changeKind(new, scopes: source.scopes ?? options?.scopes)
            parentId = updated.parentId
            ancestors = updated.ancestors
            identifierType = updated.identifierType
            options = nil
        }
    }

    func select(_ ref: ScopeRef) {
        sessionChanged(session)
        selected(ref)
        dismiss()
    }

    func load(cursor: String? = nil) async {
        guard !kind.isEmpty else { return }
        openedClient = openedClient ?? store.access
        guard let client = try? openedClient?.authorized(for: store.access) else {
            if openedClient != nil { error = GatewayClient.Error.unauthorized }
            return
        }
        let requestKey = searchKey
        let requestedLocation = location
        let cachedCount = cursor == nil && optionsLocation == location ? options?.items.count ?? 0 : 0
        let requestedKind = kind, requestedQuery = query, requestedParent = parentId
        loadGeneration += 1
        let generation = loadGeneration
        if cursor == nil, optionsLocation != location { options = nil }
        loading = true
        defer { if generation == loadGeneration { loading = false } }
        do {
            var value = try await client.scopeOptions(
                sourceId: source.id,
                kind: requestedKind,
                query: requestedQuery,
                parentId: requestedParent,
                cursor: cursor
            )
            var visitedCursors: Set<String> = []
            while cursor == nil, value.items.count < cachedCount, let next = value.nextCursor {
                try Task.checkCancellation()
                guard visitedCursors.insert(next).inserted else { throw GatewayClient.Error.invalidResponse }
                let more = try await client.scopeOptions(
                    sourceId: source.id,
                    kind: requestedKind,
                    query: requestedQuery,
                    parentId: requestedParent,
                    cursor: next
                )
                guard more.sourceId == source.id else { throw GatewayClient.Error.invalidResponse }
                value.items += more.items
                value.nextCursor = more.nextCursor
            }
            try Task.checkCancellation()
            guard store.access?.baseURL == client.baseURL, store.access?.token == client.token else { return }
            guard searchKey == requestKey, requestedLocation == location, generation == loadGeneration,
                  value.sourceId == source.id else { return }
            if cursor != nil { value.items = (options?.items ?? []) + value.items }
            options = value
            optionsLocation = requestedLocation
            catalogues[requestedLocation] = value
            error = nil
            if !(declaration?.identifiers ?? []).contains(identifierType),
               let first = declaration?.identifiers?.first { identifierType = first }
        } catch is CancellationError {} catch {
            guard !Task.isCancelled, searchKey == requestKey, generation == loadGeneration else { return }
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
