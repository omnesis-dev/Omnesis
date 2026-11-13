// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct SourceFilterPickerView: View {
    @Environment(AppStore.self) var store
    let source: AccessSourceInstance
    let selectedRefs: [ScopeRef]
    let selected: (ScopeRef) -> Void
    /// Opens the list of everything selected so far, when the host offers one.
    let manageSelection: (() -> Void)?
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
    @State var scrollAnchor: ScopePickerAnchor?
    @State var loadGeneration = 0
    @State var catalogueRevision = 0
    @State var pendingRestore: ScopePickerRestoreRequest?
    @State var activeRestoreRevision: UUID?
    @State var issuedRestoreRevision: UUID?
    @State var restoringLocation: ScopePickerLocation?
    #if DEBUG
    var mountedForTesting: ((SourceFilterPickerView) -> Void)?
    #endif

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
        return (options?.readiness ?? source.scopeReadiness ?? []).first { $0.kind == kind }?.ready == true
    }

    /// Whether the list is shown while the gateway is still counting what each item matches.
    var counting: Bool {
        !loading && error == nil && !ready
    }

    var identifierPlaceholder: String {
        identifierType == "phone" ? "International phone number" : identifierType == "domain" ? "example.org" : "person@example.org"
    }

    var typedId: ScopeIdentifier? {
        guard declaration?.identifiers?.contains(identifierType) == true else { return nil }
        return scopeTypedIdentifier(typed, type: identifierType)
    }

    init(
        source: AccessSourceInstance,
        options: ScopeOptions? = nil,
        typedInput: String = "",
        client: AccessClient? = nil,
        selectedRefs: [ScopeRef] = [],
        session: ScopePickerSession = .init(),
        sessionChanged: @escaping (ScopePickerSession) -> Void = { _ in },
        manageSelection: (() -> Void)? = nil,
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
        self.manageSelection = manageSelection
        self.selectedRefs = selectedRefs
        self.selected = selected
        self.sessionChanged = sessionChanged
        _options = State(initialValue: initialOptions)
        _optionsLocation = State(initialValue: initialOptions == nil ? nil : location)
        _positions = State(initialValue: session.positions)
        _restoringLocation = State(initialValue: location)
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
                LazyVStack(alignment: .leading, spacing: 0) {
                    let adding = scopeAddIdentifierTitle(declaration?.identifiers ?? [])
                    AccessHeader(title: enteringIdentifier ? adding : "Choose matching content") { AccessAccountLine(source: source) }
                        .id(ScopePickerAnchor.top)
                    if enteringIdentifier { identifierEntry } else { catalogue }
                    if loading {
                        ProgressView().controlSize(.small).tint(AccessUI.secondary).frame(maxWidth: .infinity).padding(.vertical, 16)
                    }
                    if let error {
                        GatewayErrorView(context: "load matching items", error: error, onRetry: { Task { await openLocation() } })
                            .padding(.vertical, 12)
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, AccessUI.inset)
                .padding(.top, 16)
                .padding(.bottom, AccessUI.headerGap)
                .background {
                    GeometryReader { geometry in
                        Color.clear.preference(key: ScopePickerLayoutKey.self, value: .init(catalogue: .init(
                            requestRevision: pendingRestore?.revision,
                            catalogueRevision: catalogueRevision,
                            location: location,
                            size: geometry.size
                        )))
                    }
                }
            }
            .background {
                GeometryReader { geometry in
                    Color.clear.preference(key: ScopePickerLayoutKey.self, value: .init(viewport: geometry.size))
                }
            }
            .onPreferenceChange(ScopePickerLayoutKey.self) { consumeRestore(layout: $0, proxy: proxy) }
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(DragGesture().onChanged { _ in
                activeRestoreRevision = nil
                pendingRestore = nil
                restoringLocation = nil
            })
            .accessibilityIdentifier("scope-picker.results")
            .coordinateSpace(name: "scope-picker-scroll")
            .scrollPosition(id: scrollPosition, anchor: .top)
            .task(id: key) {
                await openLocation()
                await keepCountsCurrent()
            }
        }
        .background(Theme.bgPrimary)
        #if DEBUG
            .onAppear { mountedForTesting?(self) }
        #endif
            .onDisappear { sessionChanged(session) }
            .onChange(of: store.access?.baseURL.absoluteString) { _, _ in forgetCatalogues() }
            .onChange(of: store.access?.token) { _, _ in forgetCatalogues() }
            .onChange(of: source.id) { _, _ in options = nil }
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

    /// Lists loaded with one gateway credential say nothing about what another may read.
    func forgetCatalogues() {
        options = nil
        catalogues = [:]
        positions = [:]
    }

    var kinds: [SourceScopes.Item] {
        source.scopes?.items ?? options?.scopes.items ?? []
    }

    /// The kinds to match by, the search field, the selection count, and the list of items the account offers.
    @ViewBuilder var catalogue: some View {
        if kinds.count > 1 {
            AccessKindTabs(
                tabs: kinds.map { .init(id: $0.kind, title: ($0.noun?.many ?? "people").capitalized) },
                selection: $kind
            )
            .padding(.bottom, 16)
        }
        AccessSearchField(prompt: "Search " + (declaration?.noun?.many ?? "people"), text: $query, accessibilityLabel: "Search matches")
        HStack {
            Text("\(selectedRefs.count) selected").accessText(.label)
            Spacer()
            if let manageSelection {
                Button(action: manageSelection) {
                    Text("View selected")
                        .accessText(.rowTitle, color: selectedRefs.isEmpty ? AccessUI.muted : Theme.accent)
                        .fontWeight(.regular)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .disabled(selectedRefs.isEmpty)
            }
        }
        .padding(.top, 8)
        if declaration?.picker == "tree" { folderLocation }
        let rows = pickerRows
        let offersIdentifier = !(declaration?.identifiers ?? []).isEmpty
        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
            optionRow(row.option, last: index == rows.count - 1 && !offersIdentifier).id(row.id)
        }
        if let next = options?.nextCursor {
            Button { Task { await load(cursor: next) } } label: {
                Text("Load more").accessText(.rowTitle, color: Theme.accent).frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .disabled(loading)
        }
        if !loading, error == nil, options?.items.isEmpty == true {
            Text("No matching options.").accessText(.rowSecondary, color: AccessUI.secondary).padding(.vertical, 12)
        }
        if offersIdentifier {
            Button { enteringIdentifier = true } label: {
                HStack(spacing: AccessUI.iconGap) {
                    Image(systemName: "plus").font(.system(size: 15, weight: .semibold)).frame(width: AccessUI.controlSize)
                    Text(scopeAddIdentifierTitle(declaration?.identifiers ?? []))
                    Spacer(minLength: 0)
                }
                .accessText(.rowTitle, color: Theme.accent)
                .frame(minHeight: AccessUI.rowMinHeight)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
        }
    }

    /// Where in the folder tree the list is: its ancestors lead back up, and the folder itself is plain text.
    var folderLocation: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Location").accessText(.caption, color: AccessUI.secondary).fontWeight(.regular)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(folderTrail.enumerated()), id: \.offset) { depth, name in
                        if depth > 0 { Text("›").accessText(.rowTitle, color: AccessUI.muted).accessibilityHidden(true) }
                        if depth == folderTrail.count - 1 {
                            Text(name).accessText(.rowTitle)
                        } else {
                            Button { openAncestor(depth: depth) } label: { Text(name).accessText(.rowTitle, color: Theme.accent) }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Go up to \(name)")
                        }
                    }
                }
                .frame(minHeight: 32)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Current location: " + folderScopeText)
            if let folder = ancestors.last {
                let depth = ancestors.count - 1
                let noun = scopeLevelNoun(declaration, depth: depth)?.one ?? declaration?.noun?.one ?? "folder"
                AccessRow(dividerInset: AccessUI.controlSize + AccessUI.iconGap) {
                    checkButton("Select this " + noun, item: folder)
                        .accessibilityHint(scopeNestingHint(declaration, depth: depth) ?? "")
                }
            }
        }
        .padding(.top, 12)
    }

    func optionRow(_ item: ScopeOption, last: Bool) -> some View {
        AccessRow(last: last, dividerInset: AccessUI.controlSize + AccessUI.iconGap) {
            HStack(spacing: 12) {
                checkButton(item.label, item: item).accessibilityLabel("Select \(item.label)")
                if item.hasChildren == true {
                    Button {
                        ancestors.append(item)
                        parentId = item.ref.id
                    } label: {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(AccessUI.secondary)
                            .frame(minWidth: 32, minHeight: 28)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Browse inside \(item.label)")
                }
            }
        }
    }

    /// The part of a row that selects an item: its checkbox, a title, and how many records the item matches.
    func checkButton(_ title: String, item: ScopeOption) -> some View {
        Button { selected(item.ref) } label: {
            HStack(alignment: .center, spacing: AccessUI.iconGap) {
                AccessControlMark(kind: .checkbox, selected: isSelected(item.ref))
                Text(title).accessText(.rowTitle).fontWeight(.regular).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                AccessMatchCount(count: ready ? item.count : nil, counting: counting)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected(item.ref) ? .isSelected : [])
    }

    func isSelected(_ ref: ScopeRef) -> Bool {
        selectedRefs.contains { scopeRefIdentityMatches($0, ref) }
    }

    /// A typed identifier is one deliberate addition, after which the list comes back.
    func addIdentifier(_ ref: ScopeRef) {
        if !isSelected(ref) { selected(ref) }
        typed = ""
        enteringIdentifier = false
    }

    func load(cursor: String? = nil, quietly: Bool = false) async {
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
        if !quietly { loading = true }
        defer { if generation == loadGeneration { loading = false } }
        do {
            let request = ScopePickerRequest(sourceId: source.id, kind: requestedKind, query: requestedQuery, parentId: requestedParent)
            let value = try await loadScopePickerPages(
                client: client,
                request: request,
                previous: options,
                cursor: cursor,
                restoreCount: cachedCount
            )
            try Task.checkCancellation()
            guard client.isCurrent(store.access) else { return }
            guard searchKey == requestKey, requestedLocation == location, generation == loadGeneration,
                  value.sourceId == source.id else { return }
            options = value
            catalogueRevision += 1
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

@available(iOS 17.0, *)
extension SourceFilterPickerView {
    /// Asks for the list again while the gateway is still counting, so counts appear without a refresh control.
    func keepCountsCurrent() async {
        var attempt = 0
        while !Task.isCancelled, counting, openedClient != nil {
            attempt += 1
            try? await Task.sleep(for: scopeCountRefreshDelay(attempt: attempt))
            guard !Task.isCancelled, counting else { return }
            await load(quietly: true)
        }
    }

    /// A typed phone number, email address or domain, for a person the list does not offer.
    @ViewBuilder var identifierEntry: some View {
        let types = declaration?.identifiers ?? []
        VStack(alignment: .leading, spacing: 12) {
            if types.count > 1 {
                AccessKindTabs(
                    tabs: types.map { .init(id: $0, title: scopeIdentifierTypeName($0)) },
                    selection: $identifierType
                )
            }
            TextField(identifierPlaceholder, text: $typed, prompt: Text(identifierPlaceholder).foregroundStyle(AccessUI.secondary))
                .accessibilityLabel(scopeIdentifierTypeName(identifierType))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(identifierType == "phone" ? .phonePad : .emailAddress)
                .modifier(AccessFieldChrome())
            AccessProblemText(text: !typed.isEmpty && typedId == nil ? scopeTypedIdentifierProblem(identifierType) : nil, top: 0)
            Text("Only content that matches exactly what you enter is matched.").accessText(.rowSecondary, color: AccessUI.secondary)
            HStack(spacing: 24) {
                Button {
                    if let typedId { addIdentifier(.init(kind: kind, label: typedId.value, identifiers: [typedId])) }
                } label: {
                    Text("Add").accessText(.button, color: typedId == nil ? AccessUI.muted : Theme.accent).frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .disabled(typedId == nil)
                Button { enteringIdentifier = false } label: {
                    Text("Back to the list").accessText(.rowTitle, color: Theme.accent).frame(minHeight: 44)
                }.buttonStyle(.plain)
            }
        }
    }
}

#if DEBUG
#Preview("Folders") {
    NavigationStack {
        SourceFilterPickerView(source: PreviewMocks.accessDrive, options: PreviewMocks.accessRootFolderOptions) { _ in }
    }.environment(AppStore.preview())
}

#Preview("Typed phone number") {
    NavigationStack {
        SourceFilterPickerView(source: PreviewMocks.accessWhatsApp, typedInput: "maya@example.org") { _ in }
    }.environment(AppStore.preview())
}
#endif

#endif
