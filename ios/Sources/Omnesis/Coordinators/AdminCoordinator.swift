// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import UIKit

/// What a phone-hosted source declares about itself: the name and glyph the
/// phone is the only holder of, pushed onto its `sync_state` row.
struct PhoneSourceIdentity: Sendable {
    let label: String
    let icon: String
}

/// Owns the admin / read-side surface: `AdminClient`, `SearchClient`,
/// `DeviceSocket`, plus the WS event handler and the
/// `applySyncStatusBroadcast` decoder.
///
/// This is one of three coordinators extracted
/// from the former 1267-line `AppStore` god class.
///
/// Cross-coordinator hooks:
///   - `forwardLifecycle(...)` — called from SyncCoordinator after each
///     CollectorCore lifecycle event so the local cache stays in step
///     and the gateway hears the same event.
///   - `registerLocalSources(...)` — public so AppStore can re-run it
///     after toggling `appleHealthEnabled` (HK source instantiation
///     happens in AppStore but the gateway register-call lives here).
@available(iOS 17.0, *)
@MainActor
@Observable
final class AdminCoordinator {
    // MARK: - Observable state

    private(set) var sources: [SourceRecord] = []
    private(set) var pendingSourceRemovals: [PendingSourceRemoval] = []
    /// Gateway-internal sources (a dataset the gateway hosts itself) from the same
    /// `/admin/sources` envelope. Rendered as read-only rows — counters,
    /// recent documents, per-document delete — with no sync actions.
    private(set) var internalSources: [InternalSource] = []
    private(set) var syncStatusesBySource: [String: SourceSyncStatus] = [:]
    private(set) var deviceNamesById: [String: String] = [:]
    private(set) var sourcesLoading: Bool = false
    /// Last error from `refreshSources()`. Stored as the raw `Error`
    /// so consumers can route it through `GatewayErrorView`'s
    /// classifier (URL failure → "Couldn't connect to gateway", auth
    /// failure → "Re-pair from Settings", …).
    private(set) var sourcesError: Error?
    private(set) var wsConnected: Bool = false
    private(set) var wsState: DeviceSocket.ConnectionState = .disconnected
    private(set) var sourceIconByType: [String: String] = [:]
    private(set) var sourceIconById: [String: String] = [:]
    /// Human-friendly source label keyed by source-type ("gmail" → "Gmail")
    /// or full source-id when the provider package publishes a per-instance
    /// override. Populated from `/source-meta` alongside the icon maps.
    private(set) var sourceLabelByType: [String: String] = [:]
    private(set) var sourceLabelById: [String: String] = [:]
    /// Per-source brand colors declared by the provider package — bg
    /// for dark-mode surface fills, accent for chrome. Populated from
    /// `/source-meta` alongside icons and labels. Consumed by the
    /// citation sticky tabs (and later, quote cards) so source-specific
    /// styling stays owned by the provider, not hardcoded in iOS.
    private(set) var sourceBgColorByType: [String: String] = [:]
    private(set) var sourceBgColorById: [String: String] = [:]
    private(set) var sourceAccentColorByType: [String: String] = [:]
    private(set) var sourceAccentColorById: [String: String] = [:]
    /// Device represented by lifecycle events emitted by this app instance.
    private(set) var localDeviceId: String?
    /// Per-source-type unit name ("gmail" → "emails", "strava" →
    /// "activities") declared by the provider package via
    /// `SourceDescriptor.unitName`. Populated from
    /// `/admin/source-descriptors`. Consumers (e.g. the agent search
    /// summary) read from here so source-specific nouns stay owned by
    /// the provider package — adding a new provider with `unitName:
    /// "voicemails"` automatically labels its results correctly.
    private(set) var sourceUnitNameByType: [String: String] = [:]
    private(set) var statusSnapshot: StatusSnapshot?
    private(set) var indexStats: IndexStats?
    /// Count of unread Briefs awaiting attention — drives the badge on
    /// the drawer's Briefs entry. Refreshed on the same cadence the feed
    /// is (when the menu opens); 0 whenever the feature is inactive or the
    /// count read fails. In-app only — never an OS app-icon badge.
    private(set) var briefsUnreadCount: Int = 0
    /// Count of privacy decisions waiting on the owner — drives the badge on
    /// the drawer's Privacy entry. Refreshed when the menu opens; 0 whenever
    /// the count read fails or the app is unpaired. In-app only — never an OS
    /// app-icon badge.
    private(set) var privacyPendingCount: Int = 0
    /// Authorization requests waiting on the owner, newest first — drives the
    /// banner at the top of the home screen. Refreshed on every foreground
    /// and after a review sheet closes; empty whenever the read fails, the
    /// gateway does not report them, or the app is unpaired.
    private(set) var pendingAccessRequests: [AccessPendingRequest] = []

    // MARK: - Private internals

    @ObservationIgnored
    private(set) var adminClient: AdminClient?
    @ObservationIgnored
    private(set) var searchClient: SearchClient?
    private(set) var watchesClient: WatchesClient?
    @ObservationIgnored
    private(set) var briefsClient: BriefsClient?
    @ObservationIgnored
    private(set) var privacyClient: PrivacyClient?
    @ObservationIgnored
    private(set) var accessClient: AccessClient?
    @ObservationIgnored
    private(set) var deviceSocket: DeviceSocket?
    @ObservationIgnored
    private var socketEventTask: Task<Void, Never>?
    @ObservationIgnored
    private var socketStateTask: Task<Void, Never>?
    /// Whether the device socket has connected at least once for the current
    /// pairing. The first connect happens right after `rebuildAdmin`, which
    /// already fetched source-meta + sources, so we skip the refetch then and
    /// only refetch on *re*connects.
    @ObservationIgnored
    private var didInitialConnect = false

