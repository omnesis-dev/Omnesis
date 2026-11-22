// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The source-agnostic sync orchestrator. Analogous to the desktop
/// collector's `SyncEngine` in `packages/collector/src/sync-engine.ts`,
/// but runs in the iOS app process and is driven by `HKObserverQuery`
/// callbacks + `BGTaskScheduler` instead of a polling interval.
///
/// Per-source sync flow:
///
///   1. Load the persisted cursor from the gateway via `CursorStore`.
///   2. Call `source.sync(cursor:)` repeatedly until `hasMore == false`,
///      the pass's `SyncBudget` has no time for another page, or the
///      source's share of the buffer is full. Each page is converted into
///      a `Batch` and appended to the `OfflineBuffer`, then delivered
///      before the next page is read. The cursor advances per page, and
///      only once its page is safely queued — so even if the phone dies
///      mid-cycle, the next resume starts where we left off, and a page
///      the buffer had no room for is read again rather than lost.
///   3. Drain the `OfflineBuffer` into the gateway. Batches that fail
///      a transient error stay on disk and are retried by the next
///      drain invocation.
///
/// Concurrency: `CollectorCore` is an actor. One pass per source at a
/// time; concurrent requests for a source share its pass (see
/// `sync(sourceId:budget:)`). Multiple sources are driven serially.
public actor CollectorCore {
    public struct SyncSummary: Equatable, Sendable {
        public let sourceId: String
        public let batches: Int
        public let records: Int
        public let uploaded: Int
        public let remaining: Int
        public let error: String?
        /// Sources whose batches the gateway refused with 403 during the drain
        /// this sync triggered, or `nil` when no drain observed the buffer.
        ///
        /// Not necessarily `sourceId` — a drain walks the whole buffer, so
        /// syncing one source can reveal that a different one is unauthorized.
        /// Reported per pass so the UI reflects the current state rather than
        /// accumulating stale entries; `nil` means "no evidence", which a
        /// caller must not confuse with "nothing blocked".
        public let blocked: [String]?
    }

    public enum State: Equatable, Sendable {
        case idle
        case syncing(sourceId: String)
        case error(sourceId: String, message: String)
    }

    /// Live sync progress snapshot. Emitted via `onProgress` each time a
    /// page completes so the UI can show a meaningful counter instead
    /// of an opaque "Syncing…" spinner. `nil` means idle.
    public struct Progress: Equatable, Sendable {
        public let sourceId: String
        public let displayName: String
        public let records: Int
        public let pages: Int
        public let batchesBuffered: Int
    }

    public typealias ProgressHandler = @Sendable (Progress?) async -> Void

    /// What a sync cycle can say about the history the phone still holds for
    /// a source, published beside that cycle's status.
    ///
    /// No cycle makes one today: the offline buffer refuses a page rather
    /// than drop a queued one, so a cycle never loses what it captured. The
    /// claim stays on the wire for a source that one day bounds its history.
    ///
    /// A cycle that kept everything it captured makes no claim at all: most
    /// sources bound no history, so a coverage line on a healthy source warns
    /// about nothing, and `complete` is a promise a collector reading one
    /// upstream page at a time is in no position to make.
    public struct CoverageClaim: Equatable, Sendable {
        public let coverage: HistoryCoverage
        /// One sentence for the operator, rendered verbatim by every client.
        public let detail: String

        public init(coverage: HistoryCoverage, detail: String) {
            self.coverage = coverage
            self.detail = detail
        }
    }

    /// Lifecycle boundary of a per-source sync. The AppStore forwards
    /// these to the DeviceSocket as `sync.status` events so the
    /// gateway's SyncStatusRegistry tracks iOS-side syncs the same way
    /// it tracks the desktop collector's.
    public enum Lifecycle: Equatable, Sendable {
        case started(sourceId: String, displayName: String, startedAt: Date)
        case progress(sourceId: String, displayName: String, records: Int)
        /// `coverage` is present only when the cycle has something to say
        /// about the history behind it; absent is the healthy answer.
        case completed(
            sourceId: String,
            displayName: String,
            records: Int,
            completedAt: Date,
            coverage: CoverageClaim?
        )
        case error(sourceId: String, displayName: String, message: String)
        /// A run ended without succeeding or failing (for example, iOS
        /// cancelled a background request). Clears a prior `started` event
        /// without recording a successful update.
        case idle(sourceId: String, displayName: String)
        /// The gateway rejected pushes for this source — it was removed or
        /// paused in Omnesis (`reason` is `"removed"` / `"paused"`). Not a sync
        /// status; the AppStore acts on it (disable a removed source locally).
        case sourceRejected(sourceId: String, reason: String)
    }

    public typealias LifecycleHandler = @Sendable (Lifecycle) async -> Void
    private let gateway: GatewayClient
    private let buffer: OfflineBuffer
    private let cursorStore: CursorStore
    private let uploader: Uploader
    private let sources: [any OmnesisSource]
    private let onProgress: ProgressHandler?
    private let onLifecycle: LifecycleHandler?
    private let log = AppLog.make(category: "collector.core")
    private let prepareSource: (@Sendable (String, SourceMultiDeviceMode) async throws -> Void)?
    private var preparedSourceIds: Set<String> = []

    /// The pass running for each source, and the callers sharing it.
    private struct SourceRun {
        var budget: SyncBudget
        /// Set once the pass reads its first page. Until then a new caller
        /// can simply share it.
        var readingStarted = false
        var joiners: [CheckedContinuation<SyncSummary?, Never>] = []
    }

    /// One coalesced follow-up per source, asked for while that source's pass
    /// was already reading. Dropping that wake can strand data that arrived
    /// after the active pass took its input snapshot.
    private struct FollowUp {
        var budget: SyncBudget
        var waiters: [CheckedContinuation<SyncSummary?, Never>] = []
    }

    private var runs: [String: SourceRun] = [:]
    private var followUps: [String: FollowUp] = [:]
    /// How long a page read takes, per source, so a bounded pass declines a
    /// read it could not also deliver in time.
    private var readEstimates: [String: WorkEstimate] = [:]
    /// A page read is a local query; one slower than the ceiling still never
    /// stops a background wake (~30 s) from trying the next.
    static let initialReadEstimate = WorkEstimate(initial: 2, ceiling: 5)
    private var directDrains = 0
    private var lastSyncAt: [String: Date] = [:]
    private var acceptingSyncs = true
    private var quiescenceWaiters: [CheckedContinuation<Void, Never>] = []

    public init(
        gateway: GatewayClient,
        buffer: OfflineBuffer,
        cursorStore: CursorStore,
        uploader: Uploader,
        sources: [any OmnesisSource],
        prepareSource: (@Sendable (String, SourceMultiDeviceMode) async throws -> Void)? = nil,
        onProgress: ProgressHandler? = nil,
        onLifecycle: LifecycleHandler? = nil
    ) {
        self.gateway = gateway
        self.buffer = buffer
        self.cursorStore = cursorStore
        self.uploader = uploader
        self.sources = sources
        self.prepareSource = prepareSource
        self.onProgress = onProgress
        self.onLifecycle = onLifecycle
    }

    /// Sync every registered source in sequence, then drain the buffer.
    public func syncAll(budget: SyncBudget = .unbounded) async -> [SyncSummary] {
        guard acceptingSyncs else { return [] }
        var results: [SyncSummary] = []
        for source in sources {
            guard acceptingSyncs else { break }
            guard let summary = await sync(source: source, budget: budget) else { continue }
            results.append(summary)
        }
        await emitProgress(nil)
        return results
    }

    /// Snapshot of the sources driven by this core. Used at launch to
    /// register iOS-local sources (Apple Health) with the gateway so they
    /// appear in the portal.
    public func registeredSourceIds() -> [String] {
        sources.map(\.id)
    }

    /// Sync a single source by id — used by HealthKit observer callbacks
    /// to target a specific sample type efficiently.
    ///
    /// Calls for a source that is already syncing share that work instead
    /// of starting their own: one that arrives before the running pass has
    /// read anything joins it; one that arrives later queues a single
    /// follow-up pass (data may have landed after the running pass read
    /// it) and returns once that follow-up has finished. Every caller gets
    /// the summary of the pass that covered it, or nil when the core was
    /// retired or the running pass cancelled before a follow-up could run.
    public func sync(sourceId: String, budget: SyncBudget = .unbounded) async -> SyncSummary? {
        guard acceptingSyncs else { return nil }
        guard let source = sources.first(where: { $0.id == sourceId }) else {
            log.warning("No registered source with id \(sourceId, privacy: .private)")
            return nil
        }
        let summary = await sync(source: source, budget: budget)
        await emitProgress(nil)
        return summary
    }

    /// Drain the offline buffer without pulling new data. Useful after
    /// network reconnects or at app launch before anything else runs.
    public func drainPending(budget: SyncBudget = .unbounded) async -> Uploader.Stats? {
        guard acceptingSyncs else { return nil }
        directDrains += 1
        defer {
            directDrains -= 1
            resumeQuiescenceWaitersIfReady()
        }
        do {
            let stats = try await uploader.drain(budget: budget)
            await emitRejections(stats)
            return stats
        } catch {
            log.error("Drain failed: \(String(describing: error), privacy: .private)")
            return nil
        }
    }

    /// Callers waiting on `sourceId`'s queued follow-up pass. For tests that
    /// need to know an overlapping call has registered before they proceed.
    func followUpWaiterCount(sourceId: String) -> Int {
        followUps[sourceId]?.waiters.count ?? 0
    }

    /// Callers sharing `sourceId`'s running or follow-up pass, beyond the
    /// one that started it.
    func sharedCallerCount(sourceId: String) -> Int {
        (runs[sourceId]?.joiners.count ?? 0) + followUpWaiterCount(sourceId: sourceId)
    }

    public func lastSync(sourceId: String) -> Date? {
        lastSyncAt[sourceId]
    }

    public func bufferCount() async -> Int {
        await (try? buffer.count()) ?? 0
    }

    /// Stop admitting new source work and wait until every admitted sync has
    /// completed its source call, buffer enqueue, cursor save, and drain. A
    /// replacement collector is installed only after this returns, so an old
    /// authorization generation can never write after its successor.
    public func retireAndWait() async {
        acceptingSyncs = false
        guard !runs.isEmpty || directDrains > 0 else { return }
        await withCheckedContinuation { continuation in
            quiescenceWaiters.append(continuation)
        }
    }

    private func emitProgress(_ progress: Progress?) async {
        guard let onProgress else { return }
        await onProgress(progress)
    }

    private func emitLifecycle(_ event: Lifecycle) async {
        guard let onLifecycle else { return }
        await onLifecycle(event)
    }

    /// Emit a `.sourceRejected` lifecycle for every source the drain pass found
    /// removed/paused, so the AppStore can disable a removed source locally.
    private func emitRejections(_ stats: Uploader.Stats?) async {
        guard let stats else { return }
        for rejection in stats.rejected {
            await emitLifecycle(.sourceRejected(sourceId: rejection.sourceId, reason: rejection.reason))
        }
    }

    // MARK: - Internals

    /// Run a pass for `source`, or share the one already running.
    private func sync(source: any OmnesisSource, budget: SyncBudget) async -> SyncSummary? {
        guard acceptingSyncs else { return nil }
        guard var run = runs[source.id] else {
            runs[source.id] = SourceRun(budget: budget)
            return await executePass(source: source)
        }
        if !run.readingStarted {
            // Nothing read yet: the running pass will see whatever this
            // caller was woken for.
            run.budget = run.budget.extended(to: budget)
            runs[source.id] = run
            log.debug("Join the pass about to start for \(source.id, privacy: .private)")
            return await withCheckedContinuation { continuation in
                runs[source.id]?.joiners.append(continuation)
            }
        }
        var followUp = followUps[source.id] ?? FollowUp(budget: budget)
        followUp.budget = followUp.budget.extended(to: budget)
        followUps[source.id] = followUp
        log.debug("Queue one follow-up pass for \(source.id, privacy: .private) — already syncing")
        return await withCheckedContinuation { continuation in
            followUps[source.id]?.waiters.append(continuation)
        }
    }

    /// Settle a finished pass: answer every caller that joined it, and start
    /// the follow-up pass someone asked for while it was reading.
    private func finishPass(source: any OmnesisSource, summary: SyncSummary?) {
        let joiners = runs.removeValue(forKey: source.id)?.joiners ?? []
        joiners.forEach { $0.resume(returning: summary) }
        if let followUp = followUps.removeValue(forKey: source.id) {
            if acceptingSyncs, !Task.isCancelled {
                // Claimed now, so a caller arriving before the task starts
                // joins this follow-up instead of starting another pass.
                var run = SourceRun(budget: followUp.budget)
                run.joiners = followUp.waiters
                runs[source.id] = run
                Task { [weak self] in
                    _ = await self?.executePass(source: source)
                }
            } else {
                followUp.waiters.forEach { $0.resume(returning: nil) }
            }
        }
        resumeQuiescenceWaitersIfReady()
    }

    // One pass over `source`, under the budget recorded in `runs`.
    //
    // Reads and uploads alternate: after each page is buffered it is
    // delivered before the next is read, so a pass that runs out of time
    // ends with what it read already at the gateway, and reading can never
    // get ahead of delivery by more than one page. A page that the
    // buffer has no room for is not kept: its cursor does not advance and
    // the next pass reads it again. When delivery fails (no network) the
    // pass keeps capturing into the buffer, up to the source's share.
    //
    // Sync state, cursor, buffer, and lifecycle publication must remain one ordered operation.
    // swiftlint:disable:next function_body_length
    private func executePass(source: any OmnesisSource) async -> SyncSummary {
        var summary: SyncSummary?
        defer { finishPass(source: source, summary: summary) }

        var pass = PassTally()
        var errorMessage: String?
        var wasCancelled = false
        // A bounded pass that had no time to read even one page did no sync;
        // reporting it complete would show "synced just now" for nothing.
        var outOfTimeUnread = false
        let startedAt = Date()

        await emitProgress(Progress(
            sourceId: source.id,
            displayName: source.displayName,
            records: 0,
            pages: 0,
            batchesBuffered: bufferCount()
        ))
        await emitLifecycle(.started(
            sourceId: source.id,
            displayName: source.displayName,
            startedAt: startedAt
        ))

        do {
            if !preparedSourceIds.contains(source.id) {
                try await prepareSource?(source.id, source.multiDeviceMode)
                preparedSourceIds.insert(source.id)
            }
            var cursor = try await source.beginPass(cursor: cursorStore.load(for: source.id, refresh: true))
            var pages = 0
            // Cap to avoid runaway loops while a malformed source keeps
            // claiming hasMore=true.
            let maxPages = 200
            while pages < maxPages {
                if Task.isCancelled {
                    wasCancelled = true
                    break
                }
                // Read afresh each page: a caller that joins with a later
                // deadline (a foreground Sync now) extends the pass.
                let budget = passBudget(for: source.id)
                guard await budget.allows(readEstimate(source.id).expected + uploader.expectedBatchDuration()) else {
                    log.notice("Pass for \(source.id, privacy: .private) stopped for time after \(pages, privacy: .public) pages")
                    outOfTimeUnread = pages == 0
                    break
                }
                guard await makeRoom(for: source, budget: budget, pass: &pass) else {
                    log.notice("Pass for \(source.id, privacy: .private) paused: its share of the offline buffer is full")
                    break
                }

                runs[source.id]?.readingStarted = true
                let readStarted = budget.clock.now()
                let result = try await source.sync(cursor: cursor)
                readEstimates[source.id, default: Self.initialReadEstimate]
                    .record(budget.clock.now().timeIntervalSince(readStarted))
                pages += 1

                let hasContent = !result.records.isEmpty || !result.deletedIds.isEmpty || !result.documents.isEmpty
                if hasContent {
                    guard try await buffer(result, from: source, budget: budget, pass: &pass) else {
                        log.notice("Pass for \(source.id, privacy: .private) paused: no room to keep its next page")
                        break
                    }
                }

                cursor = result.cursor
                try await cursorStore.save(
                    sourceId: source.id,
                    cursor: result.cursor,
                    label: source.displayName
                )

                await emitProgress(Progress(
                    sourceId: source.id,
                    displayName: source.displayName,
                    records: pass.items,
                    pages: pages,
                    batchesBuffered: bufferCount()
                ))
                await emitLifecycle(.progress(
                    sourceId: source.id,
                    displayName: source.displayName,
                    records: pass.items
                ))

                if !result.hasMore {
                    break
                }
                if hasContent, !pass.deliveryStalled {
                    await deliver(for: source.id, budget: budget, pass: &pass)
                }
            }
            lastSyncAt[source.id] = Date()
        } catch {
            // NSURLErrorCancelled (-999) means iOS suspended the process
            // mid-request (typical when an HKObserver background wake
            // ran out of its time budget). The data we'd already
            // produced may have made it to the gateway or may not have;
            // either way HK's anchored cursor stays put if its save
            // didn't go through, and the upload is idempotent on the
            // gateway via primary keys. Treat as transient: don't
            // surface as a sync error (which would flip the source to
            // ERROR in the portal + CLI). Next observer wake or
            // foreground sync resumes cleanly.
            let nsError = error as NSError
            let isCancelled = nsError.domain == NSURLErrorDomain
                && nsError.code == NSURLErrorCancelled
            if isCancelled || error is CancellationError {
                wasCancelled = true
                log
                    .notice(
                        // swiftlint:disable:next line_length
                        "Sync for \(source.id, privacy: .private) cancelled mid-request (likely background suspension); leaving state unchanged for retry"
                    )
            } else {
                errorMessage = String(describing: error)
                log.error("Sync failed for \(source.id, privacy: .private): \(String(describing: error), privacy: .private)")
            }
        }

        // Drain regardless — batches from prior cycles might be waiting.
        await deliver(for: source.id, budget: passBudget(for: source.id), pass: &pass)
        let stats = pass.lastDrain
        let remaining: Int = if let stats {
            stats.remaining
        } else {
            await bufferCount()
        }

        if let errorMessage {
            await emitLifecycle(.error(
                sourceId: source.id,
                displayName: source.displayName,
                message: errorMessage
            ))
        } else if wasCancelled || outOfTimeUnread {
            await emitLifecycle(.idle(sourceId: source.id, displayName: source.displayName))
        } else {
            await emitLifecycle(.completed(
                sourceId: source.id,
                displayName: source.displayName,
                records: pass.items,
                completedAt: Date(),
                coverage: nil
            ))
        }

        let result = SyncSummary(
            sourceId: source.id,
            batches: pass.batches,
            records: pass.records,
            uploaded: pass.uploaded,
            remaining: remaining,
            error: errorMessage,
            blocked: stats?.blocked
        )
        summary = result
        return result
    }

    private func resumeQuiescenceWaitersIfReady() {
        guard runs.isEmpty, directDrains == 0, !acceptingSyncs else { return }
        let waiters = quiescenceWaiters
        quiescenceWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}

// MARK: - One pass's reading, buffering and delivery

extension CollectorCore {
    /// What one pass has done so far.
    private struct PassTally {
        var batches = 0
        var records = 0
        var items = 0
        var uploaded = 0
        /// A drain this pass could not deliver this source's batches (no
        /// network, a busy gateway) or was refused the token. Later pages
        /// are captured into the buffer, not delivered.
        var deliveryStalled = false
        var lastDrain: Uploader.Stats?
    }

    private func passBudget(for sourceId: String) -> SyncBudget {
        runs[sourceId]?.budget ?? .unbounded
    }

    private func readEstimate(_ sourceId: String) -> WorkEstimate {
        readEstimates[sourceId] ?? Self.initialReadEstimate
    }

    /// Deliver what is queued, within the budget, and fold the result into
    /// the pass.
    private func deliver(for sourceId: String, budget: SyncBudget, pass: inout PassTally) async {
        do {
            let stats = try await uploader.drain(budget: budget)
            await emitRejections(stats)
            pass.uploaded += stats.uploaded
            // Only this source's own failures stall its pass: another source
            // the gateway cannot take right now is no reason to stop
            // delivering this one.
            if stats.failedSources.contains(sourceId) { pass.deliveryStalled = true }
            pass.lastDrain = stats
        } catch {
            log.error("Drain failed: \(String(describing: error), privacy: .private)")
            pass.deliveryStalled = true
            pass.lastDrain = nil
        }
    }

    /// Make sure `source` may queue another page before reading one, by
    /// delivering what is queued if its share is full. False when there is
    /// still no room: the pass stops reading, and nothing is lost because
    /// nothing more was read.
    private func makeRoom(for source: any OmnesisSource, budget: SyncBudget, pass: inout PassTally) async -> Bool {
        if await (try? buffer.hasRoom(forSourceId: source.id)) ?? false { return true }
        guard !pass.deliveryStalled else { return false }
        await deliver(for: source.id, budget: budget, pass: &pass)
        return await (try? buffer.hasRoom(forSourceId: source.id)) ?? false
    }

    /// Queue one page. Returns false, without acknowledging the page, when
    /// the buffer has no room for it even after a delivery attempt; the
    /// caller then leaves the cursor where it was.
    private func buffer(
        _ result: SyncResult,
        from source: any OmnesisSource,
        budget: SyncBudget,
        pass: inout PassTally
    ) async throws
        -> Bool {
        let batch = Batch(
            id: Batch.makeId(sourceId: source.id),
            sourceId: source.id,
            multiDeviceMode: source.multiDeviceMode,
            tableName: result.tableName,
            records: result.records,
            schema: result.schema,
            deletedIds: result.deletedIds,
            documents: result.documents,
            createdAt: Date()
        )
        do {
            try await buffer.enqueue(batch)
        } catch is OfflineBuffer.BufferFull {
            guard !pass.deliveryStalled else { return false }
            await deliver(for: source.id, budget: budget, pass: &pass)
            do {
                try await buffer.enqueue(batch)
            } catch is OfflineBuffer.BufferFull {
                return false
            }
        }
        try await source.didBuffer(result)
        pass.batches += 1
        pass.records += result.records.count
        // A page may represent the same item as both an analytics
        // row and a searchable document. Count the larger plane so
        // documents-only sources such as Photos report real work
        // without double-counting mixed pages such as workouts.
        pass.items += max(result.records.count, result.documents.count)
        return true
    }
}
