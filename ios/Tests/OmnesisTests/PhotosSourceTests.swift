// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PhotosSourceTests: XCTestCase {
    // MARK: - Fake PhotoLibraryReading

    /// Replays canned per-phase asset lists — `PHAsset` has no public
    /// initializer, so `PhotosSource`'s cursor/paging/dedup logic is
    /// tested against this fake rather than real PhotoKit (which needs
    /// a device/simulator).
    final class FakePhotoLibrary: PhotoLibraryReading, @unchecked Sendable {
        var accessState: PhotosAccessState = .full
        var snapshotAccessAfterEnumeration: PhotosAccessState?
        var assetsByPhase: [PhotosCursor.Phase: [PhotoAssetRef]] = [:]
        var recentlyAdded: [PhotoAssetRef] = []
        var allExternalIds: [String] = []
        private(set) var analyzeCalls: [(externalId: String, tier: AnalysisTier)] = []
        var cancelAfterAnalysis = false

        func fetchPage(
            phase: PhotosCursor.Phase,
            after cursor: (dateString: String, externalId: String)?,
            limit: Int
        ) async
            -> [PhotoAssetRef] {
            let all = assetsByPhase[phase] ?? []
            guard let cursor else { return Array(all.prefix(limit)) }
            // Compare FORMATTED strings (not raw `Date`s) — same
            // precision-symmetry reasoning as `PHPhotoLibraryReader`.
            let filtered = all.filter { candidate in
                let candidateDateString = PhotosCursor.dateFormatter.string(from: candidate.creationDate)
                if candidateDateString != cursor.dateString {
                    return candidateDateString > cursor.dateString
                }
                return candidate.externalId > cursor.externalId
            }
            return Array(filtered.prefix(limit))
        }

        func fetchRecentlyAdded(limit: Int) async -> [PhotoAssetRef] {
            Array(recentlyAdded.prefix(limit))
        }

        func fetchCompleteSnapshot() async -> PhotoLibrarySnapshot {
            guard accessState.isComplete else { return .incomplete(access: accessState) }
            if let after = snapshotAccessAfterEnumeration, !after.isComplete {
                accessState = after
                return .incomplete(access: after)
            }
            return .complete(externalIds: allExternalIds)
        }

        func analyze(_ asset: PhotoAssetRef, tier: AnalysisTier) async -> PhotoAnalysisFragment {
            analyzeCalls.append((asset.externalId, tier))
            if cancelAfterAnalysis { withUnsafeCurrentTask { $0?.cancel() } }
            return PhotoAnalysisFragment(textLines: ["text for \(asset.externalId)"])
        }
    }

    // MARK: - Helpers

    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-photos-source-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func makeAsset(_ externalId: String, date: Date, isScreenshot: Bool = false) -> PhotoAssetRef {
        PhotoAssetRef(
            localIdentifier: "local-\(externalId)",
            externalId: externalId,
            creationDate: date,
            modificationDate: date,
            isScreenshot: isScreenshot
        )
    }

    final class StubSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let http = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:]
            )!
            return (Data("{}".utf8), http)
        }
    }

    private func makeGateway(session: StubSession = StubSession()) throws -> GatewayClient {
        try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
    }

    private func makeSource(
        library: FakePhotoLibrary,
        pageLimit: Int = 2,
        accessEpoch: Int = 0
    ) throws
        -> PhotosSource {
        try PhotosSource(
            library: library,
            assetIndex: AnalyzedAssetStore(directory: directory),
            gateway: makeGateway(),
            accessEpoch: accessEpoch,
            pageLimit: pageLimit,
            recentlyAddedLimit: 200
        )
    }

    private let day: TimeInterval = 24 * 60 * 60

    // MARK: - Unreadable asset-index baseline (locked-device background runs)

    func testSyncUnderAnUnreadableAssetIndexEmitsNothingAndHoldsTheCursor() async throws {
        // Seed the index so the file exists, then make it unreadable —
        // the observable shape of a `.completeUnlessOpen`-protected
        // index during a locked-device BGProcessingTask run. With the
        // baseline untrusted, the cheap-vs-rich dedup guard would fail
        // open, so the sync must do no analysis work at all and hold
        // the cursor.
        let seeded = AnalyzedAssetStore(directory: directory)
        await seeded.record(localIdentifier: "local-old-1", richlyAnalyzed: true)
        try await seeded.flush()
        let indexFile = directory.appendingPathComponent("photos-asset-index.json")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: indexFile.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: indexFile.path)
        }

        let library = FakePhotoLibrary()
        let now = Date()
        library.recentlyAdded = [makeAsset("new-1", date: now)]
        library.assetsByPhase[.backfill] = [
            makeAsset("old-1", date: now.addingTimeInterval(-400 * day)),
            makeAsset("old-2", date: now.addingTimeInterval(-401 * day)),
        ]
        let source = try makeSource(library: library)

        let result = try await source.syncAndBuffer(cursor: PhotosCursor(phase: .backfill).encode())

        XCTAssertTrue(result.documents.isEmpty, "an untrusted rich-analysis baseline must not produce documents")
        XCTAssertTrue(library.analyzeCalls.isEmpty, "no analysis (rich or cheap) may run against an untrusted baseline")
        XCTAssertEqual(
            PhotosCursor.decode(from: result.cursor),
            PhotosCursor(phase: .backfill),
            "the cursor must hold so no asset is walked past without being considered"
        )
        XCTAssertFalse(result.hasMore)

        // Once the index is readable again, the SAME source instance
        // resumes — and the rich mark seeded on disk keeps old-1 from
        // being downgraded by a cheap backfill-tier push.
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: indexFile.path)
        let resumed = try await source.syncAndBuffer(cursor: result.cursor)
        XCTAssertEqual(resumed.documents.map(\.externalId).sorted(), ["new-1", "old-2"])
    }

    // MARK: - Bootstrap: priority order screenshots → recent → backfill

    func testBootstrapWalksPhasesInPriorityOrder() async throws {
        let library = FakePhotoLibrary()
        let now = Date()
        library.assetsByPhase[.screenshots] = [makeAsset("shot-1", date: now, isScreenshot: true)]
        library.assetsByPhase[.recent] = [makeAsset("recent-1", date: now)]
        library.assetsByPhase[.backfill] = [makeAsset("old-1", date: now.addingTimeInterval(-400 * day))]
        let source = try makeSource(library: library, pageLimit: 10)

        // Phase 1: screenshots (page fits entirely under pageLimit → advances).
        var result = try await source.syncAndBuffer(cursor: nil)
        XCTAssertEqual(result.documents.map(\.externalId), ["shot-1"])
        var cursor = PhotosCursor.decode(from: result.cursor)
        XCTAssertEqual(cursor.phase, .recent)
        XCTAssertTrue(result.hasMore)

        // Phase 2: recent.
        result = try await source.syncAndBuffer(cursor: result.cursor)
        XCTAssertEqual(result.documents.map(\.externalId), ["recent-1"])
        cursor = PhotosCursor.decode(from: result.cursor)
        XCTAssertEqual(cursor.phase, .backfill)
        XCTAssertTrue(result.hasMore)

        // Phase 3: backfill — drains to .steady, hasMore flips false.
        result = try await source.syncAndBuffer(cursor: result.cursor)
        XCTAssertEqual(result.documents.map(\.externalId), ["old-1"])
        cursor = PhotosCursor.decode(from: result.cursor)
        XCTAssertEqual(cursor.phase, .steady)
        XCTAssertNotNil(cursor.backfillCompletedAt)
        XCTAssertFalse(result.hasMore)
    }

    func testBackfillTierUsesTheCheapAnalysisTierNotNew() async throws {
        let library = FakePhotoLibrary()
        library.assetsByPhase[.screenshots] = [makeAsset("shot-1", date: Date())]
        let source = try makeSource(library: library, pageLimit: 10)
        _ = try await source.syncAndBuffer(cursor: nil)
        XCTAssertEqual(library.analyzeCalls.map(\.tier), [.backfill])
    }

    /// A photo taken while the backfill's `.recent` phase (which covers
    /// "the last 30 days") is mid-flight is trivially within that phase's
    /// own window, so it can show up in BOTH `fetchRecentlyAdded()` (which
    /// `syncNewArrivals()` always checks first, every call) and the
    /// current phase's `fetchPage()` results in the very same `sync()`
    /// call. The backfill page must not re-push a cheap, tier-`.backfill`
    /// document for an asset `syncNewArrivals()` already richly analyzed
    /// moments earlier in the same call — that would silently downgrade
    /// the richer result, since both land in the same upsert-by-external-id
    /// document store with no "keep the richer one" merge logic.
    func testBackfillPageSkipsAnAssetSyncNewArrivalsAlreadyRichlyAnalyzedThisSameCall() async throws {
        let library = FakePhotoLibrary()
        let now = Date()
        let asset = makeAsset("today-1", date: now)
        library.recentlyAdded = [asset]
        library.assetsByPhase[.recent] = [asset]
        let source = try makeSource(library: library, pageLimit: 10)

        let result = try await source.syncAndBuffer(cursor: PhotosCursor(phase: .recent).encode())

        XCTAssertEqual(result.documents.map(\.externalId), ["today-1"], "exactly one document, not a duplicate")
        XCTAssertEqual(library.analyzeCalls.map(\.externalId), ["today-1"], "analyzed exactly once")
        XCTAssertEqual(library.analyzeCalls.map(\.tier), [.new], "at the rich tier — never re-analyzed at the cheap tier")
    }

    // MARK: - Paging within a phase

    func testPagesWithinAPhaseBeforeAdvancing() async throws {
        let library = FakePhotoLibrary()
        let now = Date()
        library.assetsByPhase[.screenshots] = [
            makeAsset("shot-1", date: now.addingTimeInterval(-2), isScreenshot: true),
            makeAsset("shot-2", date: now.addingTimeInterval(-1), isScreenshot: true),
            makeAsset("shot-3", date: now, isScreenshot: true),
        ]
        let source = try makeSource(library: library, pageLimit: 2)

        // First page: 2 of 3 — still within the phase (page filled the limit).
        var result = try await source.syncAndBuffer(cursor: nil)
        XCTAssertEqual(result.documents.map(\.externalId), ["shot-1", "shot-2"])
        var cursor = PhotosCursor.decode(from: result.cursor)
        XCTAssertEqual(cursor.phase, .screenshots, "phase unchanged — page was full, more remain")
        XCTAssertTrue(result.hasMore)

        // Second page: the remaining 1 — short of the limit, phase advances.
        result = try await source.syncAndBuffer(cursor: result.cursor)
        XCTAssertEqual(result.documents.map(\.externalId), ["shot-3"])
        cursor = PhotosCursor.decode(from: result.cursor)
        XCTAssertEqual(cursor.phase, .recent)
    }

    // MARK: - Kill-and-resume: a fresh PhotosSource resumes exactly where the cursor left off

    func testKillAndResumeBackfillHasNoDuplicatesOrSkips() async throws {
        let library = FakePhotoLibrary()
        let now = Date()
        library.assetsByPhase[.screenshots] = (0 ..< 5).map {
            makeAsset("shot-\($0)", date: now.addingTimeInterval(Double($0)), isScreenshot: true)
        }
        let source = try makeSource(library: library, pageLimit: 2)

        // Simulate a kill after the first page: only the cursor survives
        // (a fresh PhotosSource + fresh AnalyzedAssetStore instance reading
        // the same directory — exactly what an app relaunch looks like).
        let first = try await source.syncAndBuffer(cursor: nil)
        XCTAssertEqual(first.documents.map(\.externalId), ["shot-0", "shot-1"])

        let resumed = try makeSource(library: library, pageLimit: 2)
        let second = try await resumed.syncAndBuffer(cursor: first.cursor)
        XCTAssertEqual(second.documents.map(\.externalId), ["shot-2", "shot-3"], "resumes after shot-1, no duplicates or skips")

        let third = try await resumed.syncAndBuffer(cursor: second.cursor)
        XCTAssertEqual(third.documents.map(\.externalId), ["shot-4"])

        let allProcessed = first.documents.map(\.externalId) + second.documents.map(\.externalId) + third.documents.map(\.externalId)
        XCTAssertEqual(allProcessed, ["shot-0", "shot-1", "shot-2", "shot-3", "shot-4"], "every asset exactly once")
    }

    // MARK: - Steady phase: Recently Added sweep, rich analysis, idempotent dedup

    func testSteadyPhaseRunsRichAnalysisOnUnanalyzedRecentlyAddedAssets() async throws {
        let library = FakePhotoLibrary()
        library.recentlyAdded = [makeAsset("new-1", date: Date())]
        let source = try makeSource(library: library)
        let steadyCursor = PhotosCursor(phase: .steady).encode()

        let result = try await source.syncAndBuffer(cursor: steadyCursor)
        XCTAssertEqual(result.documents.map(\.externalId), ["new-1"])
        XCTAssertEqual(library.analyzeCalls.map(\.tier), [.new], "steady-phase assets get the full rich-analysis tier")
        XCTAssertFalse(result.hasMore)
    }

    func testSteadyPhaseSkipsAlreadyRichlyAnalyzedAssets() async throws {
        let library = FakePhotoLibrary()
        let asset = makeAsset("new-1", date: Date())
        library.recentlyAdded = [asset]
        let assetIndex = AnalyzedAssetStore(directory: directory)
        await assetIndex.record(localIdentifier: asset.localIdentifier, richlyAnalyzed: true)

        let source = try PhotosSource(
            library: library,
            assetIndex: assetIndex,
            gateway: makeGateway()
        )
        let result = try await source.syncAndBuffer(cursor: PhotosCursor(phase: .steady).encode())
        XCTAssertTrue(result.documents.isEmpty, "already-analyzed asset is skipped — idempotent")
        XCTAssertTrue(library.analyzeCalls.isEmpty)
    }

    func testLiveObserverAndSteadySweepAgreeViaTheSharedAssetIndex() async throws {
        // Simulates the live-observer path marking an asset analyzed
        // directly (as PhotosSource's own analyze+record flow would),
        // then the backstop sweep finding the SAME asset in Recently
        // Added on its next pass — it must not re-run rich analysis.
        let library = FakePhotoLibrary()
        let asset = makeAsset("new-1", date: Date())
        library.recentlyAdded = [asset]
        let assetIndex = AnalyzedAssetStore(directory: directory)
        let source = try PhotosSource(
            library: library,
            assetIndex: assetIndex,
            gateway: makeGateway()
        )

        let firstPass = try await source.syncAndBuffer(cursor: PhotosCursor(phase: .steady).encode())
        XCTAssertEqual(firstPass.documents.count, 1)

        let secondPass = try await source.syncAndBuffer(cursor: firstPass.cursor)
        XCTAssertTrue(secondPass.documents.isEmpty, "second sweep finds nothing new — already analyzed by the first")
        XCTAssertEqual(library.analyzeCalls.count, 1, "analyzed exactly once across both passes")
    }

    // MARK: - Authorization-safe reconciliation and restoration

    func testReconcileSkipsAnIncompleteLibrarySnapshot() async throws {
        let library = FakePhotoLibrary()
        library.accessState = .limited
        let source = try makeSource(library: library)
        let outcome = try await source.reconcileDeletions()
        XCTAssertEqual(outcome, .skippedIncompleteAccess(.limited))
    }

    func testFullToLimitedDuringSnapshotNeverCallsReconcile() async throws {
        let library = FakePhotoLibrary()
        library.allExternalIds = ["kept-1"]
        library.snapshotAccessAfterEnumeration = .limited
        let session = StubSession()
        let source = try PhotosSource(
            library: library,
            assetIndex: AnalyzedAssetStore(directory: directory),
            gateway: makeGateway(session: session)
        )

        let outcome = try await source.reconcileDeletions()

        XCTAssertEqual(outcome, .skippedIncompleteAccess(.limited))
        XCTAssertTrue(session.requests.isEmpty, "an authorization-scoped snapshot must never delete")
    }

    func testFullToDeniedDuringSnapshotNeverCallsReconcile() async throws {
        let library = FakePhotoLibrary()
        library.snapshotAccessAfterEnumeration = .denied
        let session = StubSession()
        let source = try PhotosSource(
            library: library,
            assetIndex: AnalyzedAssetStore(directory: directory),
            gateway: makeGateway(session: session)
        )

        let outcome = try await source.reconcileDeletions()

        XCTAssertEqual(outcome, .skippedIncompleteAccess(.denied))
        XCTAssertTrue(session.requests.isEmpty)
    }

    func testCompleteFullSnapshotCallsReconcileWithAllVisibleIds() async throws {
        let library = FakePhotoLibrary()
        library.allExternalIds = ["photo-1", "photo-2"]
        let session = StubSession()
        let source = try PhotosSource(
            library: library,
            assetIndex: AnalyzedAssetStore(directory: directory),
            gateway: makeGateway(session: session)
        )

        let outcome = try await source.reconcileDeletions()

        XCTAssertEqual(outcome, .performed)
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertTrue(request.url?.path.hasSuffix("/documents/reconcile") == true)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        )
        XCTAssertEqual(body["presentExternalIds"] as? [String], ["photo-1", "photo-2"])
    }

    func testRestoredFullAccessRestartsAnOldSteadyCursorAndRepublishesOldEpochAssets() async throws {
        let library = FakePhotoLibrary()
        let asset = makeAsset("restored-1", date: Date(), isScreenshot: true)
        library.assetsByPhase[.screenshots] = [asset]
        let index = AnalyzedAssetStore(directory: directory)
        await index.record(
            localIdentifier: asset.localIdentifier,
            richlyAnalyzed: true,
            epoch: 0
        )
        let source = try PhotosSource(
            library: library,
            assetIndex: index,
            gateway: makeGateway(),
            accessEpoch: 1,
            pageLimit: 10
        )

        let result = try await source.syncAndBuffer(cursor: PhotosCursor(phase: .steady, accessEpoch: 0).encode())

        XCTAssertEqual(result.documents.map(\.externalId), ["restored-1"])
        XCTAssertEqual(
            library.analyzeCalls.map(\.tier),
            [.new],
            "restoration must not overwrite a previously rich document with backfill-quality content"
        )
        XCTAssertEqual(PhotosCursor.decode(from: result.cursor).accessEpoch, 1)
        XCTAssertNotEqual(PhotosCursor.decode(from: result.cursor).phase, .steady)
    }

    func testObsoleteSourceRefusesCursorFromNewerAccessEpoch() async throws {
        let library = FakePhotoLibrary()
        library.recentlyAdded = [makeAsset("newer-epoch", date: Date())]
        let source = try PhotosSource(
            library: library,
            assetIndex: AnalyzedAssetStore(directory: directory),
            gateway: makeGateway(),
            accessEpoch: 1
        )
        let newer = PhotosCursor(phase: .steady, accessEpoch: 2)

        let result = try await source.syncAndBuffer(cursor: newer.encode())

        XCTAssertTrue(result.documents.isEmpty)
        XCTAssertTrue(library.analyzeCalls.isEmpty)
        XCTAssertEqual(PhotosCursor.decode(from: result.cursor), newer)
    }

    func testDisableAndReenableReplayRetainedAssetsIntoTheNewPartition() async throws {
        let settings = PhotosSettings(defaults: DictionaryDefaults())
        XCTAssertTrue(settings.observeAccess(.full))
        XCTAssertFalse(settings.observeAccess(.denied))
        XCTAssertTrue(settings.observeAccess(.full))
        XCTAssertEqual(settings.accessEpoch, 2)
        settings.enable()
        let previousEpoch = settings.accessEpoch

        let library = FakePhotoLibrary()
        let asset = makeAsset("current-epoch", date: Date())
        library.recentlyAdded = [asset]
        let index = AnalyzedAssetStore(directory: directory)
        await index.record(
            localIdentifier: asset.localIdentifier,
            richlyAnalyzed: true,
            epoch: settings.accessEpoch
        )

        settings.disable()
        settings.enable()
        XCTAssertEqual(settings.accessEpoch, previousEpoch + 1)

        let source = try PhotosSource(
            library: library,
            assetIndex: index,
            gateway: makeGateway(),
            accessEpoch: settings.accessEpoch
        )
        let result = try await source.syncAndBuffer(
            cursor: PhotosCursor(phase: .steady, accessEpoch: previousEpoch).encode()
        )

        XCTAssertEqual(result.documents.map(\.externalId), [asset.externalId])
        XCTAssertEqual(library.analyzeCalls.count, 1)
        XCTAssertEqual(library.analyzeCalls.first?.tier, .new)
        XCTAssertEqual(PhotosCursor.decode(from: result.cursor).accessEpoch, settings.accessEpoch)
        let repeated = try await source.syncAndBuffer(cursor: result.cursor)
        XCTAssertTrue(repeated.documents.isEmpty)
        XCTAssertEqual(library.analyzeCalls.count, 1)
    }

    func testPhotosAdvertisesAndUploadsAsAnIndependentPartition() throws {
        let source = try PhotosSource(
            library: FakePhotoLibrary(),
            assetIndex: AnalyzedAssetStore(directory: directory),
            gateway: makeGateway()
        )
        XCTAssertEqual(photosHostedSourceContract.multiDeviceMode, .partitioned)
        XCTAssertEqual(source.multiDeviceMode, .partitioned)
    }
}

