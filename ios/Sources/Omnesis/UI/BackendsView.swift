// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// HTTP-backend management + model-provider credentials — mirrors the portal's
/// Backends page (`packages/gateway/portal/js/views/models.js` +
/// `model-config.js`), which manages both. Lists the gateway's configured HTTP
/// inference backends (any OpenAI-compatible server), each with a Test
/// (re-probe) and Remove affordance plus an "Add backend" form, and below them
/// the model-provider credential rows (e.g. the Anthropic API key) with a
/// Set / Clear affordance. Once a backend is reachable (or a provider key is
/// set), its role-matching models show up in the per-capability assign picker
/// (the Models tab).
///
/// Protocol — exactly the portal's, no gateway change:
/// - backends: `GET /admin/models` (`inference.backends`), `PATCH /admin/config`
///   (add = set key, remove = explicit null), `POST /admin/inference/backends/:key/probe`.
/// - credentials: `GET /admin/model-credentials`, `POST`/`DELETE
///   /admin/model-credentials/:fileKey`.
///
/// API keys (the add-backend key and the provider credential values alike) are
/// write-only: sent on submit, never read back, rendered, or logged. The
/// gateway only ever surfaces a `hasApiKey` / `configured` bool.
@available(iOS 17.0, *)
struct BackendsView: View {
    @Environment(AppStore.self) private var store

    @State private var overview: ModelsOverview?
    @State private var credentials: [ModelCredentialEntry] = []
    @State private var loading = true
    @State private var loadError: Error?

    private let isPreview: Bool

    init() {
        self.isPreview = false
    }

    #if DEBUG
    /// Preview/snapshot seam: seed the overview + credentials directly so
    /// snapshots render without a gateway.
    init(
        previewOverview: ModelsOverview?,
        previewCredentials: [ModelCredentialEntry] = [],
        previewLoading: Bool = false
    ) {
        self._overview = State(initialValue: previewOverview)
        self._credentials = State(initialValue: previewCredentials)
        self._loading = State(initialValue: previewLoading)
        self.isPreview = true
    }
    #endif

    var body: some View {
        content
            .navigationTitle("Backends")
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .refreshable { await load() }
            .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if loading, overview == nil, loadError == nil {
            ProgressView()
                .tint(Theme.accent)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError, overview == nil {
            ScrollView {
                GatewayErrorView(
                    context: "load backends",
                    error: loadError,
                    onRetry: { Task { await load() } }
                )
                .frame(minHeight: GatewayErrorView.minScrollHeight)
                .padding(.horizontal, Theme.Spacing.lg)
            }
        } else if let overview {
            BackendsContent(
                backends: ModelManagement.httpBackends(overview),
                codex: overview.inference.codex,
                credentials: credentials,
                presets: overview.presets,
                onProbe: { key in try await probe(key: key) },
                onAdd: { name, url, apiKey, prefix in
                    try await add(name: name, url: url, apiKey: apiKey, apiPathPrefix: prefix)
                },
                onRemove: { key in try await remove(key: key) },
                onCodexRefresh: { try await refreshCodex() },
                onCodexStartLogin: { try await startCodexLogin() },
                onCodexGetLogin: { try await getCodexLogin() },
                onCodexCancelLogin: { try await cancelCodexLogin() },
                onCodexRemove: { try await removeCodex() },
                onVerify: { target, force in
                    try await verify(target: target, force: force)
                },
                onSetCredentials: { fileKey, fields in
                    try await setCredentials(fileKey: fileKey, fields: fields)
                },
                onClearCredentials: { fileKey in try await clearCredentials(fileKey: fileKey) }
            )
        }
    }

    private func probe(key: String) async throws -> ProbeResult {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        let result = try await client.probeBackend(key: key)
        await load()
        return result
    }

    private func add(name: String, url: String, apiKey: String?, apiPathPrefix: String?) async throws {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.addHttpBackend(key: name, url: url, apiKey: apiKey, apiPathPrefix: apiPathPrefix)
        // Probe immediately so the new backend's reachability + model list show.
        _ = try? await client.probeBackend(key: name)
        await load()
    }

    private func remove(key: String) async throws {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.removeHttpBackend(key: key)
        await load()
    }

    private func refreshCodex() async throws -> CodexBackendStatus {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        let status = try await client.refreshCodexBackend()
        await load()
        return status
    }

    private func startCodexLogin() async throws -> CodexLoginFlow {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        return try await client.startCodexLogin()
    }

    private func getCodexLogin() async throws -> CodexLoginFlow? {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        return try await client.getCodexLogin()
    }

    private func cancelCodexLogin() async throws -> CodexCancelLoginResult {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        return try await client.cancelCodexLogin()
    }

    private func removeCodex() async throws -> CodexRemoveResult {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        let result = try await client.removeCodexBackend()
        await load()
        return result
    }

    private func verify(
        target: ModelManagement.VerifyTarget,
        force: Bool
    ) async throws
        -> CapabilityVerdict {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        // Behavioral verify never mutates config, so no reload — the verdict
        // shows inline on the target's row.
        return try await client.verifyModel(
            key: target.backendKey,
            model: target.model,
            role: target.role,
            force: force
        )
    }

    private func setCredentials(fileKey: String, fields: [String: String]) async throws {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.setModelCredentials(fileKey: fileKey, fields: fields)
        await load()
    }

    private func clearCredentials(fileKey: String) async throws {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.clearModelCredentials(fileKey: fileKey)
        await load()
    }

    private func load() async {
        if isPreview { return }
        guard let client = store.admin else {
            loading = false
            return
        }
        loading = true
        loadError = nil
        do {
            // Load both in parallel — the credentials list is small (one row
            // per provider) and independent of the models overview.
            async let overviewTask = client.modelOverview()
            async let credsTask = client.listModelCredentials()
            overview = try await overviewTask
            credentials = try await credsTask
            loadError = nil
        } catch {
            loadError = error
        }
        loading = false
    }
}

// MARK: - Content (shared with the preview wrapper)

/// Pure layout over a fixed backend list + credential list so the snapshot test
/// exercises the same view tree the live screen renders. Owns the add-backend
/// sheet, the set-credentials sheet, the per-row Test state, the remove/clear
/// confirms, and the last-action-wins notice banner; the mutations themselves
/// delegate to closures.
@available(iOS 17.0, *)
struct BackendsContent: View {
    @Environment(\.scenePhase) private var scenePhase

