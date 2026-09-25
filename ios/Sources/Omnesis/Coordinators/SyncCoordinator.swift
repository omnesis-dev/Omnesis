// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
#if canImport(BackgroundTasks)
import BackgroundTasks
#endif

/// Owns the collector lifecycle: `CollectorCore`, `OfflineBuffer`,
/// `BackgroundTaskCoordinator`, and the `forwardLifecycle` adapter that
/// bridges collector events back into the WS broadcast surface.
///
/// Per #320, this is one of three coordinators extracted
/// from the former 1267-line `AppStore` god class.
///
/// `AppStore` orchestrates rebuilds across pairing changes — after a
/// `PairingCoordinator.pair(raw:)` succeeds, it calls
/// `SyncCoordinator.rebuildCollector(...)` with the resolved source
/// list (so HealthKit gating stays on the AppStore facade where the
/// user-facing `appleHealthEnabled` flag lives).
///
/// Lifecycle events forwarded to the gateway flow back into
/// `AdminCoordinator.applyLifecycle(...)` via the `onLifecycleApplied`
/// callback so the local `syncStatusesBySource` map stays in sync.
@available(iOS 17.0, *)
@MainActor
@Observable
final class SyncCoordinator {
    private struct DeliveryIdentity: Equatable {
        let token: String
        let accountId: String
        let deviceId: String
        let fingerprint: String?

        init(pairing: Pairing) {
            token = pairing.token
            accountId = pairing.accountId
            deviceId = pairing.deviceId
            fingerprint = pairing.fingerprint
        }
    }

    /// Wall-clock time of the most recent successful sync. Persisted to
    /// `UserDefaults` so a cold launch shows "Last synced N ago" instead
    /// of reverting to "Not synced yet".
    private(set) var lastSyncAt: Date?

    /// Number of un-uploaded batch files in the offline buffer. Polled
    /// after each sync / drain.
    private(set) var bufferedBatches: Int = 0

    /// Age of the oldest un-uploaded batch, or `nil` when the buffer is empty.
    /// A non-empty buffer is normal mid-sync; a buffer whose *oldest* entry
    /// keeps aging is the signal that pushes are not getting through, which is
    /// what `PushHealthBanner` reports.
    private(set) var oldestBufferedAge: TimeInterval?

    /// Batches the uploader gave up on and moved aside (see
    /// `OfflineBuffer.recordPermanentFailure`). They are no longer queued, so
    /// they don't age the backlog — but the data in them never reached the
    /// gateway, which is worth saying out loud rather than swallowing.
    private(set) var quarantinedBatches: Int = 0

    /// Where a user-triggered retry is in its cycle, shared by every surface
    /// that offers one. See `PushHealth.RetryPhase`.
    private(set) var retryPhase: PushHealth.RetryPhase = .idle

    /// True while a sync is in flight. Drives the spinner on the Status
    /// tab and disables the Sync Now button to prevent re-entrancy.
    private(set) var isSyncing: Bool = false

    /// Per-source summaries from the most recent `syncAll`. Used by the
    /// post-sync banner.
    private(set) var lastSyncSummaries: [CollectorCore.SyncSummary] = []

    /// Live per-page progress while a sync is in flight — `nil` when idle.
    private(set) var syncProgress: CollectorCore.Progress?

    /// Sources the gateway refused with 403 on the most recent drain, sorted.
    /// Their data is still buffered on disk and delivers once this device's
    /// token carries the matching `write:<source-type>` scope. Recomputed from
    /// each pass rather than accumulated, so it clears itself once the grant
    /// lands. Rendered by `PushHealthBanner`.
    private(set) var blockedSourceIds: [String] = []

    /// Persistence key for `lastSyncAt` in UserDefaults.
    static let lastSyncAtKey = "omnesis.sync.lastSyncAt"

    @ObservationIgnored
    private(set) var core: CollectorCore?

    @ObservationIgnored
    private(set) var buffer: OfflineBuffer?