    /// Debounces the source-meta refetch triggered when a source comes online
    /// after our one-shot icon load (see `scheduleIconRefetchIfNeeded`).
    @ObservationIgnored
    private var iconRefetchTask: Task<Void, Never>?
    /// Sources this connection has already refetched the icon registry for.
    /// Reset on every (re)connect, since a gateway that restarted may have
    /// learned icons this session never saw. Bookkeeping, not display state —
    /// observing it would redraw every view that reads this coordinator each
    /// time a source is added to the set.
    @ObservationIgnored
    private var iconRefetchAsked: Set<String> = []

    /// Re-reads statuses after events that can change their notices.
    @ObservationIgnored
    let noticeRefresher = SourceNoticeRefresher()

    /// Counts the reads of the waiting access requests, so an older read
    /// still in flight cannot land over a newer one.
    @ObservationIgnored
    private var pendingAccessRequestsGeneration = 0

    @ObservationIgnored
    private var onError: @MainActor (String?) -> Void = { _ in }

    /// Runs a gateway-requested sync for one source, reporting what happened.
    /// Nil until AppStore wires it, which is also the honest answer for a
    /// build that hosts no collector.
    @ObservationIgnored
    private var onSyncRequested: (@Sendable (String) async -> DeviceSocket.SyncDispatch)?
    @ObservationIgnored
    private var onPushAvailable: @MainActor @Sendable () -> Void = {}
    @ObservationIgnored
    private var onConnected: @MainActor () async -> Void = {}

    @ObservationIgnored
    private var sourceRegistryRevision = 0
    @ObservationIgnored
    private var sourceActivations: [String: Int] = [:]
    @ObservationIgnored
    private var pendingSourceResumes: Set<String> = []
    @ObservationIgnored
    private var onSourcesRemoved: @MainActor ([String], Int) -> Void = { _, _ in }

    func setPendingSourceResumes(_ sourceIds: Set<String>) {
        if pendingSourceResumes != sourceIds { sourceRegistryRevision += 1 }
        pendingSourceResumes = sourceIds
    }

    func isSourceResumePending(_ sourceId: String) -> Bool {
        pendingSourceResumes.contains(sourceId)
    }

    /// Registration may still see the old tombstone until creation commits.
    func beginSourceActivation(_ sourceId: String) {
        sourceRegistryRevision += 1
        sourceActivations[sourceId, default: 0] += 1
    }

    func endSourceActivation(_ sourceId: String) {
        sourceRegistryRevision += 1
        let remaining = (sourceActivations[sourceId] ?? 1) - 1
        sourceActivations[sourceId] = remaining > 0 ? remaining : nil
    }

    /// Invalidate reads taken before an explicit local activation.
    func invalidateSourceRegistryRead() {
        sourceRegistryRevision += 1
    }

    func sourceRemovalDeliveryIsCurrent(_ revision: Int) -> Bool {
        revision == sourceRegistryRevision
    }

    func setOnSourcesRemoved(_ handler: @escaping @MainActor ([String], Int) -> Void) {
        onSourcesRemoved = handler
    }

    init() {}

    /// Wire the gateway-driven sync dispatcher. AppStore calls this once in
    /// init; the handler's answer becomes this device's `source.sync`
    /// acknowledgement.
    func setOnSyncRequested(
        _ handler: @escaping @Sendable (String) async -> DeviceSocket.SyncDispatch
    ) {
        onSyncRequested = handler
    }

    func setOnConnected(_ handler: @escaping @MainActor () async -> Void) {
        onConnected = handler
    }

    /// Wire the error funnel. AppStore calls this once during its own
    /// init after constructing the coordinator.
    func setOnError(_ handler: @escaping @MainActor (String?) -> Void) {
        onError = handler
    }

    func setOnPushAvailable(_ handler: @escaping @MainActor @Sendable () -> Void) {
        onPushAvailable = handler
    }

    /// Read-side client exposed to views. `nil` until pairing completes.
    var search: SearchClient? {
        searchClient
    }

    /// Admin client exposed to views — used by the Sources detail
    /// screen's Debug action. `nil` until pairing completes.
    var admin: AdminClient? {
        adminClient
    }

    /// The read-only Watch V2 window, for the Watches tab.
    var watches: WatchesClient? {
        watchesClient
    }

    /// Briefs client exposed to views — used by the Briefs feed tab.
    /// `nil` until pairing completes.
    var briefs: BriefsClient? {
        briefsClient
    }

    /// Privacy client exposed to the global policy, approval, and audit UI.
    var privacy: PrivacyClient? {
        privacyClient
    }

    /// Paired-owner client for code-gated MCP authorization decisions.
    var access: AccessClient? {
        accessClient
    }

    /// Refresh `briefsUnreadCount` from `GET /briefs/count`. Called when
    /// the menu drawer opens (the same refresh-on-open cadence as the
    /// feed). A no-op that zeroes the badge when the feature is disabled
    /// or unpaired; best-effort — any error (including the disabled-feature
    /// 404) zeroes the badge rather than surfacing. The badge is opt-in
    /// attention on a surface the user opened, never a notification.
    func refreshBriefsUnreadCount() async {
        guard statusSnapshot?.briefs?.enabled == true, let client = briefsClient else {
            briefsUnreadCount = 0
            return
        }
        do {
            briefsUnreadCount = try await client.unreadCount()
        } catch {
            briefsUnreadCount = 0
        }
    }

    /// Refresh `privacyPendingCount` from the gateway's ledgers, on the same
    /// refresh-on-open cadence as the Briefs badge. `privacyPendingDecisionTotal`
    /// carries how the number is composed and why. Requests for a standing
    /// watch only exist where the experimental surface that raises them does.
    /// Any failure zeroes the badge rather than surfacing.
    func refreshPrivacyPendingCount() async {
        guard let client = privacyClient else {
            privacyPendingCount = 0
            return
        }
        do {
            privacyPendingCount = try await privacyPendingDecisionTotal(
                client: client,
                includesWatchRequests: statusSnapshot?.experimental == true
            )
        } catch {
            privacyPendingCount = 0
        }
    }

