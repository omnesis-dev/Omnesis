// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The items of an account a filter can name, one tab per field the editor offers: a searchable list, or a tree
/// to browse. A field that cannot be used yet shows why instead of its items.
@available(iOS 17.0, *)
struct SourceFilterPickerView: View {
    @Environment(AppStore.self) var store
    let source: AccessSourceInstance
    /// The account's fields and their states; nil while the editor is loading them.
    let editor: SourceFilterEditor?
    let selectedRefs: [ScopeRef]
    let selected: (ScopeRef) -> Void
    /// Opens the list of everything selected so far, when the host offers one.
    let manageSelection: (() -> Void)?
    /// Resyncs the account in place, for a field whose records predate it.
    let resync: () -> Void
    let resyncStarting: Bool
    let resyncProblem: String?
    @State var field = ""
    @State var query = ""
    @State var parentId: String?
    @State var device: String?
    @State var ancestors: [ScopeOption] = []
    @State var options: ScopeOptions?
    @State var openedClient: AccessClient?
    @State var error: Error?
    @State var loading = false
    @State var identifierType = ""
    @State var typed = ""
    @State var typedProblem: String?
    @State var checkingIdentifier = false
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
        "\(source.id):\(field):\(query):\(device ?? ""):\(parentId ?? "")"
    }

    var fields: [FilterEditorField] {
        editor?.fields ?? []
    }

    var declaration: FilterEditorField? {
        editor?.field(field)
    }

    /// The field's items can be listed and chosen.
    var usable: Bool {
        declaration?.state.isReady == true
    }

    var identifierPlaceholder: String {
        identifierType == "phone" ? "International phone number" : identifierType == "domain" ? "example.org" : "person@example.org"
    }

    init(
        source: AccessSourceInstance,
        editor: SourceFilterEditor?,
        options: ScopeOptions? = nil,
        typedInput: String = "",
        typedProblem: String? = nil,
        client: AccessClient? = nil,
        selectedRefs: [ScopeRef] = [],
        session: ScopePickerSession = .init(),
        sessionChanged: @escaping (ScopePickerSession) -> Void = { _ in },
        manageSelection: (() -> Void)? = nil,
        resync: @escaping () -> Void = {},
        resyncStarting: Bool = false,
        resyncProblem: String? = nil,
        selected: @escaping (ScopeRef) -> Void
    ) {
        let session = session.retained(for: source.id)
        let declarations = editor?.fields ?? []
        let defaultField = typedInput.isEmpty ? declarations.first?.field
            : declarations.first { !($0.identifiers ?? []).isEmpty }?.field
        var seed = session
        if seed.field.isEmpty { seed.field = defaultField ?? "" }
        let location = seed.location(for: source.id)
        let initialOptions = options ?? session.catalogues[location]
        _openedClient = State(initialValue: client)
        self.source = source
        self.editor = editor
        self.manageSelection = manageSelection
        self.selectedRefs = selectedRefs
        self.selected = selected
        self.sessionChanged = sessionChanged
        self.resync = resync
        self.resyncStarting = resyncStarting
        self.resyncProblem = resyncProblem
        _options = State(initialValue: initialOptions)
        _optionsLocation = State(initialValue: initialOptions == nil ? nil : location)
        _positions = State(initialValue: session.positions)
        _restoringLocation = State(initialValue: location)
        _catalogues = State(initialValue: session.catalogues)
        _field = State(initialValue: seed.field)
        _query = State(initialValue: session.query)
        _parentId = State(initialValue: session.parentId)
        _device = State(initialValue: session.device)
        _ancestors = State(initialValue: session.ancestors)
        _identifierType = State(initialValue: session.identifierType.isEmpty
            ? declarations.first { $0.field == seed.field }?.identifiers?.first ?? "" : session.identifierType)
        _typed = State(initialValue: typedInput.isEmpty ? session.typed : typedInput)
        _typedProblem = State(initialValue: typedProblem)
        _enteringIdentifier = State(initialValue: session.enteringIdentifier || !typedInput.isEmpty)
    }

    let sessionChanged: (ScopePickerSession) -> Void
    @State var enteringIdentifier = false

    var session: ScopePickerSession {
        var saved = ScopePickerSession(
            field: field,
            query: query,
            parentId: parentId,
            device: device,
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
                    if loading { SourceFilterLoadingLine().padding(.vertical, 8) }
                    if let error {
                        SourceFilterRetryLine(message: GatewayErrorView.classify(error).title) { Task { await openLocation() } }
                            .padding(.vertical, 8)
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
            .task(id: usable ? key : nil) {
                guard usable else { return }
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
            .onChange(of: editor?.fields.map(\.field)) { _, _ in
                if field.isEmpty || declaration == nil { field = fields.first?.field ?? "" }
            }
            .onChange(of: field) { old, new in
                var updated = session
                updated.field = old
                updated.changeField(new, fields: fields)
                parentId = updated.parentId
                device = updated.device
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

    /// The fields as tabs, then the open field's items or why they cannot be chosen yet.
    @ViewBuilder var catalogue: some View {
        if fields.count > 1, !scopeAccountWaitsForResync(fields) {
            AccessKindTabs(tabs: fields.map { .init(id: $0.field, title: scopeFieldTabTitle($0)) }, selection: $field)
                .padding(.bottom, 16)
        }
        if editor == nil {
            SourceFilterLoadingLine()
        } else if let declaration, !declaration.state.isReady {
            SourceFilterFieldStateView(
                state: scopeFieldShownState(declaration, in: fields),
                sourceName: accessSourceNameParts(source).source,
                starting: resyncStarting,
                problem: resyncProblem,
                resync: resync
            )
        } else if declaration != nil {
            items
        }
    }

    @ViewBuilder private var items: some View {
        AccessSearchField(prompt: "Search " + (declaration?.noun.many ?? "people"), text: $query, accessibilityLabel: "Search matches")
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
        if declaration?.isTree == true, query.isEmpty { folderLocation }
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
            Text(scopePickerEmptyText(declaration?.noun.many ?? "items", searching: !query.isEmpty))
                .accessText(.rowSecondary, color: AccessUI.secondary)
                .padding(.vertical, 12)
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

    /// Where in the tree the list is: its ancestors lead back up, and the open item itself is plain text. Inside an
    /// item, its own row selects it, with what that takes in said under it.
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
            if let open = ancestors.last {
                AccessRow(dividerInset: AccessUI.controlSize + AccessUI.iconGap) {
                    checkButton(
                        "Select this " + (scopeFieldNoun(open.ref, fields: fields, depth: open.depth) ?? "folder"),
                        item: open,
                        detail: open.ref.isDevice ? nil : declaration?.insideText
                    )
                }
            }
        }
        .padding(.top, 12)
    }

    func optionRow(_ item: ScopeOption, last: Bool) -> some View {
        let title = scopePickerRowTitle(item, inTree: declaration?.isTree == true, searching: !query.isEmpty)
        return AccessRow(last: last, dividerInset: AccessUI.controlSize + AccessUI.iconGap) {
            HStack(spacing: 12) {
                checkButton(title, item: item).accessibilityLabel("Select \(title)")
                if item.hasChildren == true, query.isEmpty {
                    Button { open(item) } label: {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(AccessUI.secondary)
                            .frame(minWidth: 32, minHeight: 28)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Browse inside \(title)")
                }
            }
        }
    }

    /// The part of a row that selects an item: its checkbox, a title, and how many records the item matches.
    func checkButton(_ title: String, item: ScopeOption, detail: String? = nil) -> some View {
        Button { selected(item.ref) } label: {
            HStack(alignment: .center, spacing: AccessUI.iconGap) {
                AccessControlMark(kind: .checkbox, selected: isSelected(item.ref))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).accessText(.rowTitle).fontWeight(.regular).multilineTextAlignment(.leading)
                    if let detail { Text(detail).accessText(.rowSecondary, color: AccessUI.secondary) }
                }
                Spacer(minLength: 0)
                AccessMatchCount(count: item.count, counting: item.count == nil)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected(item.ref) ? .isSelected : [])
    }

    func isSelected(_ ref: ScopeRef) -> Bool {
        selectedRefs.contains { scopeRefIdentityMatches($0, ref) }
    }

    func open(_ item: ScopeOption) {
        var moved = session
        moved.open(item)
        ancestors = moved.ancestors
        device = moved.device
        parentId = moved.parentId
    }

    func load(cursor: String? = nil, quietly: Bool = false) async {
        guard !field.isEmpty, usable else { return }
        openedClient = openedClient ?? store.access
        guard let client = try? openedClient?.authorized(for: store.access) else {
            if openedClient != nil { error = GatewayClient.Error.unauthorized }
            return
        }
        let requestKey = searchKey
        let requestedLocation = location
        let cachedCount = cursor == nil && optionsLocation == location ? options?.items.count ?? 0 : 0
        let request = ScopePickerRequest(sourceId: source.id, field: field, query: query, parentId: parentId, device: device)
        loadGeneration += 1
        let generation = loadGeneration
        if cursor == nil, optionsLocation != location { options = nil }
        if !quietly { loading = true }
        defer { if generation == loadGeneration { loading = false } }
        do {
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
        while !Task.isCancelled, let wait = options?.retryAfterMs, openedClient != nil {
            attempt += 1
            try? await Task.sleep(for: scopeRetryDelay(retryAfterMs: wait, attempt: attempt))
            guard !Task.isCancelled else { return }
            await load(quietly: true)
        }
    }

    /// A typed phone number, email address or domain, for a person the list does not offer. The gateway reads it
    /// and says what is wrong with it.
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
                .onSubmit { Task { await addTyped() } }
            AccessProblemText(text: typedProblem, top: 0)
            Text("Only content that matches exactly what you enter is matched.").accessText(.rowSecondary, color: AccessUI.secondary)
            HStack(spacing: 24) {
                Button { Task { await addTyped() } } label: {
                    let enabled = !typed.trimmingCharacters(in: .whitespaces).isEmpty && !checkingIdentifier
                    Text("Add").accessText(.button, color: enabled ? Theme.accent : AccessUI.muted).frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty || checkingIdentifier)
                Button { enteringIdentifier = false } label: {
                    Text("Back to the list").accessText(.rowTitle, color: Theme.accent).frame(minHeight: 44)
                }.buttonStyle(.plain)
            }
        }
        .onChange(of: typed) { _, _ in typedProblem = nil }
        .onChange(of: identifierType) { _, _ in typedProblem = nil }
    }

    /// Has the gateway read what was typed, then adds it, or shows the gateway's sentence under the field.
    func addTyped() async {
        let value = typed
        let type = identifierType
        guard !value.trimmingCharacters(in: .whitespaces).isEmpty, !checkingIdentifier else { return }
        openedClient = openedClient ?? store.access
        guard let client = try? openedClient?.authorized(for: store.access) else {
            typedProblem = GatewayErrorView.classify(GatewayClient.Error.unauthorized).title
            return
        }
        checkingIdentifier = true
        defer { checkingIdentifier = false }
        do {
            let check = try await client.checkIdentifier(type: type, value: value)
            guard typed == value, identifierType == type else { return }
            switch check {
            case .identifier(let identifier):
                let ref = ScopeRef.person(label: identifier.value, identifiers: [identifier])
                if !isSelected(ref) { selected(ref) }
                typed = ""
                enteringIdentifier = false
            case .problem(let sentence):
                typedProblem = sentence
            }
        } catch {
            typedProblem = GatewayErrorView.classify(error).title
        }
    }
}

#if DEBUG
#Preview("Folders") {
    NavigationStack {
        SourceFilterPickerView(
            source: PreviewMocks.accessDrive, editor: PreviewMocks.accessDriveEditor, options: PreviewMocks.accessRootFolderOptions
        ) { _ in }
    }.environment(AppStore.preview())
}

#Preview("Typed phone number refused") {
    NavigationStack {
        SourceFilterPickerView(
            source: PreviewMocks.accessWhatsApp,
            editor: PreviewMocks.accessWhatsAppEditor,
            typedInput: "+44 (0)7700 900123",
            typedProblem: "Enter a valid phone number. Include the international country code."
        ) { _ in }
    }.environment(AppStore.preview())
}
#endif

#endif
