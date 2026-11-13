// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The filter of one account under one capability, in three steps: what to share, which items match, and a review
/// of what the filter leaves readable. The account's fields come from the gateway's filter editor, which also says
/// when a field cannot be used yet and why.
@available(iOS 17.0, *)
struct SourceFilterEditorView: View {
    @Environment(AppStore.self) var store
    @Environment(\.dismiss) private var dismiss
    let source: AccessSourceInstance
    let authoringEnabled: Bool
    let changed: (ScopePolicy?) -> Void
    let displayHints: [ScopeItemHint]
    let hintsChanged: ([ScopeItemHint]) -> Void
    let parentClient: AccessClient?
    @State var labelHints: [ScopeItemHint] = []
    @State var policy: ScopePolicy
    @State var preview: ScopePreview?
    @State var previewedPolicy: ScopePolicy?
    @State var openedClient: AccessClient?
    @State var error: Error?
    @State var editor: SourceFilterEditor?
    @State var editorError: Error?
    @State var editorGeneration = 0
    @State var countsGeneration = 0
    /// The owner asked for a resync and the gateway has not reported it running yet.
    @State var resyncStarting = false
    @State var resyncProblem: String?
    @State private var managing = false
    @State private var retainedRefs: [ScopeRef] = []
    var refs: [ScopeRef] {
        policy.rules.first?.match ?? []
    }

    private var writable: Bool {
        authoringEnabled && policy.editable
    }