    /// Refresh `pendingAccessRequests` from the access overview. Any failure
    /// empties the list rather than surfacing: a banner is the wrong place
    /// for a network error, and the next foreground asks again. Reads can
    /// overlap — a foreground and a closing review sheet both ask — and only
    /// the latest one started is allowed to land, so a slower, older answer
    /// cannot replace a newer one.
    func refreshPendingAccessRequests() async {
        pendingAccessRequestsGeneration += 1
        let generation = pendingAccessRequestsGeneration
        guard let client = accessClient else {
            pendingAccessRequests = []
            return
        }
        let requests = await (try? client.overview().pendingRequests) ?? []
        guard generation == pendingAccessRequestsGeneration else { return }
        pendingAccessRequests = requests
    }

    // MARK: - Lifecycle

    /// Recreate the AdminClient + SearchClient + DeviceSocket from the
    /// current pairing. Called on pair / unpair / reload.
    func rebuildAdmin(pairing: Pairing, registerLocalSources: @escaping @MainActor (AdminClient, Pairing) async -> Void) {
        stopAdmin()
        localDeviceId = pairing.deviceId
        let admin = AdminClient(
            baseURL: pairing.url,
            token: pairing.token,
            pairingGeneration: pairing.pairingGeneration
        )
        adminClient = admin
        searchClient = SearchClient(baseURL: pairing.url, token: pairing.token)
        watchesClient = WatchesClient(baseURL: pairing.url, token: pairing.token)
        briefsClient = BriefsClient(baseURL: pairing.url, token: pairing.token)
        privacyClient = PrivacyClient(baseURL: pairing.url, token: pairing.token)
        accessClient = AccessClient(baseURL: pairing.url, token: pairing.token)
        let socket = DeviceSocket(gatewayUrl: pairing.url, token: pairing.token)
        deviceSocket = socket
        subscribeSocket(socket)
        Task {
            // Wired before `start()` so a command arriving on the first frame
            // is answered by the collector rather than refused.
            await socket.setOnSyncRequested(onSyncRequested)
            await socket.start()
        }
        // Order matters here: `registerLocalSources` is what pushes
        // iOS-side icons (apple-health) into `sync_state.icon` via
        // `pushSourceIdentity`, while `loadSourceIcons` reads the gateway's
        // `/portal/source-meta.json` to populate the local icon cache
        // the views render from. If they race, `loadSourceIcons` can
        // win and cache yesterday's icon — we then keep showing the
        // stale glyph until the next admin rebuild even though the
        // gateway already has the fresh one. Serialize them.
        Task {
            await registerLocalSources(admin, pairing)
            iconRefetchAsked.removeAll()
            await loadSourceIcons(admin: admin)
        }
        Task { await refreshSources() }
        Task { await refreshGatewayStats() }
    }

    func stopAdmin() {
        sourceRegistryRevision += 1
        socketEventTask?.cancel()
        socketEventTask = nil
        socketStateTask?.cancel()
        socketStateTask = nil
        if let s = deviceSocket {
            Task { await s.stop() }
        }
        deviceSocket = nil
        adminClient = nil
        searchClient = nil
        watchesClient = nil
        briefsClient = nil
        privacyClient = nil
        accessClient = nil
        briefsUnreadCount = 0
        privacyPendingCount = 0
        pendingAccessRequests = []
        // A read still in flight answers for the pairing just dropped.
        pendingAccessRequestsGeneration += 1
        wsConnected = false
        wsState = .disconnected
        didInitialConnect = false
        localDeviceId = nil
    }

    /// Wipe the cached sources / sync-status / device-name maps. Called
    /// from AppStore on unpair so the Status tab doesn't carry over
    /// data from a previous pairing.
    func clearCaches() {
        sourceRegistryRevision += 1
        pendingSourceRemovals = []
        pendingSourceResumes = []
        sources = []
        syncStatusesBySource = [:]
        deviceNamesById = [:]
        noticeRefresher.cancel()
    }

    // MARK: - Source admin

    /// Refetch sources, devices, and sync statuses. Called on appear,
    /// on pull-to-refresh, and when the app returns to the foreground.
    func refreshSources() async {
        guard let admin = adminClient else { return }
        sourceRegistryRevision += 1
        let revision = sourceRegistryRevision
        noticeRefresher.cancel()
        sourcesLoading = true
        defer { sourcesLoading = false }
        do {
            async let srcs = admin.listSourcesAndInternal()
            async let devs = admin.listDevices()
            async let stats = admin.listSyncStatuses()
            let (s, d, st) = try await (srcs, devs, stats)
            guard revision == sourceRegistryRevision else { return }
            let currentIds = Set(s.sources.map(\.id))
            let tombstonedIds = s.removedSourceIds.filter { !currentIds.contains($0) }
            let detachedIds = localDeviceId.map { deviceId in
                s.sources.filter { !$0.hosts(deviceId) }.map(\.id)
            } ?? []
            let removedIds = Array(Set(tombstonedIds + detachedIds)).sorted().filter {
                sourceActivations[$0] == nil && !pendingSourceResumes.contains($0)
            }
            sources = s.sources
            pendingSourceRemovals = s.pendingRemovals
            // A registered row of the same id always wins — an internal id
            // must never shadow a real registration.
            internalSources = s.internalSources.filter { internalSource in
                !s.sources.contains { $0.id == internalSource.id }
            }
            if !removedIds.isEmpty { onSourcesRemoved(removedIds, sourceRegistryRevision) }
            var names: [String: String] = [:]
            for dev in d {
                names[dev.id] = dev.name
            }
            deviceNamesById = names
            var byId: [String: SourceSyncStatus] = [:]
            for sn in st {
                byId[sn.sourceId] = sn
            }
            syncStatusesBySource = byId
            sourcesError = nil
        } catch {
            guard revision == sourceRegistryRevision else { return }
            sourcesError = error
        }
    }

