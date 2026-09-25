// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Model-management page — mirrors the portal's Settings → Models tab
/// (`packages/gateway/portal/js/views/models.js`). One card per capability
/// (Embedder, Agent, Privacy reviewer, Transcriber, OCR),
/// each showing the current assignment + a three-way state (enabled / needs
/// attention / not configured) and a tap-through to assign or clear the model
/// for that role.
///
/// The assign picker offers the models the gateway already knows about — its
/// installed local GGUFs, Anthropic API entries, and any HTTP backend's
/// role-matching models — and a local-model list that can install (start a
/// gateway-side GGUF download), cancel an in-flight download, or uninstall a
/// downloaded model. Adding new HTTP backends and entering provider credentials
/// live on the Backends screen; this screen sets/clears assignments and manages
/// the local-GGUF lifecycle over the catalog the gateway exposes.
///
/// Source of truth is `GET /admin/models` (+ `GET /admin/system-info` for the
/// fit badge); mutations ride `POST /admin/models/activate` (assignment),
/// `PATCH /admin/config` (backend models + clear), and the local-model
/// lifecycle routes (`/admin/models/install`, `/admin/models/cancel-download`,
/// `DELETE /admin/models/:id`), exactly like the portal. While a download is in
/// flight the overview is polled so the progress bar advances. Mutations follow
/// the established refresh-after-mutation + last-action-wins notice-banner
/// pattern, with a confirm affordance on uninstall.
@available(iOS 17.0, *)
struct ModelsView: View {
    @Environment(AppStore.self) private var store

    @State private var overview: ModelsOverview?
    @State private var system: SystemInfo?
    @State private var loading = true
    @State private var loadError: Error?
    @State private var pollTask: Task<Void, Never>?
    @State private var overviewRefreshGate = ModelOverviewRefreshGate()

    /// Preview-only flag: when true, `.task` never reaches the gateway, so a
    /// seeded snapshot renders deterministically. Always false in production.
    private let isPreview: Bool
    private let initialPickerRole: String?

    init(initialPickerRole: String? = nil) {
        self.isPreview = false
        self.initialPickerRole = initialPickerRole
    }

    #if DEBUG
    /// Preview/snapshot seam: seed the overview + loading flag directly so
    /// snapshots render without a gateway.
    init(
        previewOverview: ModelsOverview?,
        previewLoading: Bool = false,
        previewSystem: SystemInfo? = nil,
        initialPickerRole: String? = nil
    ) {
        self._overview = State(initialValue: previewOverview)
        self._system = State(initialValue: previewSystem)
        self._loading = State(initialValue: previewLoading)
        self.isPreview = true
        self.initialPickerRole = initialPickerRole
    }
    #endif

    var body: some View {
        content
            .navigationTitle("Models")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SettingsBackButton()
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .refreshable { await load() }
            .task { await load() }
            .onDisappear { pollTask?.cancel()
                pollTask = nil
            }
    }

    @ViewBuilder
    private var content: some View {
        if loading, overview == nil, loadError == nil {
            loadingState
        } else if let loadError, overview == nil {
            ScrollView {
                GatewayErrorView(
                    context: "load models",
                    error: loadError,
                    onRetry: { Task { await load() } }
                )
                .frame(minHeight: GatewayErrorView.minScrollHeight)
                .padding(.horizontal, Theme.Spacing.lg)
            }
        } else if let overview {
            ModelsContent(
                overview: overview,
                system: system,
                onAssign: { role, option in try await assign(role: role, option: option) },
                onClear: { role in try await clear(role: role) },
                onSaveBehavior: { role, assignment, values, expectedValues in
                    try await saveBehavior(
                        role: role,
                        assignment: assignment,
                        values: values,
                        expectedValues: expectedValues
                    )
                },
                onInstall: { id in try await install(id: id) },
                onCancelDownload: { id in try await cancelDownload(id: id) },
                onUninstall: { id in try await uninstall(id: id) },
                onAddBackend: { name, url, apiKey, prefix in
                    try await addBackend(name: name, url: url, apiKey: apiKey, apiPathPrefix: prefix)
                },
                onLoadRecent: { role in await loadRecent(role: role) },
                initialPickerRole: initialPickerRole
            )
        }
    }

