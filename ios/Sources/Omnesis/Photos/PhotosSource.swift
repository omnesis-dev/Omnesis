// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Every phone owns its library's stream. iCloud copies can appear in multiple
/// streams; one phone's permissions, snapshots, or removal never erase another
/// phone's library. PhotoKit identifiers are local, not replica identities.
public let photosHostedSourceContract = HostedSourceContract(sourceType: "photos", multiDeviceMode: .partitioned)

/// `OmnesisSource` implementation for the on-device Photos & Screenshots
/// source (#169). Push-only, documents-only (`tableName: nil` on every
/// `SyncResult` — no analytics table): OCR + on-device analysis, never
/// image bytes, ever leave the device.
///
/// Every `sync(cursor:)` call does two things, unconditionally:
///
///   - **New-arrivals sweep**: checks Apple's "Recently Added" smart
///     album (`library.fetchRecentlyAdded`) for assets not yet richly
///     analyzed (per `AnalyzedAssetStore`) and runs the full
///     rich-analysis suite on them. This runs on EVERY call — including
///     while the historical backfill below is still in progress — so a
///     photo taken during a (possibly multi-day) initial backfill still
///     gets full rich analysis promptly, rather than being caught by
///     the backfill's cheap tier and permanently stuck there (the
///     backfill only walks each asset once; once passed, an asset is
///     never revisited). This is the SAME code path a live
///     `PhotoLibraryObserver` callback triggers (via `syncOne`), so the
///     live-observer path and this backstop sweep agree on eligibility
///     by construction — not by careful coordination between two
///     divergent implementations.
///   - **Library page**: pages through the library in priority order
///     (`.screenshots` → `.recent` → `.backfill`) via `library.fetchPage`,
///     uses the cheap tier during initial backfill and rich analysis for
///     previously unseen steady-state assets. Once
///     `.backfill` drains, the cursor moves to `.steady`. Steady syncs
///     continue a bounded whole-library walk so old imports and assets newly
///     exposed through Limited access are eventually discovered; acknowledged
///     assets are skipped without being uploaded again.
///
public struct PhotosSource: OmnesisSource {
    public let id: String
    public let displayName: String
    public let analyticsSchemas: [AnalyticsTableSchema] = []
    public let multiDeviceMode: SourceMultiDeviceMode = .partitioned

    private static let accountId = "local"
    private let providerId: String
    private let library: any PhotoLibraryReading
    private let assetIndex: AnalyzedAssetStore
    private let gateway: GatewayClient
    private let accessEpoch: Int
    private let pageLimit: Int
    private let recentlyAddedLimit: Int
    private let acknowledgments = PhotoPageAcknowledgments()

    public init(
        library: any PhotoLibraryReading,
        assetIndex: AnalyzedAssetStore,
        gateway: GatewayClient,
        accessEpoch: Int = 0,
        pageLimit: Int = 50,
        recentlyAddedLimit: Int = 200
    ) {
        id = "photos:\(Self.accountId)"
        providerId = id
        displayName = "Photos"
        self.library = library
        self.assetIndex = assetIndex
        self.gateway = gateway
        self.accessEpoch = accessEpoch
        self.pageLimit = pageLimit
        self.recentlyAddedLimit = recentlyAddedLimit
    }