    /// Refresh `/status` + `/index/stats` snapshots used by the Sources
    /// header strip and per-row cells. Tolerant — failures keep the
    /// last-known snapshot rather than blanking the header.
    func refreshGatewayStats() async {
        guard let client = searchClient else { return }
        async let status = try? client.getStatus()
        async let idx = try? client.getIndexStats()
        let (s, i) = await (status, idx)
        if let s {
            statusSnapshot = s
        }
        if let i {
            indexStats = i
        }
    }

    /// Internal sources expose no mutating actions — their buttons are
    /// hidden, so reaching here is a programming error, not user input.
    /// Refuse before the round-trip the gateway would 409 anyway.
    private func requireMutable(_ sourceId: String) throws {
        if isInternalSource(sourceId) { throw GatewayClient.Error.internalSource }
    }

    func triggerSync(sourceId: String) async throws {
        try requireMutable(sourceId)
        guard let admin = adminClient else { throw GatewayClient.Error.invalidResponse }
        try await admin.syncSource(sourceId: sourceId)
    }

    func setEnabled(sourceId: String, enabled: Bool) async throws {
        try requireMutable(sourceId)
        guard let admin = adminClient else { throw GatewayClient.Error.invalidResponse }
        let updated = try await admin.patchSource(sourceId: sourceId, enabled: enabled, config: nil)
        replace(source: updated)
    }

    func removeSource(sourceId: String) async throws {
        try requireMutable(sourceId)
        guard let admin = adminClient else { throw GatewayClient.Error.invalidResponse }
        try await admin.removeSource(sourceId: sourceId)
        sourceRegistryRevision += 1
        sources.removeAll { $0.id == sourceId }
        syncStatusesBySource.removeValue(forKey: sourceId)
        await refreshSources()
    }

    /// Resync: wipe every doc + analytics row for the source, then trigger
    /// a fresh sync.
    func resync(sourceId: String) async throws {
        try requireMutable(sourceId)
        guard let admin = adminClient else { throw GatewayClient.Error.invalidResponse }
        try await admin.deleteAllForSource(sourceId: sourceId)
        try await admin.syncSource(sourceId: sourceId)
    }

    /// Drop a single source from the local caches. Used by AppStore
    /// after `disableAppleHealth` removes the row gateway-side.
    func dropSourceLocally(sourceId: String) {
        if sources.contains(where: { $0.id == sourceId }) { sourceRegistryRevision += 1 }
        sources.removeAll { $0.id == sourceId }
        syncStatusesBySource.removeValue(forKey: sourceId)
    }

    private func replace(source: SourceRecord) {
        sourceRegistryRevision += 1
        if let idx = sources.firstIndex(where: { $0.id == source.id }) {
            sources[idx] = source
        }
    }

    // MARK: - Source icon push (iOS-owned sources)

    /// Build the per-source display registry from the two places the gateway
    /// keeps one: each source's own definition (`/admin/source-descriptors`)
    /// and what the sources themselves have pushed (`source-meta.json`).
    ///
    /// Three rungs, most specific last: a source type's declared art and name,
    /// then the family identity a source pushed for its type, then one
    /// account's own. `SourceIconView` reads the account's before the type's,
    /// so an account that looks different from its siblings still does.
    ///
    /// Icons are stored verbatim — a hosted URL or a full data URI — and
    /// resolved at render time. The descriptor pass also caches the
    /// provider-declared `unitName` per type, which the agent search summary
    /// reads to label result groups ("3 emails", "2 activities") without
    /// hardcoding source-specific knowledge in the UI.
    func loadSourceIcons(admin: AdminClient) async {
        // Descriptors first: they are the family's own declaration, straight
        // from each source's definition, and they exist before any account of
        // that type has ever synced. The meta map is layered on top, so a
        // source that declares nothing about itself in `sync_state` still has
        // a name and a glyph rather than a placeholder — the rung the phone
        // was missing, and Android already had.
        var descriptorIconByType: [String: String] = [:]
        var descriptorLabelByType: [String: String] = [:]
        var descriptorBgByType: [String: String] = [:]
        var descriptorAccentByType: [String: String] = [:]
        var unitByType: [String: String] = [:]
        do {
            for d in try await admin.listDescriptors() {
                if let unit = d.unitName, !unit.isEmpty { unitByType[d.typeId] = unit }
                if !d.name.isEmpty { descriptorLabelByType[d.typeId] = d.name }
                if let art = d.icon?.imageDataUri ?? d.icon?.url, !art.isEmpty {
                    descriptorIconByType[d.typeId] = art
                }
                if let bg = d.icon?.bgColor, !bg.isEmpty { descriptorBgByType[d.typeId] = bg }
                if let accent = d.icon?.color, !accent.isEmpty {
                    descriptorAccentByType[d.typeId] = accent
                }
            }
            sourceUnitNameByType = unitByType
        } catch {
            // Best-effort: the descriptor route needs an online collector, so
            // it is the rung most likely to be missing. Losing it leaves the
            // meta map in charge, exactly as before.
            AppLog.make(category: "app").debug(
                "Could not load source descriptors: \(String(describing: error))"
            )
        }
        do {
            let meta = try await admin.fetchSourceMeta()
            var iconByType: [String: String] = descriptorIconByType
            var iconById: [String: String] = [:]
            var labelByType: [String: String] = descriptorLabelByType
            var labelById: [String: String] = [:]
            var bgByType: [String: String] = descriptorBgByType
            var bgById: [String: String] = [:]
            var accentByType: [String: String] = descriptorAccentByType
            var accentById: [String: String] = [:]
            for (key, entry) in meta {
                let isPerInstance = key.contains(":")
                if let icon = entry.icon, !icon.isEmpty {
                    if isPerInstance {
                        iconById[key] = icon
                    } else {
                        iconByType[key] = icon
                    }
                }
                if let label = entry.label, !label.isEmpty {
                    if isPerInstance {
                        labelById[key] = label
                    } else {
                        labelByType[key] = label
                    }
                }
                if let bg = entry.bgColor, !bg.isEmpty {
                    if isPerInstance {
                        bgById[key] = bg
                    } else {
                        bgByType[key] = bg
                    }
                }
                if let accent = entry.accentColor, !accent.isEmpty {
                    if isPerInstance {
                        accentById[key] = accent
                    } else {
                        accentByType[key] = accent
                    }
                }
            }
            sourceIconByType = iconByType
            sourceIconById = iconById
            sourceLabelByType = labelByType
            sourceLabelById = labelById
            sourceBgColorByType = bgByType
            sourceBgColorById = bgById
            sourceAccentColorByType = accentByType
            sourceAccentColorById = accentById
        } catch {
            AppLog.make(category: "app").debug(
                "Could not load source icons: \(String(describing: error))"
            )
            // The descriptors were read; only the meta layer above them was
            // not. Publish them where nothing is known yet: the rung survives
            // a failure here, and a richer value an earlier load put there is
            // not demoted to it.
            for (type, art) in descriptorIconByType where sourceIconByType[type] == nil {
                sourceIconByType[type] = art
            }
            for (type, label) in descriptorLabelByType where sourceLabelByType[type] == nil {
                sourceLabelByType[type] = label
            }
            for (type, bg) in descriptorBgByType where sourceBgColorByType[type] == nil {
                sourceBgColorByType[type] = bg
            }
            for (type, accent) in descriptorAccentByType where sourceAccentColorByType[type] == nil {
                sourceAccentColorByType[type] = accent
            }
        }
    }