    private var loadingState: some View {
        VStack {
            ProgressView()
                .tint(Theme.accent)
            Text("Loading models…")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .padding(.top, Theme.Spacing.sm)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Assign one capability, then reload the overview so the new state shows.
    /// Returns the banner text or throws.
    private func assign(role: String, option: ModelManagement.PickerOption) async throws -> String {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        switch option.apply {
        case .activate(let catalogId, let catalogRole, let capabilityRole):
            try await client.activateModel(
                catalogId: catalogId,
                role: catalogRole,
                capability: capabilityRole
            )
        case .assign(let value):
            try await client.assignCapability(role: role, assignment: value)
        }
        await load()
        await store.refreshGatewayStats()
        return "\(option.label) assigned."
    }

    /// Disable one capability (`PATCH /admin/config` with a null assignment),
    /// then reload. Returns the banner text or throws.
    private func clear(role: String) async throws -> String {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.assignCapability(role: role, assignment: nil)
        await load()
        await store.refreshGatewayStats()
        return "Cleared."
    }

    private func saveBehavior(
        role: String,
        assignment: String,
        values: ModelBehaviorValues,
        expectedValues: ModelBehaviorValues
    ) async throws
        -> String {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        do {
            try await client.updateModelBehavior(
                role: role,
                assignment: assignment,
                values: values,
                expectedValues: expectedValues
            )
        } catch {
            if let gatewayError = error as? GatewayClient.Error,
               case .serverError(status: 409, _) = gatewayError {
                await load()
            }
            throw error
        }
        await load()
        return "Inference settings saved."
    }

    /// Start a gateway-side GGUF download for `id`, then reload so the row flips
    /// to its downloading state and the poll loop picks up progress.
    private func install(id: String) async throws -> String {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.installModel(id: id)
        await load()
        return "Downloading \(id)…"
    }

    /// Cancel the in-flight download for `id`, then reload.
    private func cancelDownload(id: String) async throws -> String {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        _ = try await client.cancelModelDownload(id: id)
        await load()
        return "Cancelled \(id)."
    }

    /// Uninstall a downloaded local model, then reload.
    private func uninstall(id: String) async throws -> String {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.uninstallModel(id: id)
        await load()
        return "Removed \(id)."
    }

    /// "Recently used" entries for a capability. Never throws: an unreachable
    /// gateway (or one without the route) yields [], hiding the section.
    private func loadRecent(role: String) async -> [RecentModelEntry] {
        guard let client = store.admin else { return [] }
        return await ModelManagement.loadRecent(client: client, capability: role)
    }

    /// Add (or replace) an HTTP backend from the model picker's add affordance,
    /// probe it so its model list populates, then reload the overview so the new
    /// backend appears in the picker grid. Mirrors `BackendsView.add`.
    private func addBackend(name: String, url: String, apiKey: String?, apiPathPrefix: String?) async throws {
        guard let client = store.admin else { throw URLError(.cannotConnectToHost) }
        try await client.addHttpBackend(key: name, url: url, apiKey: apiKey, apiPathPrefix: apiPathPrefix)
        _ = try? await client.probeBackend(key: name)
        await load()
    }

    private func load() async {
        // Previews never reach the gateway — the seeded state is the snapshot.
        if isPreview { return }
        guard let client = store.admin else {
            loading = false
            return
        }
        loading = true
        loadError = nil
        let ticket: Int
        switch await overviewRefreshGate.fetch({ try await client.modelOverview() }) {
        case .loaded(let fresh, let currentTicket):
            overview = fresh
            loadError = nil
            ticket = currentTicket
        case .failed(let error, let currentTicket):
            loadError = error
            ticket = currentTicket
        case .stale:
            return
        }
        // The fit badge is best-effort: a failed system-info fetch just omits
        // the warnings, it doesn't fail the screen.
        if system == nil {
            let freshSystem = try? await client.systemInfo()
            guard overviewRefreshGate.isCurrent(ticket) else { return }
            system = freshSystem
        }
        guard overviewRefreshGate.isCurrent(ticket) else { return }
        loading = false
        scheduleDownloadPoll()
    }

    /// While any GGUF download is in flight, re-fetch the overview every second
    /// so the progress bar advances and a completed/cancelled download flips the
    /// row back. Mirrors the portal's `useVisiblePoll(refresh, 1000, …)`.
    private func scheduleDownloadPoll() {
        pollTask?.cancel()
        pollTask = nil
        guard overview?.activeDownloads.isEmpty == false, let client = store.admin else { return }
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                guard !loading else { continue }
                guard case .loaded(let fresh, _) = await overviewRefreshGate.fetch({
                    try await client.modelOverview()
                }) else { continue }
                overview = fresh
                if fresh.activeDownloads.isEmpty { return }
            }
        }
    }
}