    /// The delivery pipeline is pairing-scoped, not source-list-scoped.
    /// Rebuilding `CollectorCore` after a source toggle must keep both objects:
    /// two buffers would cache the same directory independently, and two
    /// uploaders would each believe they own the drain lock.
    @ObservationIgnored
    private(set) var uploader: Uploader?

    @ObservationIgnored
    private var deliveryPairing: Pairing?

    @ObservationIgnored
    private var deliveryIdentity: DeliveryIdentity?

    @ObservationIgnored
    private var deliveryGateway: GatewayClient?

    @ObservationIgnored
    private var deliveryBuffer: OfflineBuffer?

    @ObservationIgnored
    private var deliveryGeneration = 0

    @ObservationIgnored
    private var collectorGeneration = 0

    @ObservationIgnored
    private var replacementRequestGeneration = 0

    @ObservationIgnored
    private let bufferDirectoryProvider: () -> URL

    @ObservationIgnored
    private let gatewayFactory: (Pairing) -> GatewayClient

    @ObservationIgnored
    private let bufferFileManager: FileManager

    #if canImport(BackgroundTasks)
    @ObservationIgnored
    private(set) var bgCoordinator: BackgroundTaskCoordinator?
    #endif

    @ObservationIgnored
    private var onError: @MainActor (String?) -> Void = { _ in }

    /// Called after a CollectorCore lifecycle event fires. AppStore
    /// dispatches: HK reminder schedule + AdminCoordinator forward.
    @ObservationIgnored
    private var onLifecycleApplied: @MainActor (CollectorCore.Lifecycle, Int) async -> Void = { _, _ in }

    /// Late-bound Photos backfill/reconcile action, wired from AppStore
    /// (which owns the `PhotosSource` instance and the enabled flag) —
    /// see `BackgroundTaskCoordinator.PhotosBackfillHandler`.
    @ObservationIgnored
    private var onPhotosBackfillRequested: @Sendable () async -> Void = {}

    init(
        bufferDirectoryProvider: @escaping () -> URL = PairingCoordinator.bufferDirectory,
        bufferFileManager: FileManager = .default,
        gatewayFactory: @escaping (Pairing) -> GatewayClient = {
            GatewayClient(baseURL: $0.url, token: $0.token)
        }
    ) {
        self.bufferDirectoryProvider = bufferDirectoryProvider
        self.bufferFileManager = bufferFileManager
        self.gatewayFactory = gatewayFactory

        // Rehydrate `lastSyncAt` so the Status view shows "Last synced N ago"
        // after a cold launch instead of reverting to "Not synced yet".
        if let ts = UserDefaults.standard.object(forKey: Self.lastSyncAtKey) as? TimeInterval {
            lastSyncAt = Date(timeIntervalSince1970: ts)
        }

        #if canImport(BackgroundTasks)
        // Construct the coordinator eagerly — before pairing, before any
        // core exists. iOS requires BGTaskScheduler.register to be called
        // before applicationDidFinishLaunching returns, and at that point
        // the user may not have paired yet. The coordinator uses late-
        // binding closures that reach back into the live `core` / buffer
        // when the handler actually fires.
        bgCoordinator = BackgroundTaskCoordinator(
            coreProvider: { [weak self] in
                await MainActor.run { self?.core }
            },
            bufferAgeProvider: { [weak self] in
                guard let buffer = await MainActor.run(body: { self?.buffer }) else { return nil }
                return try? await buffer.oldestBatchAge()
            },
            refreshCompleted: { [weak self] in
                await self?.refreshBufferCount()
            },
            photosBackfillHandler: { [weak self] in
                guard let handler = await MainActor.run(body: { self?.onPhotosBackfillRequested }) else { return }
                await handler()
            }
        )
        #endif
    }

    /// Wire the error funnel. AppStore calls this once during its own
    /// init after constructing the coordinator.
    func setOnError(_ handler: @escaping @MainActor (String?) -> Void) {
        onError = handler
    }