    /// Resolve a friendly source label, preferring a per-instance
    /// override (`gmail:user@x.com`) over the type-level label
    /// (`gmail`). Returns nil when no label is registered — caller
    /// falls back to a humanised slug.
    func sourceLabel(forSourceId sourceId: String) -> String? {
        if let perId = sourceLabelById[sourceId] {
            return perId
        }
        let type = sourceTypeFromId(sourceId)
        return sourceLabelByType[type]
    }

    /// Whether this id is a gateway-internal source (rendered read-only).
    func isInternalSource(_ sourceId: String) -> Bool {
        internalSources.contains { $0.id == sourceId }
    }

    /// A view-layer record for an internal source so the shared row and
    /// detail views render it without nullable surgery. The id doubles as
    /// type and account: labels and icons resolve through the source-meta
    /// feed, counts through `/status`, and every other field is inert —
    /// internal rows never reach a mutating action.
    func internalSourceRecord(for sourceId: String) -> SourceRecord {
        SourceRecord(id: sourceId, type: sourceId, accountId: sourceId, deviceId: "")
    }

    /// Resolve the provider-declared unit name for a source
    /// ("emails", "messages", "activities", …) — read from the
    /// descriptor cache loaded at startup. Returns nil when the
    /// descriptor hasn't been fetched yet or the provider didn't
    /// declare one; the caller falls back to a generic noun.
    ///
    /// Pass the descriptor id (matches `AgentDocRef.sourceType`), NOT
    /// the full sourceId, whose account half matches no entry.
    func sourceUnitName(forSourceType sourceType: String) -> String? {
        sourceUnitNameByType[sourceType]
    }

    /// Push a phone-hosted source's declared identity into its `sync_state`
    /// row: the account's own name and glyph, and the same pair again as its
    /// family's, since a phone-hosted type has exactly one account.
    ///
    /// The phone is the only declarant these types have — there is no provider
    /// package holding a name for them — so a client grouping the corpus by
    /// type has nothing but this to show.
    ///
    /// Treated as best-effort — the cursor-wipe race motivates the
    /// early-return on getSyncState failure.
    func pushSourceIdentity(
        pairing: Pairing,
        sourceId: String,
        identity: PhoneSourceIdentity
    ) async {
        let log = AppLog.make(category: "app")
        let gateway = GatewayClient(baseURL: pairing.url, token: pairing.token)
        let existing: SyncStateResponse?
        do {
            existing = try await gateway.getSyncState(sourceId: sourceId)
        } catch {
            log.warning(
                "pushSourceIdentity: skipped — getSyncState failed for \(sourceId, privacy: .private) (cursor preserved): \(String(describing: error), privacy: .private)"
            )
            return
        }
        guard let existing else {
            log.debug(
                "pushSourceIdentity: no existing sync_state row for \(sourceId, privacy: .private); deferring icon push until first sync"
            )
            return
        }
        let cursor = existing.cursor ?? [:]
        do {
            try await gateway.setSyncState(
                sourceId: sourceId,
                cursor: cursor,
                label: identity.label,
                icon: identity.icon,
                // Identity is chosen by source TYPE, and a phone-hosted source
                // has one account per type — so this account's name and glyph
                // are also its family's. Declaring it says so, instead of
                // leaving a reader to guess a family from one account's row.
                family: SourceFamilyDescriptor(icon: identity.icon, label: identity.label)
            )
        } catch {
            log.warning(
                "Could not push identity for \(sourceId, privacy: .private): \(String(describing: error), privacy: .private)"
            )
        }
    }

    // MARK: - WebSocket

    private func subscribeSocket(_ socket: DeviceSocket) {
        // Consume events + state changes on the main actor. Published state
        // is observed by SwiftUI views via @Observable.
        let events = socket.events
        let states = socket.stateChanges
        socketEventTask = Task { [weak self] in
            for await event in events {
                await MainActor.run { self?.handleEvent(event) }
            }
        }
        socketStateTask = Task { [weak self] in
            for await state in states {
                await MainActor.run { self?.handleState(state) }
            }
        }
    }

    private func handleState(_ state: DeviceSocket.ConnectionState) {
        wsState = state
        switch state {
        case .connected:
            wsConnected = true
            Task { await onConnected() }
            // Refetch the source-meta catalogue (icons, labels, brand colors)
            // and the source list on every *re*connect. After a gateway
            // restart the device socket reconnects but the cached icon maps go
            // stale — without this, citation sticky tabs keep rendering the
            // generic placeholder for the rest of the session. The first
            // connect is already covered by rebuildAdmin, so it's skipped.
            if didInitialConnect {
                if let admin = adminClient {
                    iconRefetchAsked.removeAll()
                    Task { await loadSourceIcons(admin: admin) }
                }
                Task { await refreshSources() }
            } else {
                didInitialConnect = true
            }
        default:
            wsConnected = false
        }
    }