// MARK: - Content (shared with the preview wrapper)

/// Pure layout over a fixed `overview` so the snapshot test exercises the same
/// view tree the live screen renders. Owns the last-action-wins notice banner +
/// the assign-picker sheet; the mutations themselves delegate to closures.
@available(iOS 17.0, *)
struct ModelsContent: View {
    let overview: ModelsOverview
    /// Host capacity snapshot for the local-model fit badge (nil = no badge).
    var system: SystemInfo?
    /// Assign a model to a role; returns the banner text or throws.
    var onAssign: (String, ModelManagement.PickerOption) async throws -> String = { _, _ in "" }
    /// Clear a role; returns the banner text or throws.
    var onClear: (String) async throws -> String = { _ in "" }
    var onSaveBehavior: (String, String, ModelBehaviorValues, ModelBehaviorValues) async throws -> String = { _, _, _, _ in "" }
    /// Start a gateway-side download for a catalog id; returns banner text.
    var onInstall: (String) async throws -> String = { _ in "" }
    /// Cancel an in-flight download for a catalog id; returns banner text.
    var onCancelDownload: (String) async throws -> String = { _ in "" }
    /// Uninstall a downloaded local model; returns banner text.
    var onUninstall: (String) async throws -> String = { _ in "" }
    /// Add an HTTP backend from the picker's add affordance; throws on failure.
    var onAddBackend: (String, String, String?, String?) async throws -> Void = { _, _, _, _ in }
    /// "Recently used" entries for a capability. Never throws — a failure
    /// yields [], hiding the picker's section.
    var onLoadRecent: (String) async -> [RecentModelEntry] = { _ in [] }
    /// Optional deep link used by focused setup affordances such as the
    /// Briefs warning. Unknown/withheld capabilities safely leave the list up.
    var initialPickerRole: String?

    @State private var notice: Notice?
    @State private var pickerRole: CapabilityMeta?
    @State private var busy = false
    @State private var appliedInitialPickerRole = false