    /// Wire the lifecycle hook. Called by AppStore in init.
    func setOnLifecycleApplied(
        _ handler: @escaping @MainActor (CollectorCore.Lifecycle, Int) async -> Void
    ) {
        onLifecycleApplied = handler
    }

    func isCollectorGenerationCurrent(_ generation: Int) -> Bool {
        collectorGeneration == generation
    }

    /// Wire the Photos backfill/reconcile hook. Called by AppStore in
    /// init (it owns the `PhotosSource` instance and enabled flag this
    /// hook needs to check).
    func setOnPhotosBackfillRequested(_ handler: @escaping @Sendable () async -> Void) {
        onPhotosBackfillRequested = handler
    }

    // MARK: - Collector rebuild / teardown

    /// Build a fresh `CollectorCore` for the given pairing and source list.
    /// AppStore is responsible for assembling the sources. The buffer and
    /// uploader survive source-list rebuilds and URL edits for one pairing,
    /// so every core shares one queue cache and one drain lock. A credential
    /// change invalidates the old buffer before a replacement can touch disk.
    func rebuildCollector(pairing: Pairing, sources: [any OmnesisSource]) async {
        replacementRequestGeneration += 1
        let requestGeneration = replacementRequestGeneration
        let previousCore = core
        await previousCore?.retireAndWait()
        guard replacementRequestGeneration == requestGeneration else { return }

        let identity = DeliveryIdentity(pairing: pairing)
        if let previousIdentity = deliveryIdentity, previousIdentity != identity {
            clearCollectorState(invalidateDelivery: true)
            let directory = bufferDirectoryProvider()
            do {
                try bufferFileManager.removeItem(at: directory)
            } catch let error as CocoaError
                where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile {
                // Already empty is the successful end state.
            } catch {
                onError("Could not securely clear pending uploads for the previous pairing.")
                return
            }
        }

        let pairingChanged = deliveryPairing != pairing || deliveryGateway == nil
        let gateway: GatewayClient
        if pairingChanged {
            gateway = gatewayFactory(pairing)
        } else if let existingGateway = deliveryGateway {
            gateway = existingGateway
        } else {
            return
        }
        let buffer: OfflineBuffer
        let uploader: Uploader
        let createdPipeline: Bool
        if let existingBuffer = deliveryBuffer, let existingUploader = self.uploader {
            buffer = existingBuffer
            uploader = existingUploader
            createdPipeline = false
        } else {
            buffer = OfflineBuffer(directory: bufferDirectoryProvider(), fileManager: bufferFileManager)
            uploader = Uploader(gateway: gateway, buffer: buffer)
            deliveryBuffer = buffer
            self.uploader = uploader
            createdPipeline = true
        }

        if pairingChanged {
            deliveryIdentity = identity
            deliveryPairing = pairing
            deliveryGateway = gateway
            uploader.updateGateway(gateway)
        }
        self.buffer = buffer
        if createdPipeline {
            deliveryGeneration += 1
        }
        collectorGeneration += 1
        isSyncing = false
        let generation = collectorGeneration
        let cursorStore = CursorStore(gateway: gateway)

        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: cursorStore,
            uploader: uploader,
            sources: sources,
            prepareSource: Self.sourcePreparation(pairing: pairing),
            onProgress: { [weak self] progress in
                await MainActor.run {
                    guard self?.collectorGeneration == generation else { return }
                    self?.syncProgress = progress
                }
            },
            onLifecycle: { [weak self] event in
                await self?.forwardLifecycle(event, generation: generation)
            }
        )
        self.core = core
        // bgCoordinator already exists from init — its coreProvider
        // closure will now resolve to this new core on its next wake-up.
        Task { await refreshBufferCount() }
    }

    private static func sourcePreparation(pairing: Pairing) -> @Sendable (String, SourceMultiDeviceMode) async throws -> Void {
        let admin = AdminClient(baseURL: pairing.url, token: pairing.token, pairingGeneration: pairing.pairingGeneration)
        return { sourceId, mode in
            guard mode == .partitioned else { return }
            let source = try await admin.listSources().first { $0.id == sourceId }
            try await MobileSourceActivation.prepareHostedPartition(
                source: source,
                deviceId: pairing.deviceId,
                setMode: { sourceId, mode in
                    _ = try await admin.patchSource(sourceId: sourceId, multiDeviceMode: mode)
                }
            )
        }
    }

    /// Tear down collector + buffer. Called on unpair.
    func tearDownCollector() async {
        replacementRequestGeneration += 1
        let requestGeneration = replacementRequestGeneration
        let previousCore = core
        await previousCore?.retireAndWait()
        guard replacementRequestGeneration == requestGeneration else { return }
        clearCollectorState(invalidateDelivery: true)
    }

    private func clearCollectorState(invalidateDelivery: Bool) {
        deliveryGeneration += 1
        collectorGeneration += 1
        if invalidateDelivery {
            deliveryBuffer?.invalidate()
        }
        core = nil
        buffer = nil
        uploader = nil
        deliveryBuffer = nil
        deliveryPairing = nil
        deliveryGateway = nil
        lastSyncAt = nil
        UserDefaults.standard.removeObject(forKey: Self.lastSyncAtKey)
        bufferedBatches = 0
        oldestBufferedAge = nil
        quarantinedBatches = 0
        retryPhase = .idle
        isSyncing = false
        lastSyncSummaries = []
        syncProgress = nil
        blockedSourceIds = []
    }

    // MARK: - Sync / drain (UI-facing)

    func syncAll() async {
        guard let core else { return }
        let generation = collectorGeneration
        isSyncing = true
        // BackgroundTaskGuard: if the user backgrounds the app mid-sync
        // iOS would normally suspend us within seconds, killing any
        // in-flight upload. The guard requests ~30s of continued
        // execution so the current sync can finish cleanly before the
        // OS suspends us.
        let summaries = await BackgroundTaskGuard.run(name: "omnesis.syncAll") {
            await core.syncAll()
        }
        guard collectorGeneration == generation, self.core === core else { return }
        isSyncing = false
        lastSyncSummaries = summaries
        // Union across the passes that actually observed the buffer. A sync
        // whose drain was skipped contributes nil and is ignored rather than
        // counting as evidence that nothing is blocked.
        let observed = summaries.compactMap(\.blocked)
        if !observed.isEmpty {
            blockedSourceIds = Set(observed.flatMap { $0 }).sorted()
        }
        let now = Date()
        lastSyncAt = now
        UserDefaults.standard.set(now.timeIntervalSince1970, forKey: Self.lastSyncAtKey)
        await refreshBufferCount()
    }

    /// Drain the buffer, reporting what the pass amounted to. The return
    /// value is what a user-triggered retry needs: without it a retry that
    /// ran and changed nothing is indistinguishable from a button that did
    /// nothing at all.
    @discardableResult
    func drainPending() async -> DrainOutcome {
        guard let core else { return .idle }
        let generation = deliveryGeneration
        let stats = await BackgroundTaskGuard.run(name: "omnesis.drainPending") {
            await core.drainPending()
        }
        guard deliveryGeneration == generation else { return .idle }
        // A nil `stats` (the drain threw) or a nil `stats.blocked` (another
        // drain owned the buffer) both mean this pass observed nothing — leave
        // the last known set alone rather than reporting "all clear".
        if let observed = stats?.blocked {
            blockedSourceIds = observed.sorted()
        }
        await refreshBufferCount()
        return DrainOutcome(stats)
    }

    /// Drain because the user asked, tracking the attempt so every surface
    /// showing the banner reports the same thing.
    ///
    /// Re-entrant taps are dropped rather than queued: a second pass would
    /// find the buffer already owned, come back `.busy`, and overwrite the
    /// real answer the first one is about to produce.
    func retryDelivery() async {
        guard retryPhase != .running else { return }
        let generation = deliveryGeneration
        retryPhase = .running
        let outcome = await drainPending()
        guard deliveryGeneration == generation else { return }
        retryPhase = .reported(outcome)
    }

    /// Delete the batches the uploader set aside as undeliverable. The only
    /// thing that removes them, and the only way the notice about them
    /// clears — a user acknowledging that the data isn't coming back.
    func discardQuarantined() async {
        guard let buffer else { return }
        let discarded = await (try? buffer.discardQuarantined()) ?? 0
        if discarded > 0 {
            AppLog.make(category: "collector.buffer").notice(
                "Discarded \(discarded, privacy: .public) undeliverable batches"
            )
        }
        await refreshBufferCount()
    }

    /// Trigger a sync for a single source — used by source-specific wake
    /// handlers and the Settings action. Wrapped in `BackgroundTaskGuard` so
    /// the OS gives us continued-execution time when invoked while backgrounded.
    func syncOne(sourceId: String) async {
        guard let core else { return }
        let generation = collectorGeneration
        let summary = await BackgroundTaskGuard.run(name: "omnesis.source-sync") {
            await core.sync(sourceId: sourceId)
        }
        guard collectorGeneration == generation, self.core === core else { return }
        if let observed = summary?.blocked {
            blockedSourceIds = observed.sorted()
        }
        await refreshBufferCount()
    }

    // MARK: - Scene lifecycle

    func onBackground() async {
        // Schedule a background refresh so iOS wakes us later.
        // Also request an *immediate* BG drain if the buffer has stale
        // data — iOS will fulfil it when it next has budget, instead of
        // waiting the full 15 min for the regular refresh window.
        #if canImport(BackgroundTasks)
        bgCoordinator?.scheduleNextRefresh()
        await bgCoordinator?.scheduleImmediateDrainIfStale()
        // Scheduled unconditionally — the handler itself no-ops when
        // Photos isn't enabled (see `onPhotosBackfillRequested`).
        bgCoordinator?.scheduleNextPhotosBackfill()
        #endif
    }

    /// Call once at `@main` launch (from `App.swift`) so BGTaskScheduler
    /// can register our handler before UIApplication finishes launch.
    func registerBackgroundTasks() {
        #if canImport(BackgroundTasks)
        bgCoordinator?.registerHandlers()
        #endif
    }

    // MARK: - Lifecycle forwarding

    /// Forward a CollectorCore lifecycle event by handing it to
    /// AdminCoordinator (which knows the deviceSocket + the local
    /// `syncStatusesBySource` cache). The bridge stays here because the
    /// event source lives on `core` which this coordinator owns.
    private func forwardLifecycle(_ event: CollectorCore.Lifecycle, generation: Int) async {
        guard collectorGeneration == generation else { return }
        await onLifecycleApplied(event, generation)
    }

    func refreshBufferCount() async {
        guard let buffer else {
            bufferedBatches = 0
            oldestBufferedAge = nil
            quarantinedBatches = 0
            return
        }
        let generation = deliveryGeneration
        let snapshot = await (try? buffer.healthSnapshot())
            ?? OfflineBuffer.HealthSnapshot(
                bufferedBatches: 0,
                oldestBufferedAge: nil,
                quarantinedBatches: 0
            )
        guard deliveryGeneration == generation, self.buffer === buffer else { return }

        // Any pass other than the running retry retires that retry's report:
        // it described counts that have now moved, and a stale "couldn't
        // reach Omnesis" sitting under a freshly-changed number is worse
        // than no message at all.
        if case .reported = retryPhase {
            retryPhase = .idle
        }
        bufferedBatches = snapshot.bufferedBatches
        oldestBufferedAge = snapshot.oldestBufferedAge
        quarantinedBatches = snapshot.quarantinedBatches
    }
}

#endif