    /// Parse incoming WS events and patch local state. The gateway
    /// pushes these — we never have to ask:
    ///   - `sync.status`: per-source lifecycle (syncing/completed/error)
    ///   - `source.added` / `source.updated` / `source.removed`: registry deltas
    ///   - `documents.upserted`: known-but-not-rendered; we don't display it yet
    ///   - `device.status`: another device came online / went offline
    private func handleEvent(_ event: DeviceSocket.Event) {
        let log = AppLog.make(category: "app")
        switch event.type {
        case "sync.status":
            applySyncStatusBroadcast(payload: event.payload)
        case "source.added", "source.updated":
            sourceRegistryRevision += 1
            if let src = decodeSource(from: event.payload) {
                if let idx = sources.firstIndex(where: { $0.id == src.id }) {
                    sources[idx] = src
                } else {
                    sources.append(src)
                }
            }
        case "source.removed":
            // A delayed detach command may follow an explicit rejoin. Read
            // current membership/tombstones before withdrawing local opt-in.
            sourceRegistryRevision += 1
            Task { await refreshSources() }
        case "device.status":
            log.debug("Ignoring known WS event \(event.type, privacy: .public) (not rendered on iOS)")
        case "documents.upserted":
            log.debug("Ignoring known WS event \(event.type, privacy: .public) (not rendered on iOS)")
        case "push.available":
            onPushAvailable()
        default:
            log.debug("Ignoring WS event \(event.type, privacy: .public)")
        }
    }

    /// Apply a `sync.status` WS broadcast to local state.
    private func applySyncStatusBroadcast(payload: JSONValue) {
        guard let broadcast = SyncStatusBroadcast.decode(payload),
              let sourceId = broadcast.sourceId
        else { return }
        applySyncStatusBroadcast(broadcast, sourceId: sourceId)
    }

    private func applySyncStatusBroadcast(_ broadcast: SyncStatusBroadcast, sourceId: String) {
        let existing = syncStatusesBySource[sourceId]
        let merged = Self.merge(existing: existing, broadcast: broadcast, sourceId: sourceId)
        syncStatusesBySource[sourceId] = merged
        scheduleIconRefetchIfNeeded(forSourceId: sourceId)
        if SourceNoticeRefresher.shouldRead(eventState: broadcast.state, before: existing, after: merged),
           let admin = adminClient {
            noticeRefresher.schedule(
                read: { try await admin.listSyncStatuses() },
                apply: { [weak self] fresh in
                    guard let self else { return }
                    syncStatusesBySource = SourceSyncStatus.adoptingNotices(from: fresh, into: syncStatusesBySource)
                }
            )
        }
    }