    public func sync(cursor: SyncCursor?) async throws -> SyncResult {
        let decoded = PhotosCursor.decode(from: cursor)
        // A non-full → Full restoration advances the local access epoch.
        // Treat any older gateway cursor as a fresh full-library walk instead
        // of mutating the cursor out-of-band, which could race an in-flight
        // save from the preceding collector generation.
        // A core captured before an access restoration must never reset a
        // newer gateway cursor back to its older epoch. End that obsolete
        // pass without producing data; the current collector owns the replay.
        guard decoded.accessEpoch <= accessEpoch else {
            return SyncResult(
                records: [],
                tableName: nil,
                cursor: decoded.encode(),
                hasMore: false,
                deletedIds: [],
                documents: []
            )
        }
        let photosCursor = decoded.accessEpoch == accessEpoch
            ? decoded
            : PhotosCursor(accessEpoch: accessEpoch)

        // Idempotency-baseline gate. Both sweeps below trust
        // `assetIndex.isRichlyAnalyzed`; while the index file exists but
        // is unreadable (a `.completeUnlessOpen`-protected index loaded
        // during a locked-device background run) that guard fails open:
        // the backfill would push a cheap-tier document that upserts
        // over the richer gateway document for the same stable external
        // id — and since the disk-side rich mark survives the eventual
        // merge, nothing would ever re-analyze (a silent, permanent
        // downgrade). The new-arrivals sweep would meanwhile re-run the
        // full rich-analysis suite on assets whose marks it can't see —
        // pure battery/network waste. So end the cycle cleanly with the
        // cursor unchanged; a later sync retries. Deliberately gated
        // on the index's own readability rather than
        // `UIApplication.isProtectedDataAvailable` (the
        // `AppleHealthSource` precedent): unlike the HealthKit store,
        // the photo library stays readable while locked, and a store
        // instance whose records were loaded before the device locked
        // keeps a trustworthy in-memory baseline — a protected-data
        // gate would needlessly skip those runs, and the store's own
        // probe (which also retries, so the gate reopens on unlock) is
        // exactly what the guard depends on.
        guard await assetIndex.baselineIsReadable() else {
            // Never persist a fresh cursor before the reset's retained asset
            // acknowledgments can be cleared. A later unlocked retry must
            // still enter with nil and rebuild the entire device stream.
            if cursor == nil { throw CocoaError(.fileReadNoPermission) }
            return SyncResult(
                records: [],
                tableName: nil,
                cursor: photosCursor.encode(),
                hasMore: false,
                deletedIds: [],
                documents: []
            )
        }

        if cursor == nil {
            try await assetIndex.resetDeliveryAcknowledgments()
        }
        let acknowledgmentId = await acknowledgments.begin()
        var documents = await syncNewArrivals(epoch: photosCursor.accessEpoch, acknowledgmentId: acknowledgmentId)
        guard !Task.isCancelled else {
            // `hasMore: false` even mid-backfill — cancellation persists
            // for the rest of this task, so looping back into `sync(cursor:)`
            // again within the same cycle would just re-detect the same
            // cancellation on every call up to `maxPages`, for no work done.
            return SyncResult(
                records: [],
                tableName: nil,
                cursor: photosCursor.encode(),
                hasMore: false,
                deletedIds: [],
                documents: documents,
                acknowledgmentId: acknowledgmentId
            )
        }

        // Steady discovery walks one bounded page of the whole visible
        // library per sync. The recent album is a fast path, not a complete
        // inventory: imports and observer-missed arrivals may be absent.
        let backfill = await syncBackfillPage(
            cursor: photosCursor,
            richThisPage: Set(documents.map(\.externalId)),
            acknowledgmentId: acknowledgmentId
        )
        documents.append(contentsOf: backfill.documents)
        return SyncResult(
            records: [],
            tableName: nil,
            cursor: backfill.cursor.encode(),
            hasMore: backfill.cursor.phase != .steady,
            deletedIds: [],
            documents: documents,
            acknowledgmentId: acknowledgmentId
        )
    }

    public func didBuffer(_ result: SyncResult) async throws {
        guard let id = result.acknowledgmentId else { return }
        try await acknowledgments.commit(
            id: id,
            externalIds: Set(result.documents.map(\.externalId)),
            index: assetIndex,
            epoch: PhotosCursor.decode(from: result.cursor).accessEpoch
        )
    }