    let backends: [ModelManagement.BackendRow]
    /// Experimental Codex status. Nil when the gateway is not advertising Codex;
    /// non-nil but `configured == false` means it is addable, not listed.
    var codex: CodexBackendStatus?
    /// Model-provider credential rows (e.g. the Anthropic API key).
    var credentials: [ModelCredentialEntry] = []
    /// Provider presets offered by the add-backend sheet's first-step grid.
    var presets: [ProviderPreset] = []
    /// Re-probe one backend; returns its fresh probe result or throws.
    var onProbe: (String) async throws -> ProbeResult = { _ in ProbeResult(ok: true, status: "ok") }
    /// Add a backend; throws on failure.
    var onAdd: (String, String, String?, String?) async throws -> Void = { _, _, _, _ in }
    /// Remove a backend; throws on failure.
    var onRemove: (String) async throws -> Void = { _ in }
    var onCodexRefresh: () async throws -> CodexBackendStatus = {
        CodexBackendStatus(configured: false, status: "unreachable", loggedIn: false, models: [])
    }

    var onCodexStartLogin: () async throws -> CodexLoginFlow = {
        CodexLoginFlow(id: "preview", status: "pending")
    }

    var onCodexGetLogin: () async throws -> CodexLoginFlow? = { nil }
    var onCodexCancelLogin: () async throws -> CodexCancelLoginResult = {
        CodexCancelLoginResult(ok: true, canceled: false, flow: nil)
    }

    var onCodexRemove: () async throws -> CodexRemoveResult = {
        CodexRemoveResult(
            ok: true,
            status: CodexBackendStatus(configured: false, status: "unreachable", loggedIn: false, models: []),
            clearedAssignments: []
        )
    }

    /// Behaviorally verify one (model, role) on a backend; returns the verdict
    /// or throws. `force` bypasses the gateway's verdict cache.
    var onVerify: (ModelManagement.VerifyTarget, Bool) async throws -> CapabilityVerdict
        = { target, _ in CapabilityVerdict(role: target.role, model: target.model, supported: true, detail: "") }
    /// Write a provider's credentials (fileKey + field map); throws on failure.
    var onSetCredentials: (String, [String: String]) async throws -> Void = { _, _ in }
    /// Clear a provider's credentials; throws on failure.
    var onClearCredentials: (String) async throws -> Void = { _ in }