    private struct Notice: Equatable {
        let ok: Bool
        let text: String
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if let notice {
                    noticeBanner(notice)
                }
                NavigationLink {
                    BackendsView()
                } label: {
                    Text("Configure backends")
                }
                .buttonStyle(.bordered)
                .padding(.top, Theme.Spacing.md)
                VStack(spacing: Theme.Spacing.sm) {
                    ForEach(orderedCapabilities) { cap in
                        capabilityCard(cap)
                    }
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.lg)
        }
        .sheet(item: $pickerRole) { cap in
            ModelPickerSheet(
                cap: cap,
                overview: overview,
                system: system,
                currentlyConfigured: ModelManagement.isConfigured(overview.inference.assignments[cap.role]),
                busy: busy,
                onPick: { option in runAssign(role: cap.role, option: option) },
                onClear: { runClear(role: cap.role) },
                onSaveBehavior: { assignment, values, expectedValues in
                    try await onSaveBehavior(cap.role, assignment, values, expectedValues)
                },
                onInstall: { id in runLifecycle { try await onInstall(id) } },
                onCancelDownload: { id in runLifecycle { try await onCancelDownload(id) } },
                onUninstall: { id in runLifecycle { try await onUninstall(id) } },
                onAddBackend: onAddBackend,
                onLoadRecent: onLoadRecent
            )
            .omnesisColorScheme()
        }
        .task {
            guard !appliedInitialPickerRole else { return }
            appliedInitialPickerRole = true
            guard let initialPickerRole else { return }
            pickerRole = overview.capabilities.first { $0.role == initialPickerRole }
        }
    }

    /// Keep the core pipeline first, then the roles that reason over the corpus.
    /// The gateway withholds experimental capabilities in non-experimental mode,
    /// so this group renders whatever is actually available — no client gating
    /// logic. It is not labelled experimental: the interactive Agent lives
    /// here and has shipped.
    private var orderedCapabilities: [CapabilityMeta] {
        overview.capabilities.filter { $0.section != "cognition" }
            + overview.capabilities.filter { $0.section == "cognition" }
    }

    private func capabilityCard(_ cap: CapabilityMeta) -> some View {
        CapabilityCard(
            cap: cap,
            display: overview.assignmentDisplays[cap.role],
            state: ModelManagement.state(overview.inference.assignments[cap.role]),
            reason: overview.inference.assignments[cap.role]?.reason,
            behaviorSummary: ModelManagement.behaviorSummary(role: cap.role, overview: overview),
            onTap: { pickerRole = cap },
            disabled: busy
        )
    }

    /// Run a local-model lifecycle mutation (install / cancel / uninstall),
    /// keeping the picker open (so progress is visible) and surfacing the result
    /// in the shared notice banner — same refresh-after-mutation + last-action
    /// pattern as assign/clear.
    private func runLifecycle(_ op: @escaping () async throws -> String) {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                notice = try await Notice(ok: true, text: op())
            } catch {
                notice = Notice(ok: false, text: "Failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runAssign(role: String, option: ModelManagement.PickerOption) {
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                notice = try await Notice(ok: true, text: onAssign(role, option))
            } catch {
                notice = Notice(ok: false, text: "Assign failed: \(deviceGatewayMessage(error))")
            }
        }
    }

    private func runClear(role: String) {
        pickerRole = nil
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                notice = try await Notice(ok: true, text: onClear(role))
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
}

// MARK: - One capability card