extension PhotosSourceTests {
    func testUnreadableIndexCannotConsumeAnAuthoritativeNilCursorReset() async throws {
        let index = AnalyzedAssetStore(directory: directory)
        let library = FakePhotoLibrary()
        let asset = makeAsset("locked-replay", date: Date())
        library.assetsByPhase[.screenshots] = [asset]
        await index.record(localIdentifier: asset.localIdentifier, richlyAnalyzed: true)
        try await index.flush()
        let indexFile = directory.appendingPathComponent("photos-asset-index.json")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: indexFile.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: indexFile.path) }
        let source = try makeSource(library: library)
        do {
            _ = try await source.sync(cursor: nil)
            XCTFail("nil must remain authoritative until reset acknowledgments are writable")
        } catch {}
        XCTAssertTrue(library.analyzeCalls.isEmpty)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: indexFile.path)
        let result = try await source.syncAndBuffer(cursor: nil)
        XCTAssertEqual(result.documents.map(\.externalId), [asset.externalId])
        XCTAssertEqual(library.analyzeCalls.first?.tier, .new)
    }

    func testUnbufferedPhotoPageIsReplayedAndCannotAcknowledgeAnotherPage() async throws {
        let library = FakePhotoLibrary()
        let asset = makeAsset("queued-image", date: Date())
        library.recentlyAdded = [asset]
        let source = try makeSource(library: library)
        let cursor = PhotosCursor(phase: .steady).encode()
        let first = try await source.sync(cursor: cursor)
        let index = AnalyzedAssetStore(directory: directory)
        let prematurelyMarked = await index.wasPushed(asset.localIdentifier, inEpoch: 0)
        XCTAssertFalse(prematurelyMarked)
        let second = try await source.sync(cursor: cursor)
        XCTAssertEqual(second.documents, first.documents)
        do {
            try await source.didBuffer(first)
            XCTFail("an older page must not acknowledge the current pending page")
        } catch {}
        try await source.didBuffer(second)
        let repeated = try await source.sync(cursor: second.cursor)
        XCTAssertTrue(repeated.documents.isEmpty)
    }

    func testMissingGatewayCursorReplaysAllRetainedBackfillPhasesWithoutDowngrading() async throws {
        let library = FakePhotoLibrary()
        let now = Date()
        let assets = [
            makeAsset("replay-shot", date: now, isScreenshot: true),
            makeAsset("replay-recent", date: now),
            makeAsset("replay-old", date: now.addingTimeInterval(-400 * day)),
        ]
        library.assetsByPhase[.screenshots] = [assets[0]]
        library.assetsByPhase[.recent] = [assets[1]]
        library.assetsByPhase[.backfill] = [assets[2]]
        let index = AnalyzedAssetStore(directory: directory)
        for asset in assets {
            await index.record(localIdentifier: asset.localIdentifier, richlyAnalyzed: true)
        }
        try await index.flush()
        let source = try makeSource(library: library, pageLimit: 10)
        var result = try await source.syncAndBuffer(cursor: nil)
        var emitted = result.documents.map(\.externalId)
        while result.hasMore {
            result = try await source.syncAndBuffer(cursor: result.cursor)
            emitted.append(contentsOf: result.documents.map(\.externalId))
        }
        XCTAssertEqual(emitted, assets.map(\.externalId))
        XCTAssertEqual(library.analyzeCalls.map(\.tier), [.new, .new, .new])
        let repeated = try await source.syncAndBuffer(cursor: result.cursor)
        XCTAssertTrue(repeated.documents.isEmpty)
    }

    func testAdoptedNonnilBackfillCursorPreservesProgressAndAnalysisMarks() async throws {
        let library = FakePhotoLibrary()
        let asset = makeAsset("adopted-rich", date: Date())
        library.assetsByPhase[.backfill] = [asset]
        let index = AnalyzedAssetStore(directory: directory)
        await index.record(localIdentifier: asset.localIdentifier, richlyAnalyzed: true)
        try await index.flush()
        let source = try makeSource(library: library)
        let result = try await source.syncAndBuffer(cursor: PhotosCursor(phase: .backfill).encode())
        XCTAssertTrue(result.documents.isEmpty)
        XCTAssertTrue(library.analyzeCalls.isEmpty)
        XCTAssertEqual(PhotosCursor.decode(from: result.cursor).phase, .steady)
    }

    // MARK: - tableName is always nil (documents-only source)

    func testDiscoveryPageOrdersBoundaryTiesWithBoundedMemory() {
        var page = PhotoPageSelection<String>(limit: 2)
        for id in ["z", "y", "x", "b", "a"] {
            XCTAssertFalse(page.isPastBoundary(date: "same-date"))
            page.consider(id, date: "same-date", id: id)
            XCTAssertLessThanOrEqual(page.assets.count, 2)
        }
        XCTAssertEqual(page.assets, ["a", "b"])
        XCTAssertTrue(page.isPastBoundary(date: "tomorrow"))
    }

    func testUndatedCursorDoesNotExcludeRemainingUndatedAssets() {
        let sentinel = PhotosCursor.dateFormatter.string(from: .distantPast)
        XCTAssertNil(PhotosCursor.fetchDateFloor(after: sentinel))
        XCTAssertNil(PhotosCursor.fetchDateFloor(after: nil))
        let dated = Date(timeIntervalSince1970: 1000)
        XCTAssertEqual(PhotosCursor.fetchDateFloor(after: PhotosCursor.dateFormatter.string(from: dated)), dated)

        var visited: [String] = []
        var lastId: String?
        for ids in [["d", "c", "b", "a"], ["b", "a", "d", "c"], ["c", "a", "b", "d"]] {
            var page = PhotoPageSelection<String>(limit: 2)
            for id in ids where lastId == nil || id > lastId! {
                page.consider(id, date: sentinel, id: id)
            }
            visited += page.assets
            lastId = page.assets.last ?? lastId
        }
        XCTAssertEqual(visited, ["a", "b", "c", "d"], "boundary ties survive changing enumeration order")
    }

    func testCancelledSteadyDiscoveryResumesAfterOnlyAcknowledgedAssets() async throws {
        let library = FakePhotoLibrary()
        library.assetsByPhase[.steady] = (0 ..< 3).map {
            makeAsset("cancel-\($0)", date: Date(timeIntervalSince1970: Double($0 + 1)))
        }
        library.cancelAfterAnalysis = true
        let source = try makeSource(library: library)
        let interrupted = try await Task {
            try await source.syncAndBuffer(cursor: PhotosCursor(phase: .steady).encode())
        }.value
        XCTAssertEqual(interrupted.documents.map(\.externalId), ["cancel-0"])
        XCTAssertEqual(PhotosCursor.decode(from: interrupted.cursor).lastAssetId, "cancel-0")
        library.cancelAfterAnalysis = false
        let resumed = try await makeSource(library: library).syncAndBuffer(cursor: interrupted.cursor)
        XCTAssertEqual(resumed.documents.map(\.externalId), ["cancel-1", "cancel-2"])
    }

    func testSteadyDiscoveryResumesAfterRestartAndWrapsWithoutReuploading() async throws {
        let library = FakePhotoLibrary()
        let assets = (0 ..< 5).map { makeAsset("walk-\($0)", date: Date(timeIntervalSince1970: Double($0 + 1))) }
        library.assetsByPhase[.steady] = assets
        var cursor = PhotosCursor(phase: .steady, backfillCompletedAt: "preserved").encode()
        var emitted: [String] = []
        for expectedCount in [2, 2, 1, 0, 0, 0] {
            // Reconstruct both source and on-disk index between every page.
            let source = try makeSource(library: library)
            let result = try await source.syncAndBuffer(cursor: cursor)
            XCTAssertEqual(result.documents.count, expectedCount)
            XCTAssertFalse(result.hasMore, "one bounded discovery page per sync")
            XCTAssertEqual(PhotosCursor.decode(from: result.cursor).backfillCompletedAt, "preserved")
            emitted += result.documents.map(\.externalId)
            cursor = result.cursor
        }
        XCTAssertEqual(emitted, assets.map(\.externalId))
        XCTAssertEqual(library.analyzeCalls.count, 5)
        XCTAssertTrue(library.analyzeCalls.allSatisfy { $0.tier == .new })
    }

    func testSteadyDiscoveryFindsAnOldImportBuriedBeyondRecentWindow() async throws {
        let library = FakePhotoLibrary()
        let buried = makeAsset("old-import", date: Date(timeIntervalSince1970: 1), isScreenshot: true)
        library.recentlyAdded = (0 ..< 201).map {
            makeAsset("recent-\($0)", date: Date(timeIntervalSince1970: Double(1000 + $0)))
        }
        library.assetsByPhase[.steady] = [buried]
        let source = try makeSource(library: library)
        let result = try await source.syncAndBuffer(cursor: PhotosCursor(phase: .steady).encode())
        XCTAssertTrue(result.documents.contains { $0.externalId == buried.externalId })
        XCTAssertEqual(result.documents.count, 201, "recent sweep plus bounded discovery, not entire library")
    }

    func testLimitedSteadyDiscoveryReplaysUnacknowledgedPageAndFindsOlderSelectionAfterWrap() async throws {
        let library = FakePhotoLibrary()
        library.accessState = .limited
        let asset = makeAsset("visible-selection", date: Date(timeIntervalSince1970: 10))
        library.assetsByPhase[.steady] = [asset]
        let cursor = PhotosCursor(phase: .steady).encode()
        let first = try await makeSource(library: library).sync(cursor: cursor)
        XCTAssertEqual(first.documents.map(\.externalId), [asset.externalId])
        // A failed enqueue must not acknowledge the asset or lose it on restart.
        let retry = try await makeSource(library: library).syncAndBuffer(cursor: cursor)
        XCTAssertEqual(retry.documents, first.documents)
        let older = makeAsset("older-selection", date: Date(timeIntervalSince1970: 5))
        library.assetsByPhase[.steady] = [older, asset]
        let next = try await makeSource(library: library).syncAndBuffer(cursor: retry.cursor)
        XCTAssertEqual(next.documents.map(\.externalId), [older.externalId])
        XCTAssertTrue(next.deletedIds.isEmpty)
    }

    func testSyncResultNeverCarriesAnAnalyticsTableName() async throws {
        let library = FakePhotoLibrary()
        library.assetsByPhase[.screenshots] = [makeAsset("shot-1", date: Date())]
        let source = try makeSource(library: library, pageLimit: 10)
        let result = try await source.syncAndBuffer(cursor: nil)
        XCTAssertNil(result.tableName)
        XCTAssertTrue(result.records.isEmpty)
    }
}

extension PhotosSource {
    /// Successful collector ordering for source-only tests. Failure tests call
    /// `sync` directly so no durable-buffer acknowledgment is manufactured.
    fileprivate func syncAndBuffer(cursor: SyncCursor?) async throws -> SyncResult {
        let result = try await sync(cursor: cursor)
        if !result.documents.isEmpty { try await didBuffer(result) }
        return result
    }
}