    /// Whole-library snapshot reconcile — the deletion backstop for
    /// observer-missed removals. Deliberately NOT folded into the
    /// phased cursor above (a snapshot can't be expressed as one
    /// resumable page of a paged cursor); the caller (the
    /// `BGProcessingTask` handler) throttles how often this runs (see
    /// `PhotosSettings.lastReconcileAt`).
    public enum ReconcileOutcome: Equatable, Sendable {
        case performed
        case skippedIncompleteAccess(PhotosAccessState)
    }

    public func reconcileDeletions() async throws -> ReconcileOutcome {
        switch await library.fetchCompleteSnapshot() {
        case .incomplete(let access):
            return .skippedIncompleteAccess(access)
        case .complete(let presentIds):
            _ = try await gateway.reconcileDocuments(
                providerId: providerId,
                sourceId: id,
                presentExternalIds: presentIds
            )
            return .performed
        }
    }

    // MARK: - Internals

    /// Runs on every call, regardless of backfill progress. Checks
    /// cooperative cancellation between assets so a `BGProcessingTask`
    /// that's about to expire stops launching further rich-analysis work
    /// promptly (a single in-flight Vision/network call still runs to
    /// completion — neither is itself interruptible — but no new one
    /// starts once cancelled).
    private func syncNewArrivals(epoch: Int, acknowledgmentId: UUID) async -> [DocumentInput] {
        let recents = await library.fetchRecentlyAdded(limit: recentlyAddedLimit)
        var documents: [DocumentInput] = []
        for asset in recents {
            guard !Task.isCancelled else { break }
            guard await !assetIndex.isRichlyAnalyzed(asset.localIdentifier, inEpoch: epoch) else { continue }
            let fragment = await library.analyze(asset, tier: .new)
            documents.append(PhotosDocumentBuilder.build(
                asset: asset, providerId: providerId, sourceId: id, fragment: fragment
            ))
            await acknowledgments.record(
                pageId: acknowledgmentId,
                externalId: asset.externalId,
                localIdentifier: asset.localIdentifier,
                richlyAnalyzed: true
            )
        }
        return documents
    }

    private func syncBackfillPage(
        cursor: PhotosCursor,
        richThisPage: Set<String>,
        acknowledgmentId: UUID
    ) async
        -> (documents: [DocumentInput], cursor: PhotosCursor) {
        let after: (dateString: String, externalId: String)? = resumePoint(from: cursor)
        let page = await library.fetchPage(phase: cursor.phase, after: after, limit: pageLimit)

        var documents: [DocumentInput] = []
        documents.reserveCapacity(page.count)
        var processed: [PhotoAssetRef] = []
        for asset in page {
            guard !Task.isCancelled else { break }
            if richThisPage.contains(asset.externalId) {
                processed.append(asset)
                continue
            }
            // An asset already richly analyzed — by `syncNewArrivals()`
            // earlier in THIS same call, or by a prior sync's new-arrivals
            // sweep before the backfill's own chronological walk caught up
            // to it (e.g. a photo taken while the `.recent` phase, which
            // covers "the last 30 days", is mid-flight) — must not get a
            // cheap backfill-tier document pushed for it. Both land in the
            // same upsert-by-external-id document store, so a later cheap
            // push would silently overwrite the richer one. Still counts
            // as walked so the cursor advances past it either way.
            guard await !assetIndex.wasPushed(asset.localIdentifier, inEpoch: cursor.accessEpoch) else {
                processed.append(asset)
                continue
            }
            // A full-access restoration deliberately replays assets from an
            // older access epoch. Preserve the quality of documents that were
            // already richly analyzed before access narrowed: replaying one at
            // the cheap backfill tier would overwrite its richer gateway
            // document, while carrying the old rich bit into the new epoch
            // would prevent a later repair.
            let wasRichlyAnalyzed = await assetIndex.isRichlyAnalyzed(asset.localIdentifier)
            let tier: AnalysisTier = wasRichlyAnalyzed || cursor.phase == .steady ? .new : .backfill
            let fragment = await library.analyze(asset, tier: tier)
            documents.append(PhotosDocumentBuilder.build(
                asset: asset, providerId: providerId, sourceId: id, fragment: fragment
            ))
            await acknowledgments.record(
                pageId: acknowledgmentId,
                externalId: asset.externalId,
                localIdentifier: asset.localIdentifier,
                richlyAnalyzed: wasRichlyAnalyzed || cursor.phase == .steady
            )
            processed.append(asset)
        }
        // A page cut short by cancellation resumes after the last asset
        // actually processed, and is never treated as "phase exhausted"
        // (that would incorrectly advance to the next phase / .steady
        // before the interrupted phase actually finished draining).
        guard processed.count == page.count else {
            return (documents, resumeAfter(cursor: cursor, processed: processed))
        }
        return (documents, advancedCursor(cursor: cursor, page: page))
    }