    @State private var notice: Notice?
    @State private var showAddSheet = false
    @State private var showCodexSheet = false
    @State private var confirmRemove: String?
    @State private var confirmRemoveCodex = false
    @State private var editingCredential: ModelCredentialEntry?
    @State private var confirmClearCredential: ModelCredentialEntry?
    @State private var probeStates: [String: ProbeState] = [:]
    @State private var codexLoginFlow: CodexLoginFlow?
    @State private var codexAutoChecking = false
    /// Per-(backend, model, role) verify state, keyed by `VerifyTarget.id`.
    @State private var verifyStates: [String: VerifyState] = [:]
    /// The backend whose detail (verify-capabilities) view is pushed, if any.
    @State private var detailRow: ModelManagement.BackendRow?
    @State private var busy = false

    private struct Notice: Equatable {
        let ok: Bool
        let text: String
    }

    enum ProbeState: Equatable {
        case idle
        case probing
        case ok(Int)
        /// Host answered, but its model list couldn't be fetched. Usable with a
        /// manually-assigned model id; carries the probe reason (e.g. "HTTP 500").
        case reachable(String)
        case fail(String)
    }

    /// State of a single (model, role) verify affordance + its inline result.
    /// Internal (not fileprivate) so the snapshot test can seed each state on a
    /// `VerifyRow` directly.
    enum VerifyState: Equatable {
        case idle
        case verifying
        /// Behavioral verdict: `supported` true/false + the gateway's detail line.
        case verdict(supported: Bool, detail: String)
        /// The verify request itself failed (network, auth, 4xx/5xx).
        case error(String)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if let notice {
                    noticeBanner(notice)
                }
                addButton
                if let codex, codex.configured {
                    FlatSection("Codex") {
                        CodexRowCard(
                            status: codex,
                            onManage: { showCodexSheet = true },
                            onRefresh: { runCodexRefresh() },
                            onRemove: { confirmRemoveCodex = true },
                            disabled: busy
                        )
                    }
                }
                FlatSection("HTTP backends") {
                    if backends.isEmpty {
                        emptyState
                    } else {
                        VStack(spacing: Theme.Spacing.sm) {
                            ForEach(backends) { row in
                                BackendRowCard(
                                    row: row,
                                    probe: probeStates[row.key] ?? .idle,
                                    onOpen: { detailRow = row },
                                    onTest: { runProbe(key: row.key) },
                                    onRemove: { confirmRemove = row.key },
                                    disabled: busy
                                )
                            }
                        }
                    }
                }
                if !credentials.isEmpty {
                    FlatSection("Provider credentials") {
                        VStack(spacing: Theme.Spacing.sm) {
                            ForEach(credentials) { entry in
                                CredentialRowCard(
                                    entry: entry,
                                    onSet: { editingCredential = entry },
                                    onClear: { confirmClearCredential = entry },
                                    disabled: busy
                                )
                            }
                        }
                    }
                }
                footerNote
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.lg)
        }
        .navigationDestination(item: $detailRow) { row in
            BackendDetailView(
                row: row,
                verifyStates: verifyStates,
                onVerify: { target in runVerify(target: target, force: false) },
                onReVerify: { target in runVerify(target: target, force: true) },
                disabled: busy
            )
        }
        .sheet(isPresented: $showAddSheet) {
            AddBackendSheet(presets: presets, codex: codex, onAdd: { name, url, apiKey, prefix in
                runAdd(name: name, url: url, apiKey: apiKey, apiPathPrefix: prefix)
            }, onConfigureCodex: {
                showCodexSheet = true
            })
            .omnesisColorScheme()
        }
        .sheet(isPresented: $showCodexSheet) {
            CodexSetupSheet(
                status: codex,
                flow: codexLoginFlow,
                busy: busy || codexAutoChecking,
                autoChecking: codexAutoChecking,
                onStartLogin: { runCodexStartLogin() },
                onCheckLogin: { runCodexCheckLogin() },
                onRefresh: { runCodexRefresh() },
                onCancelLogin: { runCodexCancelLogin() },
                onRemove: { confirmRemoveCodex = true }
            )
            .omnesisColorScheme()
        }
        .sheet(item: $editingCredential) { entry in
            SetCredentialSheet(entry: entry, onSave: { fields in
                runSetCredentials(fileKey: entry.fileKey, fields: fields)
            })
            .omnesisColorScheme()
        }
        .alert(
            "Remove backend?",
            isPresented: Binding(
                get: { confirmRemove != nil },
                set: { if !$0 { confirmRemove = nil } }
            ),
            presenting: confirmRemove
        ) { key in
            Button("Remove", role: .destructive) { runRemove(key: key) }
            Button("Cancel", role: .cancel) { confirmRemove = nil }
        } message: { key in
            Text("Remove \"\(key)\"? Any capability using this backend will become unavailable.")
        }
        .alert("Remove Codex?", isPresented: $confirmRemoveCodex) {
            Button("Remove", role: .destructive) { runCodexRemove() }
            Button("Cancel", role: .cancel) { confirmRemoveCodex = false }
        } message: {
            Text("Log out Codex on the gateway host and clear any Codex assignment.")
        }
        .alert(
            "Clear credentials?",
            isPresented: Binding(
                get: { confirmClearCredential != nil },
                set: { if !$0 { confirmClearCredential = nil } }
            ),
            presenting: confirmClearCredential
        ) { entry in
            Button("Clear", role: .destructive) { runClearCredentials(entry: entry) }
            Button("Cancel", role: .cancel) { confirmClearCredential = nil }
        } message: { entry in
            Text("Clear the \(entry.providerName) credentials? Any capability using \(entry.providerName) will become unavailable.")
        }
        .task(id: codexLoginPollKey) {
            guard let flowId = codexLoginPollKey else { return }
            await runCodexLoginPollingLoop(flowId: flowId)
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else { return }
            runCodexAutoCheckLogin()
        }
    }

    private var codexLoginPollKey: String? {
        guard Self.shouldAutoPollCodexLogin(showSheet: showCodexSheet, flow: codexLoginFlow, status: codex) else {
            return nil
        }
        return codexLoginFlow?.id
    }

    private var addButton: some View {
        Button {
            showAddSheet = true
        } label: {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 16))
                Text("Add backend")
                    .font(.system(size: 14, weight: .semibold))
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.accent)
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.accent.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private func runProbe(key: String) {
        probeStates[key] = .probing
        notice = nil
        Task {
            do {
                let result = try await onProbe(key)
                switch result.status {
                case "ok":
                    probeStates[key] = .ok(result.models.count)
                case "reachable":
                    probeStates[key] = .reachable(result.reason ?? "no model list")
                default:
                    probeStates[key] = .fail(result.reason ?? "unreachable")
                }
            } catch {
                probeStates[key] = .fail(deviceGatewayMessage(error))
            }
        }
    }

    private func runVerify(target: ModelManagement.VerifyTarget, force: Bool) {
        verifyStates[target.id] = .verifying
        Task {
            do {
                let verdict = try await onVerify(target, force)
                verifyStates[target.id] = .verdict(supported: verdict.supported, detail: verdict.detail)
            } catch {
                verifyStates[target.id] = .error(deviceGatewayMessage(error))
            }
        }
    }

    private func runAdd(name: String, url: String, apiKey: String?, apiPathPrefix: String?) {
        showAddSheet = false
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                try await onAdd(name, url, apiKey, apiPathPrefix)
                notice = Notice(ok: true, text: "Added backend \"\(name)\".")
            } catch {
                notice = Notice(ok: false, text: "Add failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runRemove(key: String) {
        confirmRemove = nil
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                try await onRemove(key)
                probeStates[key] = nil
                // Drop the removed backend's stale per-(model, role) verdicts —
                // their keys are `"<backendKey>/<model>/<role>"`.
                verifyStates = verifyStates.filter { !$0.key.hasPrefix("\(key)/") }
                notice = Notice(ok: true, text: "Removed backend \"\(key)\".")
            } catch {
                notice = Notice(ok: false, text: "Remove failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runCodexStartLogin() {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                codexLoginFlow = try await onCodexStartLogin()
                notice = Notice(ok: true, text: "Codex login started.")
            } catch {
                notice = Notice(ok: false, text: "Codex login failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runCodexCheckLogin() {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            await pollCodexLogin(userInitiated: true)
        }
    }

    private func runCodexAutoCheckLogin() {
        guard Self.shouldAutoPollCodexLogin(showSheet: showCodexSheet, flow: codexLoginFlow, status: codex) else {
            return
        }
        Task {
            await pollCodexLogin(userInitiated: false)
        }
    }

    private func runCodexLoginPollingLoop(flowId: String) async {
        while !Task.isCancelled, codexLoginPollKey == flowId {
            await pollCodexLogin(userInitiated: false)
            guard codexLoginPollKey == flowId else { return }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    private func pollCodexLogin(userInitiated: Bool) async {
        guard !codexAutoChecking else { return }
        codexAutoChecking = true
        defer { codexAutoChecking = false }

        do {
            let flow = try await onCodexGetLogin()
            codexLoginFlow = flow

            if flow?.status == "pending" {
                if userInitiated {
                    let status = try await onCodexRefresh()
                    if status.loggedIn {
                        codexLoginFlow = nil
                        notice = Notice(ok: true, text: "Codex is logged in.")
                    } else {
                        notice = Notice(ok: false, text: status.reason ?? "Codex login is not complete yet.")
                    }
                }
                return
            }

            let status = try await onCodexRefresh()
            if status.loggedIn {
                codexLoginFlow = nil
                notice = Notice(ok: true, text: "Codex is logged in.")
            } else if let flow, flow.status == "failed" {
                notice = Notice(ok: false, text: flow.reason ?? status.reason ?? "Codex login failed.")
            } else if userInitiated {
                notice = Notice(ok: false, text: status.reason ?? "Codex login is not complete yet.")
            }
        } catch {
            if userInitiated {
                notice = Notice(ok: false, text: "Codex check failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runCodexRefresh() {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                let status = try await onCodexRefresh()
                notice = status.status == "ok"
                    ? Notice(ok: true, text: "Codex model list refreshed.")
                    : Notice(ok: false, text: status.reason ?? "Codex is not reachable.")
            } catch {
                notice = Notice(ok: false, text: "Codex refresh failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runCodexCancelLogin() {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                let result = try await onCodexCancelLogin()
                codexLoginFlow = result.flow
                notice = Notice(ok: true, text: result.canceled ? "Codex login canceled." : "No active Codex login.")
            } catch {
                notice = Notice(ok: false, text: "Cancel failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runCodexRemove() {
        confirmRemoveCodex = false
        showCodexSheet = false
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                _ = try await onCodexRemove()
                codexLoginFlow = nil
                notice = Notice(ok: true, text: "Removed Codex backend.")
            } catch {
                notice = Notice(ok: false, text: "Remove failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runSetCredentials(fileKey: String, fields: [String: String]) {
        let providerName = credentials.first { $0.fileKey == fileKey }?.providerName ?? fileKey
        editingCredential = nil
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                try await onSetCredentials(fileKey, fields)
                notice = Notice(ok: true, text: "Saved \(providerName) credentials.")
            } catch {
                notice = Notice(ok: false, text: "Save failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runClearCredentials(entry: ModelCredentialEntry) {
        confirmClearCredential = nil
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                try await onClearCredentials(entry.fileKey)
                notice = Notice(ok: true, text: "Cleared \(entry.providerName) credentials.")
            } catch {
                notice = Notice(ok: false, text: "Clear failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func noticeBanner(_ notice: Notice) -> some View {
        Text(notice.text)
            .font(.system(size: 12))
            .foregroundStyle(notice.ok ? Theme.success : Theme.danger)
            .padding(Theme.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background((notice.ok ? Theme.success : Theme.danger).opacity(0.10))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.medium)
                    .stroke((notice.ok ? Theme.success : Theme.danger).opacity(0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No HTTP backends configured.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
            Text("Add one to point Omnesis at any OpenAI-compatible server (a local vLLM/Ollama, or a cloud provider).")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    private var footerNote: some View {
        Text(
            "Backends and provider keys are shared across every capability. "
                + "After adding a backend, logging in to Codex, or setting a key, assign its models from the Models tab."
        )
        .font(.system(size: 11))
        .foregroundStyle(Theme.textMuted)
        .padding(.top, Theme.Spacing.sm)
    }

    /// String for the per-row probe state. Pure so the snapshot test can assert
    /// it without a live gateway.
    static func probeLabel(_ state: ProbeState) -> (text: String, color: Color)? {
        switch state {
        case .idle: nil
        case .probing: ("Testing…", Theme.textMuted)
        case .ok(let count): ("Reachable · \(count) model\(count == 1 ? "" : "s")", Theme.success)
        case .reachable(let reason): ("No model list · \(reason)", Theme.warning)
        case .fail(let reason): (reason, Theme.danger)
        }
    }

    static func shouldAutoPollCodexLogin(
        showSheet: Bool,
        flow: CodexLoginFlow?,
        status: CodexBackendStatus?
    )
        -> Bool {
        showSheet && flow?.status == "pending" && status?.loggedIn != true
    }
}
#endif
