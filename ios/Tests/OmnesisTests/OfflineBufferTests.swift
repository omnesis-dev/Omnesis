// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class OfflineBufferTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-buffer-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func makeBatch(
        id: String? = nil,
        recordCount: Int = 1,
        sourceId: String = "apple-health:local",
        tableName: String = "health_body"
    )
        -> Batch {
        let records: [[String: JSONValue]] = (0 ..< recordCount).map { i in
            ["id": .string("uuid-\(i)"), "value": .double(Double(i) + 70)]
        }
        return Batch(
            id: id ?? Batch.makeId(),
            sourceId: sourceId,
            tableName: tableName,
            records: records,
            schema: nil,
            deletedIds: [],
            createdAt: Date()
        )
    }

    func testEnqueueAndPeek() async throws {
        let buf = OfflineBuffer(directory: directory)
        let batch = makeBatch()
        try await buf.enqueue(batch)
        let peeked = try await buf.peekOldest()
        XCTAssertEqual(peeked?.id, batch.id)
        XCTAssertEqual(peeked?.records.count, batch.records.count)
        let count = try await buf.count()
        XCTAssertEqual(count, 1)
    }

    func testEnqueueFailsClosedWhenBackupExclusionCannotBeApplied() async throws {
        let buffer = OfflineBuffer(directory: directory)
        try FileManager.default.removeItem(at: directory)

        do {
            try await buffer.enqueue(makeBatch())
            XCTFail("Corpus data must not be written without backup exclusion")
        } catch {
            XCTAssertEqual(
                error as? ProtectedStoreError,
                .backupExclusionFailed(.offlineBuffer)
            )
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testFIFOOrder() async throws {
        let buf = OfflineBuffer(directory: directory)
        let a = makeBatch(id: "20260418T100000000-aaaa")
        let b = makeBatch(id: "20260418T100001000-bbbb")
        let c = makeBatch(id: "20260418T100002000-cccc")
        try await buf.enqueue(a)
        try await buf.enqueue(b)
        try await buf.enqueue(c)

        let peek1 = try await buf.peekOldest()
        XCTAssertEqual(peek1?.id, "20260418T100000000-aaaa")
        try await buf.remove(id: "20260418T100000000-aaaa")
        let peek2 = try await buf.peekOldest()
        XCTAssertEqual(peek2?.id, "20260418T100001000-bbbb")
        try await buf.remove(id: "20260418T100001000-bbbb")
        let peek3 = try await buf.peekOldest()
        XCTAssertEqual(peek3?.id, "20260418T100002000-cccc")
    }

    func testRemoveIsIdempotent() async throws {
        let buf = OfflineBuffer(directory: directory)
        // Remove a batch that was never enqueued — should not throw.
        try await buf.remove(id: "never-was-here")
    }

    func testPersistenceAcrossInstances() async throws {
        let bufA = OfflineBuffer(directory: directory)
        try await bufA.enqueue(makeBatch(id: "20260418T100000000-aaaa"))
        try await bufA.enqueue(makeBatch(id: "20260418T100001000-bbbb"))

        // Fresh instance reading the same directory sees both batches.
        let bufB = OfflineBuffer(directory: directory)
        let count = try await bufB.count()
        XCTAssertEqual(count, 2)
        let peeked = try await bufB.peekOldest()
        XCTAssertEqual(peeked?.id, "20260418T100000000-aaaa")
    }

    func testLoadingFilesRemovedByAnotherOwnerHealsCachedHealthState() async throws {
        let ids = [agedId(10 * 60 * 60), agedId(9 * 60 * 60)]
        let current = OfflineBuffer(directory: directory)
        for id in ids {
            try await current.enqueue(makeBatch(id: id))
        }
        let initialCount = try await current.count()
        XCTAssertEqual(initialCount, 2)

        let previous = OfflineBuffer(directory: directory)
        for id in ids {
            try await previous.remove(id: id)
        }

        for id in try await current.listIds() {
            let batch = try await current.load(id: id)
            XCTAssertNil(batch)
        }
        let finalCount = try await current.count()
        let finalSize = try await current.totalSizeBytes()
        let finalAge = try await current.oldestBatchAge()
        XCTAssertEqual(finalCount, 0)
        XCTAssertEqual(finalSize, 0)
        XCTAssertNil(finalAge)
    }

    func testEvictionWhenOverSizeLimit() async throws {
        // A 1 KB cap. Each batch has records ~200 bytes of JSON.
        let config = OfflineBuffer.Config(maxSizeBytes: 2048, warningSizeBytes: 1024)
        let buf = OfflineBuffer(directory: directory, config: config)

        // Push many small batches until we force eviction.
        var totalEvicted = 0
        for i in 0 ..< 50 {
            let id = String(format: "20260418T10000%04d-zzzz", i)
            let evicted = try await buf.enqueue(makeBatch(id: id, recordCount: 5))
            totalEvicted += evicted
        }

        let size = try await buf.totalSizeBytes()
        XCTAssertLessThanOrEqual(size, 2048, "Buffer should not exceed cap; was \(size)")
        XCTAssertGreaterThan(totalEvicted, 0, "Expected at least some evictions under pressure")
    }

    func testWarningThresholdCrossed() async throws {
        let config = OfflineBuffer.Config(maxSizeBytes: 100_000, warningSizeBytes: 200)
        let buf = OfflineBuffer(directory: directory, config: config)
        // Empty buffer is not under pressure.
        let emptyPressure = try await buf.isPressure()
        XCTAssertFalse(emptyPressure)
        // Add enough batches to cross the warning.
        for i in 0 ..< 10 {
            let id = String(format: "20260418T10000%04d-wwww", i)
            try await buf.enqueue(makeBatch(id: id, recordCount: 10))
        }
        let pressure = try await buf.isPressure()
        XCTAssertTrue(pressure)
    }

    // MARK: - Quarantine

    /// Two failures then quarantine, and only for batches old enough that a
    /// server-side fix has had its chance.
    private func quarantineConfig(
        attempts: Int = 2,
        grace: TimeInterval = 0,
        retained: Int = 3
    )
        -> OfflineBuffer.Config {
        OfflineBuffer.Config(
            maxSizeBytes: 100_000,
            warningSizeBytes: 50000,
            quarantineAfterAttempts: attempts,
            quarantineGrace: grace,
            maxQuarantinedBatches: retained
        )
    }

    /// An id whose embedded timestamp puts the batch `age` in the past.
    private func agedId(_ age: TimeInterval) -> String {
        Batch.makeId(now: Date().addingTimeInterval(-age))
    }

    func testPermanentFailuresBelowThresholdKeepTheBatchQueued() async throws {
        let buf = OfflineBuffer(directory: directory, config: quarantineConfig())
        let id = agedId(4 * 60 * 60)
        try await buf.enqueue(makeBatch(id: id))

        let quarantined = try await buf.recordPermanentFailure(id: id)
        XCTAssertFalse(quarantined, "One failure is not enough to give up")
        let count = try await buf.count()
        XCTAssertEqual(count, 1)
        let setAside = try await buf.quarantinedCount()
        XCTAssertEqual(setAside, 0)
    }

    func testQuarantineAfterEnoughFailures() async throws {
        let buf = OfflineBuffer(directory: directory, config: quarantineConfig())
        let id = agedId(4 * 60 * 60)
        try await buf.enqueue(makeBatch(id: id))

        _ = try await buf.recordPermanentFailure(id: id)
        let quarantined = try await buf.recordPermanentFailure(id: id)

        XCTAssertTrue(quarantined)
        let count = try await buf.count()
        XCTAssertEqual(count, 0, "A quarantined batch leaves the FIFO")
        let ids = try await buf.listIds()
        XCTAssertTrue(ids.isEmpty, "The uploader must stop seeing it")
        let age = try await buf.oldestBatchAge()
        XCTAssertNil(age, "The stale-backlog signal it was pinning must clear")
        let setAside = try await buf.quarantinedCount()
        XCTAssertEqual(setAside, 1, "But the data is kept, not destroyed")
    }

    /// The grace window is what stops a burst of drains from exhausting the
    /// retry budget in seconds, before a gateway-side fix could land. It runs
    /// from the first permanent failure — an old batch fresh out of an outage
    /// must still get its window, and a drain runs once per source, so a
    /// single foreground can otherwise spend the whole budget at once.
    func testAnOldBatchStillGetsItsGraceWindow() async throws {
        let buf = OfflineBuffer(
            directory: directory,
            config: quarantineConfig(grace: 60 * 60)
        )
        let id = agedId(72 * 60 * 60)
        try await buf.enqueue(makeBatch(id: id))

        for _ in 0 ..< 10 {
            let quarantined = try await buf.recordPermanentFailure(id: id)
            XCTAssertFalse(quarantined, "Failures minutes apart must not exhaust the window")
        }
        let count = try await buf.count()
        XCTAssertEqual(count, 1)
    }

    /// iOS relaunches the app between background drains. An in-memory count
    /// would restart at zero every time, so the threshold would never be
    /// reached and the batch would be retried forever.
    func testFailureCountsSurviveAFreshBuffer() async throws {
        let config = quarantineConfig()
        let id = agedId(4 * 60 * 60)
        let bufA = OfflineBuffer(directory: directory, config: config)
        try await bufA.enqueue(makeBatch(id: id))
        _ = try await bufA.recordPermanentFailure(id: id)

        let bufB = OfflineBuffer(directory: directory, config: config)
        let quarantined = try await bufB.recordPermanentFailure(id: id)

        XCTAssertTrue(quarantined, "The earlier failure must still count")
    }

    /// The sidecar holding those counts lives in the buffer directory and
    /// must not be mistaken for a batch by the FIFO scan.
    func testAttemptSidecarIsNotReadBackAsABatch() async throws {
        let config = quarantineConfig()
        let id = agedId(4 * 60 * 60)
        let bufA = OfflineBuffer(directory: directory, config: config)
        try await bufA.enqueue(makeBatch(id: id))
        _ = try await bufA.recordPermanentFailure(id: id)

        let bufB = OfflineBuffer(directory: directory, config: config)
        let count = try await bufB.count()
        XCTAssertEqual(count, 1, "Only the batch itself is queued")
        let peeked = try await bufB.peekOldest()
        XCTAssertEqual(peeked?.id, id)
    }

    /// A delivered batch must not hand its failure history to whatever comes
    /// next — including a batch that reuses its id.
    func testSuccessfulRemovalClearsTheFailureCount() async throws {
        let config = quarantineConfig()
        let id = agedId(4 * 60 * 60)
        let buf = OfflineBuffer(directory: directory, config: config)
        try await buf.enqueue(makeBatch(id: id))
        _ = try await buf.recordPermanentFailure(id: id)
        try await buf.remove(id: id)

        try await buf.enqueue(makeBatch(id: id))
        let quarantined = try await buf.recordPermanentFailure(id: id)
        XCTAssertFalse(quarantined, "The count restarts from zero")
    }

    func testFailureForAnAbsentBatchIsANoOp() async throws {
        let buf = OfflineBuffer(directory: directory, config: quarantineConfig())
        let quarantined = try await buf.recordPermanentFailure(id: agedId(4 * 60 * 60))
        XCTAssertFalse(quarantined)
        let setAside = try await buf.quarantinedCount()
        XCTAssertEqual(setAside, 0)
    }

    func testQuarantineRetentionIsCapped() async throws {
        let config = quarantineConfig(retained: 2)
        let buf = OfflineBuffer(directory: directory, config: config)

        var ids: [String] = []
        for index in 0 ..< 4 {
            // Descending age keeps the ids in ascending (creation) order.
            let id = agedId(TimeInterval(4 - index) * 60 * 60)
            ids.append(id)
            try await buf.enqueue(makeBatch(id: id))
            _ = try await buf.recordPermanentFailure(id: id)
            _ = try await buf.recordPermanentFailure(id: id)
        }

        let setAside = try await buf.quarantinedCount()
        XCTAssertEqual(setAside, 2, "Oldest quarantined batches are dropped past the cap")
        let kept = try FileManager.default.contentsOfDirectory(
            at: directory.appendingPathComponent("quarantine"), includingPropertiesForKeys: nil
        )
        .map { $0.deletingPathExtension().lastPathComponent }
        .sorted()
        XCTAssertEqual(kept, Array(ids.suffix(2)), "The newest two survive")
        let count = try await buf.count()
        XCTAssertEqual(count, 0)
    }

    /// The sidecar must not resurrect a run against an id that is no longer
    /// queued — a delivered batch's history handed to a future batch would
    /// quarantine it early.
    func testStaleSidecarEntriesArePruned() async throws {
        let config = quarantineConfig()
        let id = agedId(4 * 60 * 60)
        let bufA = OfflineBuffer(directory: directory, config: config)
        try await bufA.enqueue(makeBatch(id: id))
        _ = try await bufA.recordPermanentFailure(id: id)
        // Delete the batch behind the buffer's back, leaving the sidecar entry.
        try FileManager.default.removeItem(at: directory.appendingPathComponent("\(id).json"))

        let bufB = OfflineBuffer(directory: directory, config: config)
        try await bufB.enqueue(makeBatch(id: id))
        let quarantined = try await bufB.recordPermanentFailure(id: id)
        XCTAssertFalse(quarantined, "The pruned run must not count toward the new batch")
    }

    /// A batch whose delete keeps failing is one of the classes quarantine
    /// exists to terminate. Clearing the failure history before the delete
    /// succeeded would reset its count on every pass, so it would never
    /// reach the budget and the queue would never drain.
    func testDeleteFailuresStillAccumulateTowardQuarantine() async throws {
        let config = quarantineConfig()
        let id = agedId(4 * 60 * 60)
        let buf = OfflineBuffer(directory: directory, config: config)
        try await buf.enqueue(makeBatch(id: id))

        // Mirrors the uploader's delivered-but-not-removed path: a remove
        // that throws, then a permanent failure recorded against the batch.
        _ = try? await buf.remove(id: "nonexistent-sibling")
        _ = try await buf.recordPermanentFailure(id: id)
        let quarantined = try await buf.recordPermanentFailure(id: id)
        XCTAssertTrue(quarantined, "Counts must survive an intervening remove of another batch")
    }

    func testDiscardQuarantinedDeletesThem() async throws {
        let buf = OfflineBuffer(directory: directory, config: quarantineConfig())
        let id = agedId(4 * 60 * 60)
        try await buf.enqueue(makeBatch(id: id))
        _ = try await buf.recordPermanentFailure(id: id)
        _ = try await buf.recordPermanentFailure(id: id)

        let discarded = try await buf.discardQuarantined()
        XCTAssertEqual(discarded, 1)
        let setAside = try await buf.quarantinedCount()
        XCTAssertEqual(setAside, 0)
        let discardedAgain = try await buf.discardQuarantined()
        XCTAssertEqual(discardedAgain, 0, "Discarding twice is harmless")
    }

    func testBatchMakeIdIsMonotonic() {
        // IDs generated from strictly-increasing timestamps (spaced at least
        // 10 ms apart so the millisecond field always differs) must sort
        // in the same order. The random hex suffix is a tiebreaker for
        // IDs born within the same millisecond; we don't claim order
        // within a millisecond.
        var last = Batch.makeId(now: Date(timeIntervalSince1970: 1_700_000_000))
        for i in 1 ..< 200 {
            let id = Batch.makeId(now: Date(timeIntervalSince1970: 1_700_000_000 + Double(i) * 0.01))
            XCTAssertLessThan(last, id, "IDs should be monotonic; \(last) !< \(id)")
            last = id
        }
    }
}