    /// The icon/color registry is loaded once per connect from
    /// `/portal/source-meta.json`, which only carries sources whose first sync
    /// had finished by that instant. A source that comes online later (a fresh
    /// synth gateway still ingesting, or a source the user just added) would
    /// otherwise render the generic placeholder in citations for the whole
    /// session. When a `sync.status` arrives for a source whose type we don't
    /// yet have an icon for, refetch the registry. Debounced so a burst of
    /// first-sync broadcasts coalesces into a single fetch.
    private func scheduleIconRefetchIfNeeded(forSourceId sourceId: String) {
        let type = sourceTypeOf(sourceId)
        // Ask about the source the event actually named. Rendering already
        // prefers the per-account entry over the family's, so a source whose
        // own icon is cached needs nothing, whatever its family declares.
        guard sourceIconById[sourceId] == nil, sourceIconByType[type] == nil else { return }
        // At most one refetch per source per connection. A source that has
        // synced and still has no icon has none to fetch — it declares no
        // icon, or its family does not — and without this the next sync
        // event asks again, and every one after it, for the whole session.
        guard !iconRefetchAsked.contains(sourceId), let admin = adminClient else { return }
        iconRefetchAsked.insert(sourceId)
        iconRefetchTask?.cancel()
        iconRefetchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            if Task.isCancelled {
                return
            }
            await self?.loadSourceIcons(admin: admin)
        }
    }

    // MARK: - Lifecycle forwarding (called from SyncCoordinator)

    /// Apply a CollectorCore lifecycle event to the local
    /// `syncStatusesBySource` cache and forward it to the gateway over
    /// the WS so SyncStatusRegistry — and other devices — see the
    /// iOS-side sync in real time.
    ///
    /// The stale-sync reminder side-effect lives on `AppStore` (where
    /// HealthKit ownership is) so this method stays focused on the WS
    /// + local-cache concerns. AppStore drives both via its
    /// `onLifecycleEvent` wiring.
    func forwardLifecycle(_ event: CollectorCore.Lifecycle) async {
        let (sourceId, state, startedAtMs, completedAtMs, errorMessage, processed) = lifecycleFields(event)

        let payload: [String: JSONValue] = {
            var p: [String: JSONValue] = [
                "sourceId": .string(sourceId),
                "state": .string(state),
            ]
            if let startedAtMs {
                p["startedAt"] = .int(Int64(startedAtMs))
            }
            if let completedAtMs {
                p["completedAt"] = .int(Int64(completedAtMs))
            }
            if let errorMessage {
                p["errorMessage"] = .string(errorMessage)
            }
            if let progress = syncStatusProgressPayload(for: event, processed: processed) {
                p["progress"] = .object(progress)
            }
            return p
        }()

        // Optimistic local update — iOS UI flips immediately instead of
        // waiting for the gateway round-trip + broadcast back. Apply it before
        // awaiting the socket so a slow connection cannot stall the row.
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let broadcast = SyncStatusBroadcast(
            sourceId: sourceId,
            deviceId: localDeviceId,
            state: state,
            unitName: nil,
            startedAt: startedAtMs,
            completedAt: completedAtMs,
            lastUpdated: now,
            errorMessage: errorMessage,
            progress: processed.map {
                SyncStatusBroadcast.BroadcastProgress(
                    phase: nil, total: nil, processed: $0, percentComplete: nil, message: nil
                )
            },
            consentExpiresAt: nil,
            staleHint: nil
        )
        applySyncStatusBroadcast(broadcast, sourceId: sourceId)

        await deviceSocket?.emitEvent(type: "sync.status", payload: payload)
    }

    private func lifecycleFields(
        _ event: CollectorCore.Lifecycle
    )
        -> (sourceId: String, state: String, startedAt: Int64?, completedAt: Int64?, errorMessage: String?, processed: Int?) {
        switch event {
        case .started(let sourceId, _, let startedAt):
            (sourceId, "syncing", Int64(startedAt.timeIntervalSince1970 * 1000), nil, nil, nil)
        case .progress(let sourceId, _, let records):
            (sourceId, "syncing", nil, nil, nil, records)
        case .completed(let sourceId, _, let records, let completedAt, _):
            (sourceId, "completed", nil, Int64(completedAt.timeIntervalSince1970 * 1000), nil, records)
        case .error(let sourceId, _, let message):
            (sourceId, "error", nil, nil, message, nil)
        case .idle(let sourceId, _):
            (sourceId, "idle", nil, nil, nil, nil)
        case .sourceRejected(let sourceId, _):
            // Not a sync status — the AppStore intercepts `.sourceRejected`
            // before `forwardLifecycle`, so this never reaches the gateway. The
            // case exists only to keep the switch exhaustive.
            (sourceId, "idle", nil, nil, nil, nil)
        }
    }

    private func decodeSource(from payload: JSONValue) -> SourceRecord? {
        // Event payloads for source.added / source.updated look like { source: {...} }.
        if case .object(let obj) = payload, case .object(let src)? = obj["source"] {
            guard let data = try? JSONEncoder().encode(JSONValue.object(src)) else { return nil }
            return try? JSONDecoder().decode(SourceRecord.self, from: data)
        }
        guard let data = try? JSONEncoder().encode(payload) else { return nil }
        return try? JSONDecoder().decode(SourceRecord.self, from: data)
    }

    // MARK: - SyncStatusBroadcast wire shape + merge

    /// Wire shape of a `sync.status` WS event payload. Mirrors what
    /// `forwardLifecycle` (and the desktop collector) emits. Optional
    /// everywhere — different lifecycle phases populate different
    /// subsets of fields.
    private struct SyncStatusBroadcast: Decodable {
        let sourceId: String?
        let deviceId: String?
        let state: String?
        let unitName: String?
        let startedAt: Int64?
        let completedAt: Int64?
        let lastUpdated: Int64?
        let errorMessage: String?
        let progress: BroadcastProgress?
        /// Forward-looking consent deadline — carried verbatim when the
        /// gateway includes it on a `sync.status` broadcast.
        let consentExpiresAt: String?
        let staleHint: String?

        struct BroadcastProgress: Decodable {
            let phase: String?
            let total: Int?
            let processed: Int?
            let percentComplete: Double?
            let message: String?
        }

        /// Decode from a `JSONValue` by round-tripping through JSONEncoder
        /// → JSONDecoder.
        static func decode(_ json: JSONValue) -> SyncStatusBroadcast? {
            guard let data = try? JSONEncoder().encode(json) else { return nil }
            return try? JSONDecoder().decode(SyncStatusBroadcast.self, from: data)
        }

        /// Map the legacy state string ("completed") onto the canonical UI
        /// form ("synced").
        var canonicalState: String {
            switch state {
            case "completed": "synced"
            case let s?: s
            case nil: "idle"
            }
        }
    }

    /// Pure merge of an incoming WS broadcast into the prior `SourceSyncStatus`.
    /// Static so it's trivially testable in isolation.
    private static func merge(
        existing: SourceSyncStatus?,
        broadcast: SyncStatusBroadcast,
        sourceId: String
    )
        -> SourceSyncStatus {
        let merged = mergeSingle(existing: existing, broadcast: broadcast, sourceId: sourceId)
        guard let deviceId = broadcast.deviceId else {
            // Collector-originated broadcasts do not carry a device id. They
            // update the fleet summary, but must not erase the authoritative
            // per-device rows returned by the status endpoint.
            return merged.replacingMembers(existing?.members)
        }
        guard let priorMembers = existing?.members else {
            return merged
        }

        let priorMember = priorMembers.first(where: { $0.deviceId == deviceId })
        let updatedMember = mergeSingle(existing: priorMember, broadcast: broadcast, sourceId: sourceId)
        var members = priorMembers.filter { $0.deviceId != deviceId }
        members.append(updatedMember)
        return merged.replacingMembers(members)
    }

    private static func mergeSingle(
        existing: SourceSyncStatus?,
        broadcast: SyncStatusBroadcast,
        sourceId: String
    )
        -> SourceSyncStatus {
        let isoFormatter = ISO8601DateFormatter()
        let canonical = preservingDerivedOverlay(broadcast.canonicalState, existing: existing)

        // lastSyncAt: prefer fresh "completed" timestamp; otherwise carry
        // forward what we already have so a "syncing"/"progress" event
        // doesn't blank out the column.
        let lastSyncAt: String? = if let completedAtMs = broadcast.completedAt {
            isoFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(completedAtMs) / 1000))
        } else {
            existing?.lastSyncAt
        }

        // erroredAt: stamp on transition to error; clear on success.
        let erroredAt: String? = switch broadcast.state {
        case "error":
            isoFormatter.string(from: Date())
        case "completed":
            nil
        default:
            existing?.erroredAt
        }

        // Progress is only meaningful while syncing. Carry forward the
        // last-known progress if the new event is a syncing/progress one
        // without an explicit progress payload.
        let progress: SourceSyncStatus.Progress? = if canonical == "syncing" {
            if let p = broadcast.progress {
                SourceSyncStatus.Progress(
                    phase: p.phase,
                    total: p.total,
                    processed: p.processed,
                    percentComplete: p.percentComplete,
                    message: p.message
                )
            } else {
                existing?.progress
            }
        } else {
            nil
        }

        return SourceSyncStatus(
            sourceId: sourceId,
            deviceId: broadcast.deviceId ?? existing?.deviceId,
            state: canonical,
            unitName: broadcast.unitName ?? existing?.unitName,
            progress: progress,
            startedAt: broadcast.startedAt ?? existing?.startedAt,
            lastSyncAt: lastSyncAt,
            errorMessage: broadcast.errorMessage,
            erroredAt: erroredAt,
            lastUpdated: broadcast.lastUpdated ?? existing?.lastUpdated,
            // Carry the consent deadline forward when a broadcast omits it so a
            // plain "syncing"/"progress" event doesn't blank out a known
            // forward-looking expiry.
            consentExpiresAt: broadcast.consentExpiresAt ?? existing?.consentExpiresAt,
            // The remediation sentence belongs to a derived state the broadcast
            // cannot carry, so a sparse event must not blank it.
            staleHint: broadcast.staleHint ?? existing?.staleHint,
            notices: SourceSyncStatus.carriedNotices(
                from: existing,
                state: canonical,
                errorMessage: broadcast.errorMessage
            )
        )
    }
}

