// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A background wake, end to end through `CollectorCore`, on simulated time:
/// the wake ends only after its sync has delivered what it read (or when its
/// time is nearly gone), wakes that arrive together share one pass, a bounded
/// pass reads only what it can also deliver, and a buffer under pressure
/// slows reading down instead of dropping anything.
final class CollectorWakeTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-wake-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    // MARK: - Fixtures

    /// Simulated time. `sleep(until:)` returns once `advance` passes the date.
    final class FakeClock: SyncClock, @unchecked Sendable {
        private let lock = NSLock()
        private var current = Date(timeIntervalSince1970: 1_780_000_000)
        private var sleepers: [(Date, CheckedContinuation<Void, Never>)] = []

        func now() -> Date {
            lock.withLock { current }
        }

        func advance(by seconds: TimeInterval) {
            let due: [CheckedContinuation<Void, Never>] = lock.withLock {
                current = current.addingTimeInterval(seconds)
                let ready = sleepers.filter { $0.0 <= current }.map(\.1)
                sleepers.removeAll { $0.0 <= current }
                return ready
            }
            due.forEach { $0.resume() }
        }

        func sleep(until date: Date) async {
            await withCheckedContinuation { continuation in
                let ready: Bool = lock.withLock {
                    if date <= current { return true }
                    sleepers.append((date, continuation))
                    return false
                }
                if ready { continuation.resume() }
            }
        }

        /// Wake every sleeper, so no continuation outlives a test.
        func releaseAll() {
            let all: [CheckedContinuation<Void, Never>] = lock.withLock {
                defer { sleepers.removeAll() }
                return sleepers.map(\.1)
            }
            all.forEach { $0.resume() }
        }
    }

    /// Holds every caller at `block()` until `release()`, then lets everyone
    /// through for good.
    actor OneShotGate {
        private var open = false
        private var started = false
        private var blocked: [CheckedContinuation<Void, Never>] = []
        private var startWaiters: [CheckedContinuation<Void, Never>] = []

        func block() async {
            started = true
            startWaiters.forEach { $0.resume() }
            startWaiters.removeAll()
            guard !open else { return }
            await withCheckedContinuation { blocked.append($0) }
        }

        func waitUntilStarted() async {
            guard !started else { return }
            await withCheckedContinuation { startWaiters.append($0) }
        }

        func release() {
            open = true
            blocked.forEach { $0.resume() }
            blocked.removeAll()
        }
    }

    /// The gateway: answers cursor reads and writes, records every ingest,
    /// and lets a test decide how each ingest goes and what it costs.
    enum IngestAnswer { case accept, unavailable, cutOff }

    /// The body of a cursor write.
    struct SavedCursor: Decodable {
        let cursor: SyncCursor
    }

    final class FakeGateway: URLSessionLike, @unchecked Sendable {
        private let lock = NSLock()
        private(set) var ingestedIds: [String] = []
        private(set) var ingestedSources: [String] = []
        private(set) var savedCursors: [SyncCursor] = []
        private var cursors: [String: SyncCursor] = [:]
        var ingestCost: TimeInterval = 0
        var clock: FakeClock?
        var answer: (_ sourceId: String) -> IngestAnswer = { _ in .accept }
        var cursorGate: OneShotGate?

        var deliveredCount: Int {
            lock.withLock { ingestedIds.count }
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let url = try XCTUnwrap(request.url)
            if url.path.hasPrefix("/sync-state/"), request.httpMethod == "GET" {
                if let cursorGate { await cursorGate.block() }
                let stored = lock.withLock { cursors[url.path] }
                guard let stored else { return respond(url, 404, "") }
                let body = try JSONEncoder().encode(["cursor": stored])
                return respond(url, 200, String(bytes: body, encoding: .utf8) ?? "")
            }
            if url.path.hasPrefix("/sync-state/") {
                let saved = try JSONDecoder().decode(SavedCursor.self, from: request.httpBody ?? Data()).cursor
                lock.withLock {
                    cursors[url.path] = saved
                    savedCursors.append(saved)
                }
                return respond(url, 200, "{\"ok\":true}")
            }
            if url.path == "/analytics/ingest" {
                clock?.advance(by: ingestCost)
                let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
                let sourceId = body?["sourceId"] as? String ?? ""
                switch answer(sourceId) {
                case .unavailable:
                    return respond(url, 503, "{\"error\":\"busy\",\"code\":\"QUEUE_FULL\"}")
                case .cutOff:
                    return respond(url, 400, "{\"error\":\"Malformed JSON in request body\",\"code\":\"BAD_REQUEST\"}")
                case .accept:
                    let rows = body?["records"] as? [[String: Any]] ?? []
                    lock.withLock {
                        ingestedIds += rows.compactMap { $0["id"] as? String }
                        ingestedSources.append(sourceId)
                    }
                    return respond(url, 200, "{\"ingested\":\(rows.count),\"deleted\":0}")
                }
            }
            return respond(url, 200, "{\"ok\":true}")
        }

        private func respond(_ url: URL, _ status: Int, _ body: String) -> (Data, URLResponse) {
            let response = HTTPURLResponse(
                url: url,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
    }

    /// Serves `pageCount` pages of invented rows from a numeric cursor, at
    /// `readCost` simulated seconds a page.
    final class PagedSource: OmnesisSource, @unchecked Sendable {
        let id: String
        let displayName = "Paged"
        let analyticsSchemas: [AnalyticsTableSchema] = []
        let pageCount: Int
        let rowsPerPage: Int
        var readCost: TimeInterval = 0
        var clock: FakeClock?
        var readGate: OneShotGate?
        private let lock = NSLock()
        private(set) var pagesRead: [Int] = []
        private(set) var passesBegun = 0

        init(id: String = "paged:a", pageCount: Int, rowsPerPage: Int = 4) {
            self.id = id
            self.pageCount = pageCount
            self.rowsPerPage = rowsPerPage
        }

        func beginPass(cursor: SyncCursor?) -> SyncCursor? {
            lock.withLock { passesBegun += 1 }
            return cursor
        }

        func sync(cursor: SyncCursor?) async throws -> SyncResult {
            if let readGate { await readGate.block() }
            clock?.advance(by: readCost)
            let page = if case .int(let next) = cursor?["next"] { Int(next) } else { 0 }
            guard page < pageCount else {
                return SyncResult(records: [], tableName: "paged_rows", cursor: cursor ?? [:], hasMore: false)
            }
            lock.withLock { pagesRead.append(page) }
            let rows: [[String: JSONValue]] = (0 ..< rowsPerPage).map { row in
                ["id": .string("\(id)-\(page)-\(row)"), "note": .string(String(repeating: "x", count: 96))]
            }
            return SyncResult(
                records: rows,
                tableName: "paged_rows",
                cursor: ["next": .int(Int64(page + 1))],
                hasMore: page + 1 < pageCount
            )
        }
    }

    private func makeCore(
        _ sources: [any OmnesisSource],
        gateway session: FakeGateway,
        bufferConfig: OfflineBuffer.Config = .default,
        onLifecycle: CollectorCore.LifecycleHandler? = nil
    ) throws
        -> (CollectorCore, OfflineBuffer) {
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory, config: bufferConfig)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: sources,
            onLifecycle: onLifecycle
        )
        return (core, buffer)
    }

    private func savedPage(_ cursor: SyncCursor?) -> Int? {
        if case .int(let next) = cursor?["next"] { Int(next) } else { nil }
    }

    // MARK: - The wake ends after its work

    func testAWakeReturnsOnlyAfterItsSyncHasDeliveredWhatItRead() async throws {
        let session = FakeGateway()
        let source = PagedSource(pageCount: 3)
        let (core, buffer) = try makeCore([source], gateway: session)
        let budget = SyncBudget.seconds(30)

        let work = Task { await core.sync(sourceId: source.id, budget: budget) }
        let summary = await awaitWithinBudget(work, budget: budget)

        XCTAssertNotNil(summary.flatMap { $0 }, "the wake waited for the sync rather than the clock")
        XCTAssertEqual(session.deliveredCount, 12, "every row read was uploaded before the wake ended")
        let queued = try await buffer.count()
        XCTAssertEqual(queued, 0)
    }

    func testAWakeEndsBeforeItsDeadlineWhenTheSyncCannotFinish() async throws {
        let clock = FakeClock()
        defer { clock.releaseAll() }
        let session = FakeGateway()
        let gate = OneShotGate()
        let source = PagedSource(pageCount: 3)
        source.readGate = gate
        let (core, _) = try makeCore([source], gateway: session)
        let budget = SyncBudget.seconds(20, clock: clock)

        let work = Task { await core.sync(sourceId: source.id, budget: budget) }
        let wake = Task { await awaitWithinBudget(work, budget: budget) }
        await gate.waitUntilStarted()
        clock.advance(by: 20 - SyncBudget.safetyMargin)

        let result = await wake.value
        XCTAssertNil(result, "with the read still stuck, the wake gives up at the margin, not at suspension")
        await gate.release()
        _ = await work.value
    }

    func testObserverWakesThatArriveTogetherShareOnePass() async throws {
        let session = FakeGateway()
        let cursorGate = OneShotGate()
        session.cursorGate = cursorGate
        let source = PagedSource(pageCount: 2)
        let (core, _) = try makeCore([source], gateway: session)

        // One observer per type fires at once; the first starts the pass.
        let first = Task { await core.sync(sourceId: source.id, budget: .seconds(30)) }
        await cursorGate.waitUntilStarted()
        let others = (0 ..< 4).map { _ in Task { await core.sync(sourceId: source.id, budget: .seconds(30)) } }
        for _ in 0 ..< 200 where await core.sharedCallerCount(sourceId: source.id) < 4 {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        await cursorGate.release()

        var summaries = await [first.value]
        for other in others {
            await summaries.append(other.value)
        }
        XCTAssertEqual(summaries.compactMap { $0 }.count, 5, "every callback completes")
        XCTAssertEqual(source.passesBegun, 1, "callbacks that arrive before reading starts share the pass")
        XCTAssertEqual(session.deliveredCount, 8, "and nothing is read or sent twice")
    }

    func testAForegroundSyncJoiningAShortWakeLiftsItsDeadline() async throws {
        let clock = FakeClock()
        defer { clock.releaseAll() }
        let session = FakeGateway()
        let cursorGate = OneShotGate()
        session.cursorGate = cursorGate
        let source = PagedSource(pageCount: 8)
        source.clock = clock
        source.readCost = 3
        let (core, _) = try makeCore([source], gateway: session)

        let wake = Task { await core.sync(sourceId: source.id, budget: .seconds(10, clock: clock)) }
        await cursorGate.waitUntilStarted()
        let syncNow = Task { await core.sync(sourceId: source.id) }
        for _ in 0 ..< 200 where await core.sharedCallerCount(sourceId: source.id) < 1 {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        await cursorGate.release()
        _ = await wake.value
        _ = await syncNow.value

        XCTAssertEqual(source.passesBegun, 1)
        XCTAssertEqual(source.pagesRead.count, 8, "the joined pass ran on the foreground caller's open budget")
    }

    // MARK: - Bounded by time

    func testABoundedPassReadsOnlyWhatItCanAlsoDeliver() async throws {
        let clock = FakeClock()
        defer { clock.releaseAll() }
        let session = FakeGateway()
        session.clock = clock
        session.ingestCost = 1
        let source = PagedSource(pageCount: 50)
        source.clock = clock
        source.readCost = 2
        let (core, buffer) = try makeCore([source], gateway: session)
        let budget = SyncBudget.seconds(25, clock: clock)

        _ = await core.sync(sourceId: source.id, budget: budget)

        XCTAssertLessThan(source.pagesRead.count, 50)
        XCTAssertGreaterThan(source.pagesRead.count, 0)
        XCTAssertLessThanOrEqual(clock.now(), try XCTUnwrap(budget.deadline), "no work ran past the deadline")
        XCTAssertEqual(session.deliveredCount, source.pagesRead.count * 4, "every page read was delivered")
        let queued = try await buffer.count()
        XCTAssertEqual(queued, 0)
        XCTAssertEqual(savedPage(session.savedCursors.last), source.pagesRead.count, "the next wake resumes after the last page")
    }

    /// One upload that hits a long timeout must not leave every later
    /// background wake judging itself too short to start: the estimate only
    /// falls when something is measured, and nothing is measured in a wake
    /// that declines to start.
    func testOneSlowUploadDoesNotCloseLaterBackgroundWakes() async throws {
        let clock = FakeClock()
        defer { clock.releaseAll() }
        let session = FakeGateway()
        session.clock = clock
        session.ingestCost = 60
        let source = PagedSource(pageCount: 20)
        source.clock = clock
        source.readCost = 1
        let (core, _) = try makeCore([source], gateway: session)

        _ = await core.sync(sourceId: source.id, budget: .seconds(100, clock: clock))
        let readBefore = source.pagesRead.count
        XCTAssertGreaterThan(readBefore, 0)

        session.ingestCost = 1
        _ = await core.sync(sourceId: source.id, budget: .seconds(25, clock: clock))
        XCTAssertGreaterThan(source.pagesRead.count, readBefore, "a normal background wake still reads after one slow upload")
        XCTAssertEqual(session.deliveredCount, source.pagesRead.count * 4)
    }

    actor LifecycleLog {
        private(set) var events: [CollectorCore.Lifecycle] = []
        func record(_ event: CollectorCore.Lifecycle) {
            events.append(event)
        }
    }

    func testAWakeTooShortToReadReportsIdleNotCompleted() async throws {
        let clock = FakeClock()
        defer { clock.releaseAll() }
        let log = LifecycleLog()
        let source = PagedSource(pageCount: 3)
        let (core, _) = try makeCore([source], gateway: FakeGateway(), onLifecycle: { await log.record($0) })

        _ = await core.sync(sourceId: source.id, budget: .seconds(3, clock: clock))

        XCTAssertTrue(source.pagesRead.isEmpty)
        let events = await log.events
        XCTAssertTrue(events.contains(.idle(sourceId: source.id, displayName: source.displayName)), "\(events)")
        XCTAssertFalse(events.contains { if case .completed = $0 { true } else { false } }, "no sync happened")
    }

    // MARK: - Backpressure

    func testAGatewayThatCannotTakeUploadsSlowsReadingInsteadOfDroppingPages() async throws {
        let session = FakeGateway()
        session.answer = { _ in .unavailable }
        let source = PagedSource(pageCount: 40)
        let config = OfflineBuffer.Config(maxSizeBytes: 8000, warningSizeBytes: 4000, maxSourceShareBytes: 3000)
        let (core, buffer) = try makeCore([source], gateway: session, bufferConfig: config)

        _ = await core.sync(sourceId: source.id)

        let queued = try await buffer.count()
        XCTAssertGreaterThan(queued, 0)
        XCTAssertLessThan(source.pagesRead.count, 40, "reading stopped once the source's share was full")
        let kept = try XCTUnwrap(savedPage(session.savedCursors.last))
        XCTAssertEqual(kept, queued, "the cursor stops at the last page the buffer kept")
        let bytes = try await buffer.queuedBytes(forSourceId: source.id)
        XCTAssertLessThanOrEqual(bytes, 3000)

        // The gateway recovers: everything arrives, exactly once.
        session.answer = { _ in .accept }
        for _ in 0 ..< 40 where session.deliveredCount < 160 {
            _ = await core.sync(sourceId: source.id)
        }
        XCTAssertEqual(session.deliveredCount, 160)
        XCTAssertEqual(Set(session.ingestedIds).count, 160, "no page was lost or sent twice")
    }

    func testOneSourceThatCannotDeliverDoesNotStarveAnother() async throws {
        let session = FakeGateway()
        session.answer = { $0 == "stuck:a" ? .unavailable : .accept }
        let stuck = PagedSource(id: "stuck:a", pageCount: 40)
        let healthy = PagedSource(id: "healthy:b", pageCount: 10)
        let config = OfflineBuffer.Config(maxSizeBytes: 6000, warningSizeBytes: 3000, maxSourceShareBytes: 3000)
        let (core, _) = try makeCore([stuck, healthy], gateway: session, bufferConfig: config)

        _ = await core.syncAll()

        XCTAssertEqual(healthy.pagesRead.count, 10)
        XCTAssertEqual(session.ingestedIds.filter { $0.hasPrefix("healthy:b") }.count, 40)
    }

    func testAnUploadCutOffInTransitIsRetriedNotQuarantined() async throws {
        let session = FakeGateway()
        session.answer = { _ in .cutOff }
        let source = PagedSource(pageCount: 1)
        let config = OfflineBuffer.Config(
            maxSizeBytes: 100_000,
            warningSizeBytes: 50000,
            quarantineAfterAttempts: 1,
            quarantineGrace: 0
        )
        let (core, buffer) = try makeCore([source], gateway: session, bufferConfig: config)

        for _ in 0 ..< 3 {
            _ = await core.drainPending()
            _ = await core.sync(sourceId: source.id)
        }
        let quarantined = try await buffer.quarantinedCount()
        XCTAssertEqual(quarantined, 0, "an interrupted upload is not a verdict on the batch")
        let queued = try await buffer.count()
        XCTAssertEqual(queued, 1)

        session.answer = { _ in .accept }
        _ = await core.drainPending()
        XCTAssertEqual(session.deliveredCount, 4)
    }
}

#if canImport(HealthKit)
import HealthKit

@available(iOS 17.0, macOS 14.0, *)
extension CollectorWakeTests {
    /// A short wake after a fresh pairing: what reaches the gateway is every
    /// type's last day, not one type's oldest history.
    func testAShortWakeAfterPairingDeliversEveryTypesRecentSamplesFirst() async throws {
        let clock = FakeClock()
        defer { clock.releaseAll() }
        let now = clock.now()
        let store = FakeHealthStore()
        store.onRead = { clock.advance(by: 1) }
        var recent: Set<String> = []
        for type in [FakeHealthStore.heartRate, FakeHealthStore.stepCount] {
            for index in 0 ..< 200 {
                store.add(type, start: now.addingTimeInterval(-Double(800 - index) * 86400))
            }
        }
        for type in [FakeHealthStore.heartRate, FakeHealthStore.stepCount] {
            for hour in 1 ... 3 {
                recent.insert(store.add(type, start: now.addingTimeInterval(-Double(hour) * 3600)).uuid.uuidString)
            }
        }
        let source = AppleHealthSource(
            client: store,
            catalog: TypeCatalog.entries([FakeHealthStore.heartRate, FakeHealthStore.stepCount]),
            pageLimit: 10,
            now: { now }
        )
        let session = FakeGateway()
        session.clock = clock
        session.ingestCost = 1
        let (core, _) = try makeCore([source], gateway: session)

        _ = await core.sync(sourceId: source.id, budget: .seconds(12, clock: clock))

        let delivered = Set(session.ingestedIds)
        XCTAssertTrue(recent.isSubset(of: delivered), "both types' last day arrived within one short wake")
        XCTAssertLessThan(delivered.count, 400, "and the wake did not get through the history")
    }
}
#endif