@available(iOS 17.0, *)
private struct CapabilityCard: View {
    let cap: CapabilityMeta
    let display: ModelDisplay?
    let state: ModelManagement.CapabilityState
    let reason: String?
    let behaviorSummary: String?
    var onTap: () -> Void = {}
    var disabled = false

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: ModelCapabilityIcon.symbol(cap.icon))
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(cap.title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                        if cap.experimental {
                            ExperimentalTag()
                        }
                        stateBadge
                    }
                    assignmentLine
                    if let behaviorSummary {
                        Text(behaviorSummary)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(2)
                    }
                    if state == .warn, let reason, !reason.isEmpty {
                        Text(reason)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.warning)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgSecondary)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    @ViewBuilder
    private var assignmentLine: some View {
        if let display, display.configured {
            HStack(spacing: 6) {
                ProviderIcon(providerId: display.providerId, size: 14)
                    .foregroundStyle(Theme.textPrimary)
                Text(modelLabel(display))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        } else {
            Text("Not configured")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
        }
    }

    @ViewBuilder
    private var stateBadge: some View {
        switch state {
        case .on:
            badge(text: "enabled", color: Theme.success)
        case .warn:
            badge(text: "needs attention", color: Theme.warning)
        case .off:
            EmptyView()
        }
    }

    private func badge(text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func modelLabel(_ display: ModelDisplay) -> String {
        if display.modelName.isEmpty { return display.providerLabel }
        return "\(display.providerLabel) · \(display.modelName)"
    }
}

// MARK: - Assign-model picker sheet

@available(iOS 17.0, *)
struct ModelPickerSheet: View {
    let cap: CapabilityMeta
    /// The full overview — drives the backend grid, the per-backend model lists,
    /// the local-model install list, and the presets the add-backend sheet uses.
    let overview: ModelsOverview
    /// Host capacity snapshot for the local-model fit badge (nil = no badge).
    var system: SystemInfo?
    let currentlyConfigured: Bool
    var busy = false
    var onPick: (ModelManagement.PickerOption) -> Void = { _ in }
    var onClear: () -> Void = {}
    var onSaveBehavior: (String, ModelBehaviorValues, ModelBehaviorValues) async throws -> String = { _, _, _ in "" }
    var onInstall: (String) -> Void = { _ in }
    var onCancelDownload: (String) -> Void = { _ in }
    var onUninstall: (String) -> Void = { _ in }
    /// Add an HTTP backend from the picker's add affordance; throws on failure.
    var onAddBackend: (String, String, String?, String?) async throws -> Void = { _, _, _, _ in }
    /// "Recently used" entries for this capability. Never throws — a failure
    /// (including an older gateway without the route) yields [], hiding the
    /// section while the backend grid below still works.
    var onLoadRecent: (String) async -> [RecentModelEntry] = { _ in [] }

    @Environment(\.dismiss) private var dismiss
    /// "Recently used" entries for this capability (empty = hide the section).
    @State private var recent: [RecentModelEntry] = []
    /// The backend whose model list is on screen; nil = the backend grid (pane 1).
    @State private var selectedBackend: String?
    /// Free-text model-search filter inside the model-list pane.
    @State private var search = ""
    /// Typed custom model id for an HTTP backend's "Use" affordance.
    @State private var customModel = ""
    @State private var showAddSheet = false
    /// Catalog id pending an uninstall confirm (drives the confirmation dialog).
    @State private var uninstallConfirm: ModelManagement.LocalModelRow?

    init(
        cap: CapabilityMeta,
        overview: ModelsOverview,
        system: SystemInfo? = nil,
        currentlyConfigured: Bool,
        busy: Bool = false,
        onPick: @escaping (ModelManagement.PickerOption) -> Void = { _ in },
        onClear: @escaping () -> Void = {},
        onSaveBehavior: @escaping (String, ModelBehaviorValues, ModelBehaviorValues) async throws -> String = { _, _, _ in "" },
        onInstall: @escaping (String) -> Void = { _ in },
        onCancelDownload: @escaping (String) -> Void = { _ in },
        onUninstall: @escaping (String) -> Void = { _ in },
        onAddBackend: @escaping (String, String, String?, String?) async throws -> Void = { _, _, _, _ in },
        onLoadRecent: @escaping (String) async -> [RecentModelEntry] = { _ in [] }
    ) {
        self.cap = cap
        self.overview = overview
        self.system = system
        self.currentlyConfigured = currentlyConfigured
        self.busy = busy
        self.onPick = onPick
        self.onClear = onClear
        self.onSaveBehavior = onSaveBehavior
        self.onInstall = onInstall
        self.onCancelDownload = onCancelDownload
        self.onUninstall = onUninstall
        self.onAddBackend = onAddBackend
        self.onLoadRecent = onLoadRecent
    }

    #if DEBUG
    /// Preview/snapshot seam: seed which pane is on screen (`previewSelectedBackend`),
    /// the model-search text, and the "Recently used" entries so the first pane
    /// renders deterministically.
    init(
        cap: CapabilityMeta,
        overview: ModelsOverview,
        system: SystemInfo? = nil,
        currentlyConfigured: Bool,
        previewSelectedBackend: String?,
        previewSearch: String = "",
        previewRecent: [RecentModelEntry] = []
    ) {
        self.cap = cap
        self.overview = overview
        self.system = system
        self.currentlyConfigured = currentlyConfigured
        self._selectedBackend = State(initialValue: previewSelectedBackend)
        self._search = State(initialValue: previewSearch)
        self._recent = State(initialValue: previewRecent)
    }
    #endif

    private var backends: [ModelManagement.PickerBackend] {
        ModelManagement.pickerBackends(capabilityRole: cap.role, overview: overview)
    }

    /// Installable local GGUFs for this capability (empty for ocr).
    private var localModels: [ModelManagement.LocalModelRow] {
        ModelManagement.localModelRows(capabilityRole: cap.role, overview: overview, system: system)
    }

    var body: some View {
        NavigationStack {
            Group {
                if selectedBackend == nil {
                    backendGridPane
                } else {
                    modelListPane
                }
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle(cap.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Remove \(uninstallConfirm?.entry.name ?? "model")?",
                isPresented: Binding(
                    get: { uninstallConfirm != nil },
                    set: { if !$0 { uninstallConfirm = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove", role: .destructive) {
                    if let id = uninstallConfirm?.entry.id { onUninstall(id) }
                    uninstallConfirm = nil
                }
                Button("Cancel", role: .cancel) { uninstallConfirm = nil }
            } message: {
                Text("The model file is deleted from the gateway host. You can re-install it any time.")
            }
            .sheet(isPresented: $showAddSheet) {
                AddBackendSheet(presets: overview.presets, onAdd: { name, url, apiKey, prefix in
                    showAddSheet = false
                    Task { try? await onAddBackend(name, url, apiKey, prefix) }
                })
                .omnesisColorScheme()
            }
            .task(id: cap.role) {
                // Previews/snapshots seed `recent` directly; only fetch when empty.
                // Keyed on the role so a re-presentation for another capability
                // (or any future role-switch without dismiss) refetches.
                if recent.isEmpty {
                    recent = await onLoadRecent(cap.role)
                }
            }
        }
    }

    // MARK: - Pane 1: backend grid

    private var backendGridPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text(cap.description)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)

                if let behavior = ModelManagement.assignedBehavior(role: cap.role, overview: overview) {
                    AssignedModelBehaviorCard(
                        behavior: behavior,
                        display: overview.assignmentDisplays[cap.role],
                        unavailableReason: overview.inference.assignments[cap.role]?.reason,
                        onSave: onSaveBehavior
                    )
                    .id(behavior.assignment)
                }

                if !usableRecent.isEmpty {
                    recentSection
                }

                if backends.isEmpty {
                    emptyBackends
                } else {
                    LazyVGrid(
                        columns: [GridItem(.flexible(), spacing: Theme.Spacing.sm), GridItem(.flexible(), spacing: Theme.Spacing.sm)],
                        spacing: Theme.Spacing.sm
                    ) {
                        ForEach(backends) { backend in
                            backendCard(backend)
                        }
                    }
                }

                Button {
                    showAddSheet = true
                } label: {
                    HStack(spacing: Theme.Spacing.sm) {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 16))
                        Text("Add HTTP backend")
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

                if currentlyConfigured {
                    Button(role: .destructive, action: onClear) {
                        Text("Clear assignment")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, Theme.Spacing.sm)
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.Radius.medium)
                                    .stroke(Theme.danger.opacity(0.4), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .padding(.top, Theme.Spacing.sm)
                }
            }
            .padding(Theme.Spacing.lg)
        }
    }

    /// Recent entries with a usable apply payload (incomplete ones are skipped
    /// rather than offered a dead button). Empty = hide the whole section.
    private var usableRecent: [(entry: RecentModelEntry, option: ModelManagement.PickerOption)] {
        recent.compactMap { entry in
            ModelManagement.recentPickerOption(capabilityRole: cap.role, entry: entry)
                .map { (entry, $0) }
        }
    }

    /// "Recently used" section above the backend grid: one flat row per entry
    /// (provider glyph + model name + Use button) — deliberately not cards, so
    /// it reads as a list, not a second grid.
    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Recently used")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            ForEach(Array(usableRecent.enumerated()), id: \.element.entry.id) { index, pair in
                HStack(spacing: Theme.Spacing.sm) {
                    // Brand mark for preset backends, the generic server glyph
                    // otherwise — the same fallback the backend grid uses.
                    BackendBrandIcon(key: pair.entry.providerId, size: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(pair.entry.modelName.isEmpty ? pair.entry.assignment : pair.entry.modelName)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if !pair.entry.providerLabel.isEmpty {
                            Text(pair.entry.providerLabel)
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textMuted)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    Button("Use") { pickAndReturn(pair.option) }
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .disabled(busy)
                }
                .padding(.vertical, 6)
                if index < usableRecent.count - 1 {
                    Divider()
                }
            }
        }
    }

    private func backendCard(_ backend: ModelManagement.PickerBackend) -> some View {
        Button {
            search = ""
            customModel = ""
            selectedBackend = backend.providerId
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                BackendBrandIcon(
                    key: ModelManagement.logoProviderId(for: backend.providerId, overview: overview),
                    size: 24
                )
                .foregroundStyle(Theme.textPrimary)
                .frame(height: 24)
                Text(backend.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(backendSubtitle(backend))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
            .background(Theme.bgSecondary)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func backendSubtitle(_ backend: ModelManagement.PickerBackend) -> String {
        if let url = backend.url, !url.isEmpty { return url }
        let count = backend.optionCount
        return "\(count) model\(count == 1 ? "" : "s")"
    }

    // MARK: - Pane 2: model list

    @ViewBuilder
    private var modelListPane: some View {
        let backendKey = selectedBackend ?? ""
        let logoProviderId = ModelManagement.logoProviderId(for: backendKey, overview: overview)
        let isHttp = backends.first { $0.providerId == backendKey }?.isHttp ?? false
        let isLocal = backendKey == "local"
        let options = ModelManagement.pickerOptions(
            capabilityRole: cap.role,
            overview: overview,
            forProviderId: backendKey,
            search: search
        )
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Button {
                    selectedBackend = nil
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 12, weight: .semibold))
                        Text("Back")
                            .font(.system(size: 14, weight: .semibold))
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.accent)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                searchField

                if isLocal, !localModels.isEmpty {
                    // The Local pane is the install/cancel/uninstall + use list.
                    VStack(spacing: Theme.Spacing.sm) {
                        ForEach(localModels) { row in
                            localModelRow(row)
                        }
                    }
                } else if options.isEmpty {
                    Text(search.isEmpty ? "No models for this capability." : "No matching models.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                        .padding(.vertical, Theme.Spacing.sm)
                } else {
                    LazyVStack(spacing: Theme.Spacing.sm) {
                        ForEach(options) { option in
                            optionRow(option, logoProviderId: logoProviderId)
                        }
                    }
                }

                if isHttp {
                    customModelField(backendKey: backendKey)
                }
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private var searchField: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textMuted)
            TextField("Search models…", text: $search)
                .font(.system(size: 14))
                .foregroundStyle(Theme.textPrimary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(Theme.Spacing.sm)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    /// Typed custom model id for an HTTP backend — the gateway accepts any model
    /// id the backend serves, even one its probe didn't classify into this role.
    private func customModelField(backendKey: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Or use a custom model id")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            HStack(spacing: Theme.Spacing.sm) {
                TextField("model-id served by \(backendKey)", text: $customModel)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textPrimary)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(Theme.Spacing.sm)
                    .background(Theme.bgSecondary)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.medium)
                            .stroke(Theme.border, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
                Button("Use") { useCustomModel(backendKey: backendKey) }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .disabled(busy || customModel.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(.top, Theme.Spacing.sm)
    }

    private func useCustomModel(backendKey: String) {
        let model = customModel.trimmingCharacters(in: .whitespaces)
        guard !model.isEmpty else { return }
        pickAndReturn(ModelManagement.PickerOption(
            id: "\(backendKey)/\(model)",
            providerId: backendKey,
            label: model,
            detail: backendKey,
            apply: .assign(value: "\(backendKey)/\(model)")
        ))
    }

    // MARK: - Local models (install / cancel / uninstall)

    private func localModelRow(_ row: ModelManagement.LocalModelRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                ProviderIcon(providerId: "local", size: 18)
                    .foregroundStyle(Theme.textPrimary)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(row.entry.name)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if row.entry.recommended == true {
                            tag("Recommended", color: Theme.success)
                        }
                    }
                    Text(localMetaLine(row.entry))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                localTrailingControl(row)
            }
            if case .downloading(let percent) = row.state {
                ProgressView(value: Double(percent), total: 100)
                    .tint(Theme.accent)
            }
            ForEach(row.fitWarnings) { warning in
                Text("⚠ \(warning.text)")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.warning)
                    .lineLimit(2)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    @ViewBuilder
    private func localTrailingControl(_ row: ModelManagement.LocalModelRow) -> some View {
        switch row.state {
        case .downloading(let percent):
            HStack(spacing: 8) {
                Text("\(percent)%")
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .foregroundStyle(Theme.textSecondary)
                Button("Cancel") { onCancelDownload(row.entry.id) }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.danger)
                    .disabled(busy)
            }
        case .installed:
            HStack(spacing: 10) {
                Button("Use") { applyLocal(row) }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .disabled(busy)
                Button("Remove") { uninstallConfirm = row }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.danger)
                    .disabled(busy)
            }
        case .available:
            Button("Install") { onInstall(row.entry.id) }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .disabled(busy)
        }
    }

    /// "Use" an installed local GGUF — assign it to this capability via the same
    /// activate path the model options use.
    private func applyLocal(_ row: ModelManagement.LocalModelRow) {
        guard let catalogRole = ModelManagement.catalogRole(for: cap.role) else { return }
        pickAndReturn(ModelManagement.PickerOption(
            id: "local/\(row.entry.id)",
            providerId: "local",
            label: row.entry.name,
            detail: "Local · downloaded",
            apply: .activate(
                catalogId: row.entry.id,
                catalogRole: catalogRole,
                capabilityRole: cap.role
            )
        ))
    }

    private func localMetaLine(_ entry: CatalogEntry) -> String {
        var parts: [String] = [ModelManagement.formatBytes(entry.sizeBytes)]
        if let params = entry.params, !params.isEmpty { parts.append(params) }
        if let quant = entry.quant, !quant.isEmpty { parts.append(quant) }
        if let minRamGb = entry.minRamGb {
            let ramText = minRamGb == minRamGb.rounded() ? String(Int(minRamGb)) : String(format: "%.1f", minRamGb)
            parts.append("\(ramText) GB RAM")
        }
        return parts.joined(separator: " · ")
    }

    private func tag(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    private func optionRow(_ option: ModelManagement.PickerOption, logoProviderId: String) -> some View {
        Button { pickAndReturn(option) } label: {
            HStack(spacing: Theme.Spacing.sm) {
                BackendBrandIcon(key: logoProviderId, size: 18)
                    .foregroundStyle(Theme.textPrimary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(option.detail)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgSecondary)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .stroke(Theme.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func pickAndReturn(_ option: ModelManagement.PickerOption) {
        selectedBackend = nil
        search = ""
        customModel = ""
        onPick(option)
    }

    private var emptyBackends: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No backends available for this capability.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
            Text("Add an HTTP backend below, or install a local model, then it will show up here.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }
}

// MARK: - Capability icon mapping

/// Maps the gateway's Lucide icon slugs (`CAPABILITY_METADATA[...].icon`) to the
/// nearest SF Symbol. Generic capability presentation, not source-specific.
@available(iOS 17.0, *)
enum ModelCapabilityIcon {
    static func symbol(_ slug: String) -> String {
        switch slug {
        case "binary": "number.square"
        case "bot": "bubble.left.and.text.bubble.right"
        case "shield-check": "checkmark.shield"
        case "mic": "mic"
        case "scan-text": "doc.text.viewfinder"
        default: "cpu"
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("ModelsView — capabilities") {
    NavigationStack {
        ModelsView(
            previewOverview: ModelsPreviewData.overview(),
            previewSystem: ModelsPreviewData.systemInfo()
        )
        .environment(AppStore.preview())
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelsView — loading") {
    NavigationStack {
        ModelsView(previewOverview: nil, previewLoading: true)
            .environment(AppStore.preview())
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelPickerSheet — backend grid") {
    ModelPickerSheet(
        cap: ModelsPreviewData.capabilities.first { $0.role == "agent" }!,
        overview: ModelsPreviewData.overview(),
        system: ModelsPreviewData.systemInfo(),
        currentlyConfigured: true
    )
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelPickerSheet — model list") {
    ModelPickerSheet(
        cap: ModelsPreviewData.capabilities.first { $0.role == "agent" }!,
        overview: ModelsPreviewData.overview(),
        system: ModelsPreviewData.systemInfo(),
        currentlyConfigured: true,
        previewSelectedBackend: "vllm"
    )
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelPickerSheet — recently used") {
    ModelPickerSheet(
        cap: ModelsPreviewData.capabilities.first { $0.role == "agent" }!,
        overview: ModelsPreviewData.overview(),
        system: ModelsPreviewData.systemInfo(),
        currentlyConfigured: true,
        previewSelectedBackend: nil,
        previewRecent: ModelsPreviewData.recentEntries()
    )
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelPickerSheet — assigned without controls") {
    ModelPickerSheet(
        cap: ModelsPreviewData.capabilities.first { $0.role == "agent" }!,
        overview: ModelsPreviewData.overviewWithoutControls(),
        system: ModelsPreviewData.systemInfo(),
        currentlyConfigured: true,
        previewSelectedBackend: nil,
        previewRecent: ModelsPreviewData.recentEntries()
    )
    .preferredColorScheme(.dark)
}

#endif
#endif