/// States the GATEWAY derives on top of a healthy sync — `auth-expiring` (the
/// credential lapses on a known date) and `stale` (the local data feed has
/// stopped delivering). A collector lifecycle event has no way to express
/// either: they are computed server-side from stored data, not reported. So a
/// routine "completed" must not overwrite one, or the warning would be blanked
/// on every sync interval — which, for a stalled source, is precisely when
/// those events keep arriving. The overlay is held until a full
/// /admin/sync/status fetch re-derives it, which is the only thing that can
/// legitimately clear it.
private let derivedOverlayStates: Set<String> = ["auth-expiring", "stale"]

/// Apply `derivedOverlayStates`: keep a prior overlay when the incoming
/// collector state would flatten it back to a plain `synced`.
private func preservingDerivedOverlay(_ incoming: String, existing: SourceSyncStatus?) -> String {
    guard incoming == "synced", let prior = existing?.state, derivedOverlayStates.contains(prior)
    else { return incoming }
    return prior
}

#if DEBUG
@available(iOS 17.0, *)
extension AdminCoordinator {
    /// Stamp in fixture state for SwiftUI previews + the snapshot-test
    /// harness. Lives in the same module as `AdminCoordinator` so it
    /// can write the `private(set)` properties.
    @MainActor
    func installPreviewState(
        sources: [SourceRecord],
        internalSources: [InternalSource] = [],
        statusesBySource: [String: SourceSyncStatus],
        deviceNames: [String: String],
        statusSnapshot: StatusSnapshot?,
        indexStats: IndexStats?,
        wsState: DeviceSocket.ConnectionState?,
        sourceIconByType: [String: String],
        sourceUnitNameByType: [String: String] = [:],
        sourceBgColorByType: [String: String] = [:],
        sourceAccentColorByType: [String: String] = [:],
        briefsUnreadCount: Int = 0,
        privacyPendingCount: Int = 0,
        pendingAccessRequests: [AccessPendingRequest] = [],
        localDeviceId: String? = nil,
        pendingSourceRemovals: [PendingSourceRemoval] = []
    ) {
        self.sources = sources
        self.pendingSourceRemovals = pendingSourceRemovals
        self.internalSources = internalSources
        syncStatusesBySource = statusesBySource
        deviceNamesById = deviceNames
        self.statusSnapshot = statusSnapshot
        self.indexStats = indexStats
        self.briefsUnreadCount = briefsUnreadCount
        self.privacyPendingCount = privacyPendingCount
        self.pendingAccessRequests = pendingAccessRequests
        self.localDeviceId = localDeviceId
        let resolvedState: DeviceSocket.ConnectionState = wsState
            ?? .connected(deviceId: "preview-device", deviceName: "iPhone-preview", scopes: ["read"])
        self.wsState = resolvedState
        if case .connected = resolvedState {
            wsConnected = true
        }
        self.sourceIconByType = sourceIconByType
        self.sourceUnitNameByType = sourceUnitNameByType
        self.sourceBgColorByType = sourceBgColorByType
        self.sourceAccentColorByType = sourceAccentColorByType
    }

    /// Stamp in a sources-fetch error for previews + snapshot tests
    /// that need to exercise the `GatewayErrorView` branches of
    /// `SourcesView` (first-load failure, inline refresh banner).
    @MainActor
    func installPreviewSourcesError(_ error: Error) {
        sourcesError = error
    }

    /// Test-only: inject a (typically stubbed) `AdminClient` so a test can
    /// exercise `handleState`'s reconnect-refetch without pairing.
    @MainActor
    func injectAdminClientForTesting(_ client: AdminClient) {
        adminClient = client
    }

    /// Test-only: inject a stubbed `AccessClient` so a test can drive
    /// `refreshPendingAccessRequests` without pairing.
    @MainActor
    func injectAccessClientForTesting(_ client: AccessClient) {
        accessClient = client
    }

    /// Test-only: drive a device-socket `.connected` transition through the
    /// real `handleState`, so the first-connect-skip / reconnect-refetch
    /// gating can be asserted.
    @MainActor
    func simulateSocketConnectedForTesting() {
        handleState(.connected(deviceId: "dev", deviceName: "iPhone", scopes: ["read"]))
    }

    @MainActor
    func simulateSourceEventForTesting(_ event: DeviceSocket.Event) {
        handleEvent(event)
    }

    @MainActor
    func simulateSyncStatusBroadcastForTesting(_ payload: JSONValue) {
        applySyncStatusBroadcast(payload: payload)
    }
}
#endif

#endif