    private func resumePoint(from cursor: PhotosCursor) -> (dateString: String, externalId: String)? {
        guard let lastAssetId = cursor.lastAssetId, let lastAssetDate = cursor.lastAssetDate else {
            return nil
        }
        return (lastAssetDate, lastAssetId)
    }

    private func resumeAfter(cursor: PhotosCursor, processed: [PhotoAssetRef]) -> PhotosCursor {
        var next = cursor
        if let last = processed.last {
            next.lastAssetId = last.externalId
            next.lastAssetDate = PhotosCursor.dateFormatter.string(from: last.creationDate)
        }
        return next
    }

    /// Advance the cursor within the current phase (resume point = the
    /// last asset in this page), or to the next phase once a page comes
    /// back short of `pageLimit` (the phase's `PHFetchResult` is
    /// exhausted). Stamps `backfillCompletedAt` the moment the cursor
    /// first enters `.steady`.
    private func advancedCursor(cursor: PhotosCursor, page: [PhotoAssetRef]) -> PhotosCursor {
        guard page.count < pageLimit else {
            // Phase not yet exhausted — resume after the last asset in
            // this page.
            return resumeAfter(cursor: cursor, processed: page)
        }
        let nextPhase = cursor.nextPhase
        let backfillCompletedAt = nextPhase == .steady && cursor.phase != .steady
            ? PhotosCursor.dateFormatter.string(from: Date())
            : cursor.backfillCompletedAt
        return PhotosCursor(
            phase: nextPhase,
            backfillCompletedAt: backfillCompletedAt,
            accessEpoch: cursor.accessEpoch
        )
    }
}

/// One source page's local bookkeeping, bounded by the page plus its recent
/// arrivals. An overlapping direct caller can supersede a pending page, but
/// cannot acknowledge it as a different page. The collector serializes normal
/// source execution; rejection here preserves replay for other callers.
private actor PhotoPageAcknowledgments {
    private struct Mark {
        let localIdentifier: String
        let richlyAnalyzed: Bool
    }

    private var pageId: UUID?
    private var marks: [String: Mark] = [:]

    func begin() -> UUID {
        let id = UUID()
        pageId = id
        marks.removeAll(keepingCapacity: true)
        return id
    }

    func record(pageId: UUID, externalId: String, localIdentifier: String, richlyAnalyzed: Bool) {
        guard self.pageId == pageId else { return }
        marks[externalId] = Mark(localIdentifier: localIdentifier, richlyAnalyzed: richlyAnalyzed)
    }

    func commit(id: UUID, externalIds: Set<String>, index: AnalyzedAssetStore, epoch: Int) async throws {
        guard pageId == id, externalIds.allSatisfy({ marks[$0] != nil }) else {
            throw CocoaError(.coderInvalidValue)
        }
        let captured = externalIds.compactMap { marks[$0] }
        for mark in captured {
            await index.record(localIdentifier: mark.localIdentifier, richlyAnalyzed: mark.richlyAnalyzed, epoch: epoch)
        }
        try await index.flush()
        if pageId == id {
            marks.removeAll(keepingCapacity: true)
            pageId = nil
        }
    }
}
