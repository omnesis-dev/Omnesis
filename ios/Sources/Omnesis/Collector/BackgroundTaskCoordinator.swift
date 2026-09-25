// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(BackgroundTasks) && canImport(UIKit)
import BackgroundTasks
import UIKit

/// Wires `CollectorCore` into `BGTaskScheduler`. Two responsibilities:
///
///   1. On app launch, register a handler for
///      the app's declared refresh task. iOS calls it (opportunistically,
///      when device is charging / connected to Wi-Fi / user engagement
///      warrants) to give us a chance to drain + sync.
///   2. On app background, schedule the next invocation so iOS has a
///      reason to wake us later.
///
/// This is defensive. The primary driver in Phase 3 will be
/// `HKObserverQuery` with `enableBackgroundDelivery`, which wakes the
/// app within seconds of new HealthKit data. The BG task just catches
/// what the observer misses (e.g. if HealthKit didn't coalesce fast
/// enough, or if we were force-killed by the OS).
@available(iOS 17.0, *)
public final class BackgroundTaskCoordinator {
    public static var refreshIdentifier: String {
        "\(appBundleIdentifier).refresh"
    }

    /// Photos backfill (#169) — OCR is CPU-heavy and a photo library can
    /// take many cycles to drain, so it gets its own `BGProcessingTask`
    /// (network- and, unlike the tiny `BGAppRefreshTask` above, NOT
    /// time-boxed to ~30s) rather than riding the refresh task.
    public static var photosBackfillIdentifier: String {
        "\(appBundleIdentifier).photosBackfill"
    }

    private static var appBundleIdentifier: String {
        guard let identifier = Bundle.main.bundleIdentifier else {
            preconditionFailure("Background tasks require an app bundle identifier")
        }
        return identifier
    }

    /// Late-bound lookup of the current `CollectorCore`. Returns nil when
    /// the app isn't paired yet (coordinator is constructed at `@main`
    /// launch, before the user pairs — pairing creates the core later).
    public typealias CoreProvider = @Sendable () async -> CollectorCore?

    /// Late-bound buffer-staleness probe. Returns the age of the oldest
    /// undrained batch (or nil if the buffer is empty / unpaired).
    public typealias BufferAgeProvider = @Sendable () async -> TimeInterval?

    /// Late-bound Photos backfill/reconcile action. No-ops when Photos
    /// isn't enabled (the closure itself is responsible for checking) —
    /// scheduling stays unconditional (see `scheduleNextPhotosBackfill`)
    /// so this coordinator doesn't need to know about the Photos
    /// enabled flag, matching `coreProvider`'s "resolves to nothing
    /// before pairing" shape.
    public typealias PhotosBackfillHandler = @Sendable () async -> Void

    /// Refresh observable delivery-health state after background work mutates
    /// the buffer. This coordinator owns no UI state, so its caller supplies
    /// the hop back to the state owner.
    public typealias RefreshCompletedHandler = @Sendable () async -> Void

    private let coreProvider: CoreProvider
    private let bufferAgeProvider: BufferAgeProvider
    private let refreshCompleted: RefreshCompletedHandler
    private let photosBackfillHandler: PhotosBackfillHandler
    private let log = AppLog.make(category: "collector.bg")

    public init(
        coreProvider: @escaping CoreProvider,
        bufferAgeProvider: @escaping BufferAgeProvider = { nil },
        refreshCompleted: @escaping RefreshCompletedHandler = {},
        photosBackfillHandler: @escaping PhotosBackfillHandler = {}
    ) {
        self.coreProvider = coreProvider
        self.bufferAgeProvider = bufferAgeProvider
        self.refreshCompleted = refreshCompleted
        self.photosBackfillHandler = photosBackfillHandler
    }