    init(
        source: AccessSourceInstance,
        levelId: String,
        capability: String,
        initialPolicy: ScopePolicy?,
        authoringEnabled: Bool,
        editor: SourceFilterEditor? = nil,
        preview: ScopePreview? = nil,
        previewStep: ScopeFilterStep = .mode,
        previewSession: ScopePickerSession = .init(),
        client: AccessClient? = nil,
        displayHints: [ScopeItemHint] = [],
        hintsChanged: @escaping ([ScopeItemHint]) -> Void = { _ in },
        changed: @escaping (ScopePolicy?) -> Void
    ) {
        _openedClient = State(initialValue: client)
        _step = State(initialValue: previewStep)
        _pickerSession = State(initialValue: previewSession)
        _editor = State(initialValue: editor)
        self.parentClient = client
        self.displayHints = displayHints
        self.hintsChanged = hintsChanged
        let previewHints = preview.map { scopeItemHints($0, fields: editor?.fields ?? []) } ?? []
        _labelHints = State(initialValue: mergingScopeLabelHints(displayHints, preview?.sourceId == source.id ? previewHints : []))
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

    @State private var step: ScopeFilterStep
    @State private var mode: ScopeFilterMode
    @State var pickerSession: ScopePickerSession
    @State private var confirmExit = false
    private let initialPolicy: ScopePolicy?
    private let capability: String
    private var dirty: Bool {
        scopeFilterHasChanges(initial: initialPolicy, policy: policy, mode: mode)
    }

    /// The account is no longer connected: its saved filter can be reviewed and shortened, nothing else.
    private var disconnected: Bool {
        writable && !source.available
    }

    private var commit: ScopeFilterCommit {
        if disconnected { return scopeDisconnectedFilterCommit(mode: mode, policy: policy, initial: initialPolicy) }
        return ScopeFilterCommitState(mode: mode, policy: policy, sourceId: source.id, authoringEnabled: authoringEnabled).decision
    }

    private var canApply: Bool {
        commit != .blocked
    }

    private var missingSelection: Bool {
        mode == .only && refs.isEmpty
    }

    /// A saved filter that cannot be edited still shows what it currently allows.
    private var previewing: Bool {
        mode != .all && (step == .review || !writable) && !disconnected
    }

    /// The list of items to choose from, which stands in for the page while matches are being chosen.
    private var showsPicker: Bool {
        step == .matches && writable && source.available && !managing
    }

    /// The selected items listed for removal, when asked for from the list of items to choose from.
    private var listsSelection: Bool {
        step == .matches && managing
    }

    private var title: String {
        if !writable { return "Saved source filter" }
        if disconnected { return "Review this filter" }
        switch step {
        case .mode: return "What should be shared?"
        case .matches: return Self.selectedFiltersHeading
        case .review: return "Review this filter"
        }
    }

    private static let selectedFiltersHeading = "Selected filters"
    private static let applyTitle = "Apply filter"

    /// The counts of the filter as it stands, once the gateway has worked them out.
    private var currentPreview: ScopePreview? {
        guard let preview, previewedPolicy == policy, preview.sourceId == source.id else { return nil }
        return preview
    }

    /// The review is waiting for the gateway to count what the filter leaves readable.
    private var counting: Bool {
        previewing && error == nil && currentPreview == nil
    }

    var body: some View {
        AccessFrame {
            AccessTopBar(title: "\(accessCapabilityName(capability)) filter") {
                if !writable {
                    AccessBarButton("Close") { dismiss() }
                } else if step == .mode || disconnected {
                    AccessBarButton("Cancel") { leave() }
                } else {
                    AccessBarButton("Back") { back() }
                }
            } trailing: {
                if writable, step != .mode, !disconnected { AccessBarButton("Cancel") { leave() } }
            }
        } content: {
            if showsPicker, editor == nil, let editorError {
                AccessScroll {
                    AccessHeader(title: "Choose matching content") { AccessAccountLine(source: source) }
                    GatewayErrorView(context: "load this account's filters", error: editorError, onRetry: { editorGeneration += 1 })
                }
            } else if showsPicker {
                SourceFilterPickerView(
                    source: source,
                    editor: editor,
                    client: openedClient,
                    selectedRefs: refs,
                    session: pickerSession,
                    sessionChanged: { adoptPickerSession($0) },
                    manageSelection: { managing = true },
                    resync: { Task { await resyncAccount() } },
                    resyncStarting: resyncStarting,
                    resyncProblem: resyncProblem,
                    selected: { ref in policy.toggleMatch(ref) }
                )
            } else {
                AccessScroll {
                    AccessHeader(title: title) { AccessAccountLine(source: source) }
                    if !writable {
                        Text(authoringEnabled
                            ? "This filter uses settings this editor cannot change. It stays in place exactly as saved."
                            : "Source filter editing requires experimental mode. This saved filter stays in place and is shown here.")
                            .accessText(.rowSecondary, color: AccessUI.secondary)
                            .padding(.bottom, 16)
                        reviewContent
                    } else if disconnected {
                        disconnectedContent
                    } else if step == .mode {
                        modeOptions
                    } else if step == .matches {
                        selectionContent
                    } else {
                        reviewContent
                    }
                }
            }
        } footer: {
            if writable { AccessFooter { footer } }
        }
        .onAppear { if openedClient == nil { openedClient = store.access } }
        .interactiveDismissDisabled(dirty)
        .alert("Discard filter changes?", isPresented: $confirmExit) {
            Button("Discard changes", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
        .onChange(of: store.access?.baseURL) { _, _ in forgetGatewayState() }
        .onChange(of: store.access?.token) { _, _ in forgetGatewayState() }
        .onChange(of: displayHints) { _, hints in
            if (try? openedClient?.authorized(for: store.access)) != nil { labelHints = mergingScopeLabelHints(labelHints, hints) }
        }
        .task(id: editorGeneration) { if source.available, authoringEnabled { await keepEditorCurrent() } }
        .task(id: step == .review ? nil : policy) { if step != .review { await resolveDisplayHints() } }
        .onChange(of: policy) { _, _ in previewedPolicy = nil }
        .id(step)
        .task(id: previewing ? ScopeCountsRequest(policy: policy, generation: countsGeneration) : nil) {
            if previewing { await keepCountsCurrent() }
        }
    }

    /// Asks for the filter's counts, and again while the gateway is still working them out, so they arrive without
    /// a refresh control.
    private func keepCountsCurrent() async {
        if openedClient == nil { openedClient = store.access }
        var attempt = 0
        while !Task.isCancelled {
            guard let client = openedClient, client.isCurrent(store.access) else {
                if openedClient != nil { error = GatewayClient.Error.unauthorized }
                return
            }
            let requested = policy
            attempt += 1
            do {
                let response = try await client.scopePreview(requested)
                try Task.checkCancellation()
                guard client.isCurrent(store.access), policy == requested else { return }
                switch response {
                case .ready(let value):
                    guard value.sourceId == source.id else {
                        error = GatewayClient.Error.invalidResponse
                        return
                    }
                    preview = value
                    previewedPolicy = requested
                    labelHints = mergingScopeLabelHints(labelHints, scopeItemHints(value, fields: editor?.fields ?? []))
                    error = nil
                    return
                case .pending(let retryAfterMs):
                    try await Task.sleep(for: scopeRetryDelay(retryAfterMs: retryAfterMs, attempt: attempt))
                }
            } catch is CancellationError { return } catch {
                guard !Task.isCancelled, policy == requested else { return }
                self.error = error
                guard scopePreviewCanRetry(error) else { return }
                try? await Task.sleep(for: scopeRetryDelay(retryAfterMs: nil, attempt: attempt))
            }
        }
    }

    /// What was loaded with one gateway credential says nothing about what another may read.
    private func forgetGatewayState() {
        pickerSession = .init()
        labelHints = []
        previewedPolicy = nil
        editor = nil
        editorGeneration += 1
        error = GatewayClient.Error.unauthorized
    }

    private func leave() {
        if dirty { confirmExit = true } else { dismiss() }
    }

    private func back() {
        if managing { managing = false } else { step = step == .review && mode != .all ? .matches : .mode }
    }

    @ViewBuilder private var footer: some View {
        if disconnected {
            Button(action: finish) { Text(Self.applyTitle) }.buttonStyle(AccessPrimaryButtonStyle()).disabled(!canApply)
        } else {
            stepFooter
        }
    }

    @ViewBuilder private var stepFooter: some View {
        if step == .matches, !listsSelection, refs.isEmpty {
            Text(mode == .only ? scopeFilterEmptySelectionMessage : "Nothing selected. All content will be shared.")
                .accessText(.rowSecondary, color: AccessUI.secondary)
        }
        Button(action: advance) { Text(primaryTitle) }
            .buttonStyle(AccessPrimaryButtonStyle())
            .disabled((step == .mode && mode == .all && commit == .blocked) || (step == .matches && !managing && missingSelection)
                || (step == .review && !canApply))
    }

    private var primaryTitle: String {
        if managing { return "Done" }
        switch step {
        case .mode: return mode == .all ? "Done" : "Continue"
        case .matches: return "Review filter"
        case .review: return Self.applyTitle
        }
    }

    private func advance() {
        if managing {
            managing = false
        } else if step == .review {
            finish()
        } else if step == .mode {
            if mode == .all {
                retainedRefs = refs
            } else if refs.isEmpty, !retainedRefs.isEmpty {
                policy.rules[0].match = retainedRefs
            }
            policy = mode.applying(to: policy)
            if mode == .all { finish() } else { step = .matches }
        } else {
            step = .review
        }
    }

    @ViewBuilder private var modeOptions: some View {
        VStack(spacing: AccessUI.cardGap) {
            modeOption(.all, title: "All content", detail: "Allow all content from this account.")
            modeOption(
                .only,
                title: "Only matching content",
                detail: "Continue to select filters that define which content gets shared."
            )
            modeOption(
                .except,
                title: "Everything except matching content",
                detail: "Continue to select filters that define which content never gets shared."
            )
        }
        if initialPolicy != nil, mode == .all {
            Text("This removes the saved filter for this account.").accessText(.rowSecondary, color: AccessUI.secondary).padding(.top, 12)
        }
    }

    private func modeOption(_ value: ScopeFilterMode, title: String, detail: String) -> some View {
        Button { mode = value } label: { AccessOptionCard(title: title, detail: detail, selected: mode == value) }
            .buttonStyle(.plain)
    }

    /// Everything selected so far, each removable.
    private var selectionContent: some View {
        selectedRows(removable: true)
    }

    /// The saved filter of an account that is no longer connected: what it does and what it names, each removable.
    @ViewBuilder private var disconnectedContent: some View {
        Text("This account is no longer connected. Saved filters can be removed but not added.")
            .accessText(.rowSecondary, color: AccessUI.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(AccessUI.cardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AccessUI.surface, in: .rect(cornerRadius: AccessUI.cardRadius))
            .padding(.bottom, 16)
        modePill
        AccessSectionHeading(Self.selectedFiltersHeading)
        VStack(spacing: 0) { selectedRows(removable: true) }.padding(.top, -AccessUI.rowPadding)
        if mode == .only, refs.isEmpty {
            Text(scopeFilterEmptySelectionMessage).accessText(.rowSecondary, color: AccessUI.secondary)
        }
    }

    private var modePill: some View {
        AccessPill(status: accessFilterModeStatus(policy.editable ? mode.applying(to: policy) : policy))
    }

    @ViewBuilder private func selectedRows(removable: Bool) -> some View {
        if refs.isEmpty { Text("No filters selected").accessText(.rowSecondary, color: AccessUI.secondary).padding(.vertical, 8) }
        ForEach(Array(refs.enumerated()), id: \.offset) { index, ref in
            selectedRow(index, ref: ref, removable: removable && writable, last: index == refs.count - 1)
        }
    }

    /// The filter as it will be applied: what it does, what it names, and what that leaves shared.
    @ViewBuilder private var reviewContent: some View {
        modePill
        AccessSectionHeading(Self.selectedFiltersHeading)
        // The first row brings its own padding; without it the rows would start that much further under the heading.
        VStack(spacing: 0) { selectedRows(removable: false) }.padding(.top, -AccessUI.rowPadding)
        AccessProblemText(text: policy.withinLimits ? nil : scopeFilterLimitMessage)
        AccessSectionHeading("Result")
        result
    }

    private func finish() {
        guard case .apply(let value) = commit else { return }
        guard let client = openedClient, client.isCurrent(store.access) else {
            error = GatewayClient.Error.unauthorized
            return
        }
        hintsChanged(namedHints)
        changed(value)
        dismiss()
    }

    private func selectedRow(_ index: Int, ref: ScopeRef, removable: Bool, last: Bool) -> some View {
        let item = previewItem(index)
        return AccessFilterItemRow(
            ref: ref,
            hint: hint(for: ref),
            noun: scopeFieldNoun(ref, fields: editor?.fields ?? []),
            count: item?.missing == true ? nil : item?.count,
            counting: counting,
            status: item?.missing == true ? "No longer available" : nil,
            last: last
        ) {
            if removable {
                Button { policy.rules[0].match.remove(at: index) } label: {
                    Text("Remove").accessText(.rowTitle, color: Theme.danger).fontWeight(.regular).frame(minHeight: 28)
                }.buttonStyle(.plain)
            }
        }
    }
}

@available(iOS 17.0, *)
extension SourceFilterEditorView {
    /// What the filter leaves shared: the count in progress, why it failed, or the two figures with the gateway's
    /// sentences for records it cannot decide.
    @ViewBuilder private var result: some View {
        if counting {
            HStack(spacing: 10) {
                AccessCountingSpinner()
                Text(scopeCountingText).accessText(.rowSecondary, color: AccessUI.secondary)
            }
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
        } else if let error {
            SourceFilterRetryLine(message: scopePreviewFailureMessage(error)) {
                self.error = nil
                countsGeneration += 1
            }
        } else if let preview = currentPreview {
            AccessStatPair(shared: preview.visible, hidden: preview.hidden)
            let lines = preview.undecidedLines
            if !lines.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(lines, id: \.self) { Text($0).accessText(.rowSecondary) }
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
            }
        }
    }

    /// Resyncs the account in place, the remedy for a field its records predate, then asks the editor again at once
    /// so the field shows its progress.
    func resyncAccount() async {
        guard !resyncStarting else { return }
        guard let admin = store.admin else {
            resyncProblem = GatewayErrorView.classify(GatewayClient.Error.unauthorized).title
            return
        }
        resyncStarting = true
        resyncProblem = nil
        do {
            try await admin.resyncSource(sourceId: source.id, mode: .inPlace)
            editorGeneration += 1
        } catch {
            resyncStarting = false
            resyncProblem = GatewayErrorView.classify(error).title
        }
    }

    /// Loads the account's fields, and again while one is settling or its counts are being worked out.
    func keepEditorCurrent() async {
        var attempt = 0
        while !Task.isCancelled {
            if openedClient == nil { openedClient = store.access }
            guard let client = try? openedClient?.authorized(for: store.access) else {
                if openedClient != nil, editor == nil { editorError = GatewayClient.Error.unauthorized }
                return
            }
            do {
                let value = try await client.filterEditor(sourceId: source.id)
                try Task.checkCancellation()
                guard client.isCurrent(store.access), value.sourceId == source.id else { return }
                editor = value
                editorError = nil
                let waiting = value.fields.contains { if case .needsResync = $0.state { true } else { false } }
                if !waiting { resyncStarting = false }
                guard value.settling || (resyncStarting && waiting) else { return }
                attempt += 1
                try await Task.sleep(for: scopeRetryDelay(retryAfterMs: value.retryAfterMs, attempt: attempt))
            } catch is CancellationError { return } catch {
                if editor == nil { editorError = error }
                return
            }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
extension PreviewMocks {
    /// The filter editor on one of the canonical accounts, opened at a step. `named: false` leaves the
    /// saved items without the names a connected account's lists and counts would give them.
    static func accessFilterEditor(
        _ source: AccessSourceInstance,
        policy: ScopePolicy?,
        editor: SourceFilterEditor? = nil,
        preview: ScopePreview? = nil,
        step: ScopeFilterStep = .mode,
        session: ScopePickerSession = .init(),
        authoringEnabled: Bool = true,
        named: Bool = true
    )
        -> some View {
        SourceFilterEditorView(
            source: source,
            levelId: accessCanonicalLevelId,
            capability: "answer",
            initialPolicy: policy,
            authoringEnabled: authoringEnabled,
            editor: editor ?? accessEditors[source.id],
            preview: preview,
            previewStep: step,
            previewSession: session,
            displayHints: named ? accessCanonicalLabels["answer:" + source.id] ?? [] : []
        ) { _ in }
    }
}

#Preview("Choose what is shared") {
    NavigationStack { PreviewMocks.accessFilterEditor(PreviewMocks.accessWhatsApp, policy: PreviewMocks.accessWhatsAppPolicy) }
        .environment(AppStore.preview())
}

#Preview("Choose folders") {
    NavigationStack {
        PreviewMocks.accessFilterEditor(
            PreviewMocks.accessDrive,
            policy: PreviewMocks.accessDrivePolicy,
            step: .matches,
            session: PreviewMocks.accessFolderSession
        )
    }.environment(AppStore.preview())
}

#Preview("Labels need a resync") {
    NavigationStack {
        PreviewMocks.accessFilterEditor(
            PreviewMocks.accessGmail,
            policy: nil,
            step: .matches,
            session: PreviewMocks.accessLabelSession
        )
    }.environment(AppStore.preview())
}

#Preview("Review a filter") {
    NavigationStack {
        PreviewMocks.accessFilterEditor(
            PreviewMocks.accessWhatsApp,
            policy: PreviewMocks.accessWhatsAppPolicy,
            preview: PreviewMocks.accessWhatsAppPreview,
            step: .review
        )
    }.environment(AppStore.preview())
}

#Preview("Counting") {
    NavigationStack {
        PreviewMocks.accessFilterEditor(PreviewMocks.accessWhatsApp, policy: PreviewMocks.accessWhatsAppPolicy, step: .review)
    }.environment(AppStore.preview())
}

#Preview("Account no longer connected") {
    NavigationStack {
        PreviewMocks.accessFilterEditor(PreviewMocks.accessDisconnectedWhatsApp, policy: PreviewMocks.accessWhatsAppPolicy, named: false)
    }.environment(AppStore.preview())
}

#Preview("Read-only filter") {
    NavigationStack {
        PreviewMocks.accessFilterEditor(
            PreviewMocks.accessWhatsApp,
            policy: PreviewMocks.accessWhatsAppPolicy,
            preview: PreviewMocks.accessWhatsAppPreview,
            authoringEnabled: false
        )
    }.environment(AppStore.preview())
}
#endif

#endif