    /// Call once on app launch (from `App.swift`). Registers the BG
    /// task handlers so iOS can route background wakes to us. MUST be
    /// called before `UIApplication` finishes launch or iOS will reject
    /// the first `submit(...)` call for either identifier.
    public func registerHandlers() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.refreshIdentifier,
            using: nil
        ) { [weak self] task in
            guard let self else { task.setTaskCompleted(success: false)
                return
            }
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handle(task: refreshTask)
        }
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.photosBackfillIdentifier,
            using: nil
        ) { [weak self] task in
            guard let self else { task.setTaskCompleted(success: false)
                return
            }
            guard let processingTask = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handle(task: processingTask)
        }
    }

    /// Schedule the next BG refresh. Call on `scenePhase == .background`.
    /// `earliestBeginDate` is a hint — iOS picks the actual moment.
    public func scheduleNextRefresh(after delay: TimeInterval = 15 * 60) {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: delay)
        do {
            try BGTaskScheduler.shared.submit(request)
            log.notice("Scheduled BG refresh in \(Int(delay), privacy: .public)s")
        } catch {
            log.warning("BGTask submit failed: \(String(describing: error), privacy: .private)")
        }
    }

    /// Stale-buffer safety-drain. Called on `scenePhase == .background`
    /// alongside the normal refresh scheduling: if the offline buffer
    /// already has undrained batches older than `threshold`, submit an
    /// *immediate* BGTask (earliestBeginDate = now) in addition to the
    /// regular ~15 min one. iOS still decides the actual run moment,
    /// but it prioritises zero-delay requests so stuck data drains as
    /// soon as the OS has budget instead of waiting for the next HK
    /// observer fire.
    public func scheduleImmediateDrainIfStale(
        threshold: TimeInterval = 30 * 60
    ) async {
        guard let age = await bufferAgeProvider(), age >= threshold else { return }
        log.notice("Buffer has undrained batches \(Int(age), privacy: .public)s old — requesting immediate BG drain")
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = nil // "as soon as possible"
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // If we already scheduled a refresh for ~15 min from now,
            // this will fail with "too many pending" — fine, the
            // regular one will still fire.
            log.debug("Immediate BGTask submit failed (likely already scheduled): \(String(describing: error), privacy: .private)")
        }
    }

    /// Schedule the next Photos backfill/reconcile pass. Call on
    /// `scenePhase == .background` alongside `scheduleNextRefresh` —
    /// unconditionally (the handler itself no-ops when Photos isn't
    /// enabled), matching `coreProvider`'s late-binding shape.
    /// `.requiresNetworkConnectivity` because photo document uploads
    /// need network, unlike the tiny call-log/health payloads the
    /// plain refresh task also carries.
    public func scheduleNextPhotosBackfill(after delay: TimeInterval = 15 * 60) {
        let request = BGProcessingTaskRequest(identifier: Self.photosBackfillIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: delay)
        request.requiresNetworkConnectivity = true
        do {
            try BGTaskScheduler.shared.submit(request)
            log.notice("Scheduled Photos backfill in \(Int(delay), privacy: .public)s")
        } catch {
            log.warning("Photos BGTask submit failed: \(String(describing: error), privacy: .private)")
        }
    }

    // MARK: - Internals

    /// Execute the refresh body independently of `BGTask` so the buffer
    /// mutation and its observable-state refresh remain one operation.
    func performRefresh() async {
        guard let core = await coreProvider() else { return }
        _ = await core.drainPending()
        _ = await core.syncAll()
        await refreshCompleted()
    }

    private func handle(task: BGAppRefreshTask) {
        log.notice("BG refresh fired")
        // Re-schedule before any real work so iOS keeps routing wakes.
        scheduleNextRefresh()

        let work = Task { [weak self] in
            await self?.performRefresh()
        }
        task.expirationHandler = { work.cancel() }

        Task { [work] in
            await work.value
            // `work`'s own cancellation state, not the wrapping reporting
            // task's — this task is never itself cancelled by anything,
            // so reading the ambient `Task.isCancelled` here would always
            // read `false` and unconditionally report success regardless
            // of whether the OS expired `task` mid-work.
            task.setTaskCompleted(success: !work.isCancelled)
        }
    }

    private func handle(task: BGProcessingTask) {
        log.notice("Photos backfill BG task fired")
        // Re-schedule before any real work so iOS keeps routing wakes.
        scheduleNextPhotosBackfill()

        let handler = photosBackfillHandler
        let work = Task {
            await handler()
        }
        task.expirationHandler = { work.cancel() }

        Task { [work] in
            await work.value
            // See the refresh-task handler above for why this reads
            // `work.isCancelled`, not the ambient `Task.isCancelled`.
            task.setTaskCompleted(success: !work.isCancelled)
        }
    }
}
#endif
