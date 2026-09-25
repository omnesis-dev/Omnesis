// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class CollectorCoreTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-collector-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    // MARK: - Mock source that replays canned pages

    final class MockSource: OmnesisSource, @unchecked Sendable {
        let id: String
        let displayName: String
        let analyticsSchemas: [AnalyticsTableSchema]
        let multiDeviceMode: SourceMultiDeviceMode
        private let pages: [SyncResult]
        private var index = 0
        private let lock = NSLock()
        private(set) var callCount = 0
        private(set) var cursorsReceived: [SyncCursor?] = []
        private(set) var acknowledgmentCount = 0
        var failAcknowledgment = false
        var preparationCount = 0

        init(
            id: String = "mock:ios-a",
            multiDeviceMode: SourceMultiDeviceMode = .exclusive,
            pages: [SyncResult]
        ) {
            self.id = id
            self.displayName = "Mock"
            self.analyticsSchemas = []
            self.multiDeviceMode = multiDeviceMode
            self.pages = pages
        }

        func sync(cursor: SyncCursor?) async throws -> SyncResult {
            lock.lock()
            defer { lock.unlock() }
            callCount += 1
            cursorsReceived.append(cursor)
            guard index < pages.count else {
                return SyncResult(
                    records: [], tableName: "empty",
                    schema: nil, cursor: cursor ?? [:], hasMore: false
                )
            }
            let page = pages[index]
            index += 1
            return page
        }

        func didBuffer(_: SyncResult) async throws {
            acknowledgmentCount += 1
            if failAcknowledgment { throw CocoaError(.fileWriteOutOfSpace) }
        }
    }

    actor SyncGate {
        private var started = false
        private var startWaiters: [CheckedContinuation<Void, Never>] = []
        private var releaseWaiter: CheckedContinuation<Void, Never>?

        func block() async {
            started = true
            startWaiters.forEach { $0.resume() }
            startWaiters.removeAll()
            await withCheckedContinuation { releaseWaiter = $0 }
        }

        func waitUntilStarted() async {
            guard !started else { return }
            await withCheckedContinuation { startWaiters.append($0) }
        }

        func release() {
            releaseWaiter?.resume()
            releaseWaiter = nil
        }
    }

    final class BlockingSource: OmnesisSource, Sendable {
        let id = "mock:overlap"
        let displayName = "Mock"
        let analyticsSchemas: [AnalyticsTableSchema] = []
        let multiDeviceMode: SourceMultiDeviceMode = .exclusive
        let gate: SyncGate

        init(gate: SyncGate) {
            self.gate = gate
        }

        func sync(cursor: SyncCursor?) async throws -> SyncResult {
            await gate.block()
            return SyncResult(records: [], tableName: nil, cursor: cursor ?? [:], hasMore: false)
        }
    }

    actor RerunProbe {
        private var calls = 0
        private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
        private var firstRelease: CheckedContinuation<Void, Never>?

        func enter() async {
            calls += 1
            let ready = waiters.filter { $0.0 <= calls }
            waiters.removeAll { $0.0 <= calls }
            ready.forEach { $0.1.resume() }
            if calls == 1 {
                await withCheckedContinuation { firstRelease = $0 }
            }
        }

        func wait(for target: Int) async {
            guard calls < target else { return }
            await withCheckedContinuation { waiters.append((target, $0)) }
        }

        func releaseFirst() {
            firstRelease?.resume()
            firstRelease = nil
        }

        var callCount: Int {
            calls
        }
    }

    final class RerunSource: OmnesisSource, Sendable {
        let id = "mock:rerun"
        let displayName = "Mock"
        let analyticsSchemas: [AnalyticsTableSchema] = []
        let multiDeviceMode: SourceMultiDeviceMode = .exclusive
        let probe: RerunProbe

        init(probe: RerunProbe) {
            self.probe = probe
        }

        func sync(cursor: SyncCursor?) async throws -> SyncResult {
            await probe.enter()
            return SyncResult(records: [], tableName: nil, cursor: cursor ?? [:], hasMore: false)
        }
    }

    final class CancelledSource: OmnesisSource, Sendable {
        let id = "mock:cancelled"
        let displayName = "Mock"
        let analyticsSchemas: [AnalyticsTableSchema] = []
        let multiDeviceMode: SourceMultiDeviceMode = .exclusive

        func sync(cursor: SyncCursor?) async throws -> SyncResult {
            throw NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
        }
    }

    // MARK: - Mock session that records /analytics/ingest + /sync-state calls

    final class MockSession: URLSessionLike, @unchecked Sendable {
        struct Call { let url: String
            let method: String
            let body: Data?
        }

        private let lock = NSLock()
        private(set) var calls: [Call] = []

        var responder: ((URLRequest) throws -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            lock.lock()
            calls.append(Call(
                url: request.url?.absoluteString ?? "",
                method: request.httpMethod ?? "",
                body: request.httpBody
            ))
            lock.unlock()
            guard let responder else {
                throw GatewayClient.Error.invalidResponse
            }
            return try responder(request)
        }
    }

    private func okResponse(body: String, url: URL) -> (Data, URLResponse) {
        let http = HTTPURLResponse(
            url: url, statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(body.utf8), http)
    }

    private func notFoundResponse(url: URL) -> (Data, URLResponse) {
        let http = HTTPURLResponse(
            url: url, statusCode: 404,
            httpVersion: "HTTP/1.1",
            headerFields: [:]
        )!
        return (Data(), http)
    }

    // MARK: - Tests

    func testBufferFailureDoesNotAcknowledgeOrAdvanceCursor() async throws {
        // A file where the queue directory should be makes durable enqueue
        // fail deterministically, without relying on device disk pressure.
        try Data("occupied".utf8).write(to: directory)
        let session = MockSession()
        session.responder = { [weak self] request in
            guard let self else { return (Data(), URLResponse()) }
            return notFoundResponse(url: request.url!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test-token", session: session
        )
        let source = MockSource(pages: [SyncResult(
            records: [["id": .string("sample")]], tableName: "samples", cursor: ["page": .int(1)], hasMore: false
        )])
        let buffer = OfflineBuffer(directory: directory)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source]
        )
        let result = await core.sync(sourceId: source.id)
        XCTAssertNotNil(result?.error)
        XCTAssertEqual(source.callCount, 1)
        XCTAssertEqual(source.acknowledgmentCount, 0)
        XCTAssertFalse(session.calls.contains { $0.method == "POST" && $0.url.contains("/sync-state/") })
    }

    func testAcknowledgmentFailureKeepsDurablePayloadAndCursorForRetry() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            guard let self else { return (Data(), URLResponse()) }
            if request.httpMethod == "GET" { return notFoundResponse(url: request.url!) }
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test-token", session: session
        )
        let source = MockSource(pages: [SyncResult(
            records: [["id": .string("sample")]], tableName: "samples", cursor: ["page": .int(1)], hasMore: false
        )])
        source.failAcknowledgment = true
        let buffer = OfflineBuffer(directory: directory)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source]
        )
        let result = await core.sync(sourceId: source.id)
        XCTAssertNotNil(result?.error)
        XCTAssertEqual(source.acknowledgmentCount, 1)
        let queued = try await buffer.count()
        XCTAssertEqual(queued, 1)
        XCTAssertFalse(session.calls.contains { $0.method == "POST" && $0.url.contains("/sync-state/") })
    }

    func testPreparationFailureDoesNotReadCursorOrSourceOrQueueData() async throws {
        let session = MockSession()
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")),
            token: "test-token",
            session: session
        )
        let source = MockSource(multiDeviceMode: .partitioned, pages: [])
        let buffer = OfflineBuffer(directory: directory)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source],
            prepareSource: { _, _ in throw URLError(.cannotConnectToHost) }
        )
        let result = await core.sync(sourceId: source.id)
        XCTAssertNotNil(result?.error)
        XCTAssertEqual(source.callCount, 0)
        XCTAssertTrue(session.calls.isEmpty)
        let queued = try await buffer.count()
        XCTAssertEqual(queued, 0)
    }

    func testPreparationFinishesBeforeLoadingAdoptedCursor() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            guard let self else { return (Data(), URLResponse()) }
            if request.httpMethod == "GET" {
                return okResponse(body: "{\"cursor\":{\"phase\":\"backfill\"}}", url: request.url!)
            }
            return okResponse(body: "{\"ok\":true}", url: request.url!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")),
            token: "test-token",
            session: session
        )
        let source = MockSource(multiDeviceMode: .partitioned, pages: [])
        let buffer = OfflineBuffer(directory: directory)
        let gate = SyncGate()
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source],
            prepareSource: { id, mode in
                XCTAssertEqual(id, source.id)
                XCTAssertEqual(mode, .partitioned)
                await gate.block()
            }
        )
        let pending = Task { await core.sync(sourceId: source.id) }
        await gate.waitUntilStarted()
        XCTAssertTrue(session.calls.isEmpty)
        XCTAssertEqual(source.callCount, 0)
        await gate.release()
        let result = await pending.value
        XCTAssertNil(result?.error)
        XCTAssertEqual(try XCTUnwrap(source.cursorsReceived.first), ["phase": .string("backfill")])
    }

    func testOverlappingSyncQueuesOneFollowUpPass() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return (Data(), URLResponse()) }
            if req.url?.path.hasPrefix("/sync-state/") == true, req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            return okResponse(body: "{\"ok\":true}", url: req.url!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let probe = RerunProbe()
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [RerunSource(probe: probe)]
        )

        let inFlight = Task { await core.sync(sourceId: "mock:rerun") }
        await probe.wait(for: 1)
        let overlap = await core.sync(sourceId: "mock:rerun")
        _ = await core.sync(sourceId: "mock:rerun")
        _ = await core.sync(sourceId: "mock:rerun")

        XCTAssertNil(overlap?.error, "an already-running sync must not become a user-facing failure")
        XCTAssertEqual(overlap?.records, 0)

        await probe.releaseFirst()
        let firstResult = await inFlight.value
        XCTAssertNil(firstResult?.error)
        for _ in 0 ..< 100 where await probe.callCount < 2 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        await core.retireAndWait()
        let callCount = await probe.callCount
        XCTAssertEqual(callCount, 2, "overlapping wakes must coalesce into one follow-up pass")
    }

    func testCancelledSyncDropsItsQueuedFollowUpPass() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return (Data(), URLResponse()) }
            if req.url?.path.hasPrefix("/sync-state/") == true, req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            return okResponse(body: "{\"ok\":true}", url: req.url!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")),
            token: "test-token",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let probe = RerunProbe()
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [RerunSource(probe: probe)]
        )

        let inFlight = Task { await core.sync(sourceId: "mock:rerun") }
        await probe.wait(for: 1)
        _ = await core.sync(sourceId: "mock:rerun")
        inFlight.cancel()
        await probe.releaseFirst()
        _ = await inFlight.value
        try await Task.sleep(nanoseconds: 50_000_000)
        await core.retireAndWait()

        let callCount = await probe.callCount
        XCTAssertEqual(callCount, 1, "expiration must not launch fresh work after cancellation")
    }

    func testFullSyncCycleBuffersAndUploads() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            if path.hasPrefix("/sync-state/"), req.httpMethod == "POST" {
                return okResponse(body: "{\"ok\":true}", url: req.url!)
            }
            if path == "/analytics/ingest" {
                return okResponse(body: "{\"ingested\":2}", url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        // Three pages: two with records, one empty closer.
        let pages = [
            SyncResult(
                records: [
                    ["id": .string("r1"), "value": .double(1)],
                    ["id": .string("r2"), "value": .double(2)],
                ],
                tableName: "health_body",
                schema: AnalyticsTableSchema(
                    tableName: "health_body",
                    displayName: "Body",
                    description: "",
                    columns: [
                        ColumnDefinition(name: "id", type: .varchar, description: ""),
                        ColumnDefinition(name: "value", type: .double, description: ""),
                    ],
                    primaryKey: ["id"]
                ),
                cursor: ["anchor": .string("a1")],
                hasMore: true
            ),
            SyncResult(
                records: [["id": .string("r3"), "value": .double(3)]],
                tableName: "health_body",
                schema: nil,
                cursor: ["anchor": .string("a2")],
                hasMore: true
            ),
            SyncResult(
                records: [],
                tableName: "health_body",
                schema: nil,
                cursor: ["anchor": .string("a3")],
                hasMore: false
            ),
        ]
        let source = MockSource(pages: pages)

        let core = CollectorCore(gateway: gateway, buffer: buffer, cursorStore: cursorStore, uploader: uploader, sources: [source])
        let summaries = await core.syncAll()

        XCTAssertEqual(summaries.count, 1)
        let summary = summaries[0]
        XCTAssertEqual(summary.sourceId, "mock:ios-a")
        XCTAssertEqual(summary.batches, 2, "Expected 2 non-empty pages to buffer")
        XCTAssertEqual(summary.records, 3, "Expected 3 records produced")
        XCTAssertEqual(summary.uploaded, 2, "Expected 2 batches uploaded")
        XCTAssertEqual(summary.remaining, 0)
        XCTAssertNil(summary.error)

        // Source called 3 times (hasMore chain).
        XCTAssertEqual(source.callCount, 3)

        // First call had nil cursor; subsequent calls had the prior result's cursor.
        XCTAssertNil(source.cursorsReceived[0])
        XCTAssertEqual(source.cursorsReceived[1]?["anchor"], .string("a1"))
        XCTAssertEqual(source.cursorsReceived[2]?["anchor"], .string("a2"))

        // Session calls: 1x GET /sync-state (load), 3x POST /sync-state (per page),
        // 2x POST /analytics/ingest (one per non-empty page).
        let ingests = session.calls.filter { $0.url.contains("/analytics/ingest") }
        XCTAssertEqual(ingests.count, 2)
        let cursorPosts = session.calls.filter {
            $0.url.contains("/sync-state/") && $0.method == "POST"
        }
        XCTAssertEqual(cursorPosts.count, 3)
    }

    func testReplicatedSourceClaimsLeaseImmediatelyBeforeDrain() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return (Data(), URLResponse()) }
            let path = req.url?.path ?? ""
            if path.hasSuffix("/lease") {
                return okResponse(
                    body: "{\"granted\":true,\"holder\":\"phone-a\",\"expiresAt\":1234}",
                    url: req.url!
                )
            }
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            if path == "/analytics/ingest" {
                return okResponse(body: "{\"ingested\":1}", url: req.url!)
            }
            return okResponse(body: "{\"ok\":true}", url: req.url!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let source = MockSource(
            id: "apple-health:local",
            multiDeviceMode: .replicated,
            pages: [SyncResult(
                records: [["id": .string("sample-1")]],
                tableName: "health_body",
                cursor: ["anchor": .string("a1")],
                hasMore: false,
                deletedIds: ["sample-removed"]
            )]
        )
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source]
        )

        let summary = await core.syncAll().first

        XCTAssertEqual(summary?.uploaded, 1)
        let leaseIndex = try XCTUnwrap(session.calls.firstIndex { $0.url.hasSuffix("/lease") })
        let ingestIndex = try XCTUnwrap(session.calls.firstIndex { $0.url.hasSuffix("/analytics/ingest") })
        XCTAssertLessThan(leaseIndex, ingestIndex)
        let releaseIndex = try XCTUnwrap(session.calls.lastIndex { $0.url.hasSuffix("/lease") })
        XCTAssertGreaterThan(releaseIndex, ingestIndex)
    }

    func testBufferDrainsAcrossRetries() async throws {
        // First ingest attempt fails transient; second succeeds.
        let session = MockSession()
        var ingestCalls = 0
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path == "/analytics/ingest" {
                ingestCalls += 1
                if ingestCalls == 1 {
                    // Simulate transient server error.
                    let http = HTTPURLResponse(
                        url: req.url!, statusCode: 500,
                        httpVersion: "HTTP/1.1", headerFields: [:]
                    )!
                    return (Data("boom".utf8), http)
                }
                return okResponse(body: "{\"ingested\":1}", url: req.url!)
            }
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)
        let source = MockSource(pages: [
            SyncResult(
                records: [["id": .string("r1"), "value": .double(1)]],
                tableName: "health_body",
                schema: nil,
                cursor: ["anchor": .string("a1")],
                hasMore: false
            ),
        ])
        let core = CollectorCore(gateway: gateway, buffer: buffer, cursorStore: cursorStore, uploader: uploader, sources: [source])

        // First syncAll triggers page, batch queued, drain fails transient.
        let first = await core.syncAll()
        XCTAssertEqual(first[0].batches, 1)
        XCTAssertEqual(first[0].uploaded, 0, "First drain failed transient")
        XCTAssertEqual(first[0].remaining, 1, "Batch still in buffer")

        // Explicit drain retries — succeeds this time.
        let stats = await core.drainPending()
        XCTAssertEqual(stats?.uploaded, 1)
        XCTAssertEqual(stats?.remaining, 0)
    }

    func testUnauthorizedPropagatesFromUploader() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path == "/analytics/ingest" {
                let http = HTTPURLResponse(
                    url: req.url!, statusCode: 401,
                    httpVersion: "HTTP/1.1", headerFields: [:]
                )!
                return (Data("unauthorized".utf8), http)
            }
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)
        let source = MockSource(pages: [
            SyncResult(
                records: [["id": .string("r1")]],
                tableName: "health_body",
                schema: nil,
                cursor: [:],
                hasMore: false
            ),
        ])
        let core = CollectorCore(gateway: gateway, buffer: buffer, cursorStore: cursorStore, uploader: uploader, sources: [source])

        let summaries = await core.syncAll()
        // Source still succeeded, but the drain hit 401 — no uploads.
        XCTAssertEqual(summaries[0].batches, 1)
        XCTAssertEqual(summaries[0].uploaded, 0)
        XCTAssertEqual(summaries[0].remaining, 1)
    }

    func testEmptyCycleIsNoOp() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)
        let source = MockSource(pages: [
            SyncResult(
                records: [], tableName: "health_body", schema: nil,
                cursor: [:], hasMore: false
            ),
        ])
        let core = CollectorCore(gateway: gateway, buffer: buffer, cursorStore: cursorStore, uploader: uploader, sources: [source])
        let summaries = await core.syncAll()
        XCTAssertEqual(summaries[0].batches, 0)
        XCTAssertEqual(summaries[0].uploaded, 0)
        XCTAssertEqual(summaries[0].remaining, 0)
        XCTAssertNil(summaries[0].error)
    }

    // MARK: - Documents channel

    private func sampleDocument(_ externalId: String) -> DocumentInput {
        let content = "Morning Run — 9.2 km, 612 kcal, 48 min"
        return DocumentInput(
            providerId: "apple-health:local",
            sourceId: "apple-health:local",
            externalId: externalId,
            title: "Morning Run",
            content: content,
            contentHash: DocumentInput.computeContentHash(content),
            metadata: DocumentMetadata(documentType: "activity", tags: ["workout", "running"]),
            sourceCreatedAt: "2026-04-18T07:00:00.000Z",
            sourceUpdatedAt: "2026-04-18T07:48:00.000Z"
        )
    }

    /// A page carrying both records and documents must POST the analytics
    /// records to `/analytics/ingest` AND the documents to `/documents`.
    func testDocumentsFlowThroughBufferToGateway() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            if path == "/analytics/ingest" {
                return okResponse(body: "{\"ingested\":1}", url: req.url!)
            }
            if path == "/documents" {
                return okResponse(body: "{\"ingested\":1}", url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let source = MockSource(pages: [
            SyncResult(
                records: [["id": .string("workout-1")]],
                tableName: "health_workouts",
                schema: nil,
                cursor: ["anchor": .string("a1")],
                hasMore: false,
                documents: [sampleDocument("workout-1")]
            ),
        ])
        let core = CollectorCore(gateway: gateway, buffer: buffer, cursorStore: cursorStore, uploader: uploader, sources: [source])

        let summaries = await core.syncAll()
        XCTAssertEqual(summaries[0].batches, 1)
        XCTAssertEqual(summaries[0].uploaded, 1)
        XCTAssertEqual(summaries[0].remaining, 0)
        XCTAssertNil(summaries[0].error)

        let ingests = session.calls.filter { $0.url.contains("/analytics/ingest") }
        XCTAssertEqual(ingests.count, 1, "records POSTed once")
        let docPosts = session.calls.filter { $0.url.hasSuffix("/documents") && $0.method == "POST" }
        XCTAssertEqual(docPosts.count, 1, "documents POSTed once")

        // The /documents body carries our bound document verbatim.
        let body = try XCTUnwrap(docPosts.first?.body)
        let decoded = try JSONDecoder().decode(DocumentIngestRequest.self, from: body)
        XCTAssertEqual(decoded.documents.count, 1)
        XCTAssertEqual(decoded.documents.first?.externalId, "workout-1")
        XCTAssertEqual(decoded.documents.first?.metadata.documentType, "activity")
    }

    /// A page with documents but no analytics records (defensive: shouldn't
    /// happen for Apple Health, but the channel must not drop documents)
    /// still buffers and pushes the documents, and skips the empty
    /// `/analytics/ingest`.
    func testDocumentsOnlyPageStillBuffersAndPushes() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            if path == "/documents" {
                return okResponse(body: "{\"ingested\":1}", url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let source = MockSource(pages: [
            SyncResult(
                records: [],
                tableName: "health_workouts",
                schema: nil,
                cursor: [:],
                hasMore: false,
                documents: [sampleDocument("workout-2")]
            ),
        ])
        let core = CollectorCore(gateway: gateway, buffer: buffer, cursorStore: cursorStore, uploader: uploader, sources: [source])

        let summaries = await core.syncAll()
        XCTAssertEqual(summaries[0].batches, 1, "a documents-only page must still buffer")
        XCTAssertEqual(summaries[0].uploaded, 1)
        XCTAssertEqual(summaries[0].remaining, 0)

        let docPosts = session.calls.filter { $0.url.hasSuffix("/documents") && $0.method == "POST" }
        XCTAssertEqual(docPosts.count, 1)
        let ingests = session.calls.filter { $0.url.contains("/analytics/ingest") }
        XCTAssertTrue(ingests.isEmpty, "no records → no /analytics/ingest call")
    }

    /// A documents-only source (`tableName == nil`, e.g. Photos) never
    /// calls `/analytics/ingest` — there is no analytics table to post to.
    func testNilTableNameSourceSkipsAnalyticsIngest() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            if path == "/documents" {
                return okResponse(body: "{\"ingested\":1}", url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let source = MockSource(pages: [
            SyncResult(
                records: [],
                tableName: nil,
                schema: nil,
                cursor: [:],
                hasMore: false,
                documents: [sampleDocument("photo-1")]
            ),
        ])
        let core = CollectorCore(gateway: gateway, buffer: buffer, cursorStore: cursorStore, uploader: uploader, sources: [source])

        let summaries = await core.syncAll()
        XCTAssertEqual(summaries[0].batches, 1)
        XCTAssertEqual(summaries[0].uploaded, 1)
        XCTAssertNil(summaries[0].error)

        let ingests = session.calls.filter { $0.url.contains("/analytics/ingest") }
        XCTAssertTrue(ingests.isEmpty, "a documents-only source must never call /analytics/ingest")
        let docPosts = session.calls.filter { $0.url.hasSuffix("/documents") && $0.method == "POST" }
        XCTAssertEqual(docPosts.count, 1)
    }

    /// A documents-only source's `deletedIds` are document external ids,
    /// routed to `POST /documents/delete` — never `/analytics/ingest`.
    func testNilTableNameSourceRoutesDeletedIdsToDocumentDelete() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            if path == "/documents/delete" {
                return okResponse(body: "{\"deleted\":2}", url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let source = MockSource(pages: [
            SyncResult(
                records: [],
                tableName: nil,
                schema: nil,
                cursor: [:],
                hasMore: false,
                deletedIds: ["photo-removed-1", "photo-removed-2"]
            ),
        ])
        let core = CollectorCore(gateway: gateway, buffer: buffer, cursorStore: cursorStore, uploader: uploader, sources: [source])

        let summaries = await core.syncAll()
        XCTAssertEqual(summaries[0].uploaded, 1)
        XCTAssertNil(summaries[0].error)

        let ingests = session.calls.filter { $0.url.contains("/analytics/ingest") }
        XCTAssertTrue(ingests.isEmpty)
        let deletePosts = session.calls.filter { $0.url.hasSuffix("/documents/delete") && $0.method == "POST" }
        XCTAssertEqual(deletePosts.count, 1)
        let body = try XCTUnwrap(deletePosts.first?.body)
        let decoded = try JSONDecoder().decode(DeleteDocumentsRequest.self, from: body)
        XCTAssertEqual(decoded.externalIds, ["photo-removed-1", "photo-removed-2"])
    }

    /// A structured source's deletedIds must stay on the analytics ingest so
    /// its DuckDB rows (and deterministic projections) are tombstoned.
    func testStructuredSourceForwardsDeletedIdsToAnalyticsIngest() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            if path.hasSuffix("/lease"), req.httpMethod == "POST" {
                return okResponse(
                    body: "{\"granted\":true,\"holder\":\"phone-a\",\"expiresAt\":1234}",
                    url: req.url!
                )
            }
            if path == "/analytics/ingest" {
                return okResponse(body: "{\"ingested\":0}", url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)
        let source = MockSource(pages: [
            SyncResult(
                records: [],
                tableName: "location_visits",
                schema: nil,
                cursor: [:],
                hasMore: false,
                deletedIds: ["visit-removed"]
            ),
        ])

        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: cursorStore,
            uploader: uploader,
            sources: [source]
        )
        let summaries = await core.syncAll()
        XCTAssertEqual(try XCTUnwrap(summaries.first).uploaded, 1)

        let ingests = session.calls.filter { $0.url.contains("/analytics/ingest") }
        XCTAssertEqual(ingests.count, 1)
        let body = try XCTUnwrap(ingests[0].body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["deletedIds"] as? [String], ["visit-removed"])
    }

    /// A deletion-only batch (documents-only source, no new documents this
    /// cycle) has no other call site that would surface a removed/paused
    /// rejection — `/documents/delete`'s own `rejected` field must be
    /// checked, or a paused source's buffered deletions would apply anyway.
    func testPausedRejectionOnDeleteOnlyBatchIsRetainedAndReported() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return self!.okResponse(body: "", url: req.url!) }
            let path = req.url?.path ?? ""
            if path.hasPrefix("/sync-state/"), req.httpMethod == "GET" {
                return notFoundResponse(url: req.url!)
            }
            if path == "/documents/delete" {
                return okResponse(
                    body: "{\"deleted\":0,\"rejected\":[{\"sourceId\":\"photos:local\",\"reason\":\"paused\"}]}",
                    url: req.url!
                )
            }
            return okResponse(body: "{}", url: req.url!)
        }

        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let source = MockSource(id: "photos:local", pages: [
            SyncResult(
                records: [],
                tableName: nil,
                schema: nil,
                cursor: [:],
                hasMore: false,
                deletedIds: ["photo-removed-1"]
            ),
        ])
        let core = CollectorCore(gateway: gateway, buffer: buffer, cursorStore: cursorStore, uploader: uploader, sources: [source])

        let summaries = await core.syncAll()
        XCTAssertEqual(summaries[0].uploaded, 0, "a rejected batch is not an upload")
        XCTAssertEqual(summaries[0].remaining, 1, "a paused source's batch is retained for delivery on resume")
    }

    /// Documents survive being written to and read back from the offline
    /// buffer on disk (the buffer is the offline + retry durability layer).
    func testDocumentsRoundTripThroughOfflineBuffer() async throws {
        let buffer = OfflineBuffer(directory: directory)
        let batch = Batch(
            id: Batch.makeId(),
            sourceId: "apple-health:local",
            tableName: "health_workouts",
            records: [["id": .string("workout-3")]],
            schema: nil,
            deletedIds: [],
            documents: [sampleDocument("workout-3")],
            createdAt: Date()
        )
        try await buffer.enqueue(batch)

        // A fresh instance reads the same directory off disk.
        let reloaded = OfflineBuffer(directory: directory)
        let peeked = try await reloaded.peekOldest()
        XCTAssertEqual(peeked?.documents.count, 1)
        XCTAssertEqual(peeked?.documents.first?.externalId, "workout-3")
        XCTAssertEqual(peeked?.documents.first?.title, "Morning Run")
    }

    /// `onProgress` must fire at cycle start (records=0, pages=0), after
    /// each page, and a final `nil` when the whole syncAll cycle ends.
    /// The UI relies on this ordering to morph between active/idle states.
    func testOnProgressEmitsPerPageAndNilAtEnd() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in self!.okResponse(body: "{\"ingested\":0}", url: req.url!) }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let pages: [SyncResult] = [
            SyncResult(
                records: [["id": .string("r1")]],
                tableName: "health_body", schema: nil,
                cursor: ["a": .string("1")], hasMore: true
            ),
            SyncResult(
                records: [["id": .string("r2")], ["id": .string("r3")]],
                tableName: "health_body", schema: nil,
                cursor: ["a": .string("2")], hasMore: false
            ),
        ]
        let source = MockSource(pages: pages)

        actor Recorder {
            var events: [CollectorCore.Progress?] = []
            func record(_ p: CollectorCore.Progress?) {
                events.append(p)
            }
        }
        let recorder = Recorder()

        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: cursorStore,
            uploader: uploader,
            sources: [source],
            onProgress: { p in await recorder.record(p) }
        )
        _ = await core.syncAll()

        let events = await recorder.events
        // Expected ordering: cycle-start (records=0, pages=0), after page 1,
        // after page 2, then a terminal nil.
        XCTAssertEqual(events.count, 4, "got \(events)")
        XCTAssertEqual(events[0]?.records, 0)
        XCTAssertEqual(events[0]?.pages, 0)
        XCTAssertEqual(events[0]?.sourceId, "mock:ios-a")
        XCTAssertEqual(events[0]?.displayName, "Mock")
        XCTAssertEqual(events[1]?.records, 1)
        XCTAssertEqual(events[1]?.pages, 1)
        XCTAssertEqual(events[2]?.records, 3)
        XCTAssertEqual(events[2]?.pages, 2)
        XCTAssertNil(events[3], "syncAll must emit a terminal nil so the UI returns to idle")
    }

    func testDocumentsOnlySourceReportsDocumentsAsProcessedItems() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in self!.okResponse(body: "{\"ingested\":0}", url: req.url!) }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let page = SyncResult(
            records: [],
            tableName: nil,
            cursor: ["page": .int(1)],
            hasMore: false,
            documents: [sampleDocument("photo-1"), sampleDocument("photo-2")]
        )

        actor Recorder {
            var progress: [CollectorCore.Progress] = []
            var completedCount: Int?
            func recordProgress(_ value: CollectorCore.Progress?) {
                if let value { progress.append(value) }
            }

            func recordLifecycle(_ event: CollectorCore.Lifecycle) {
                if case .completed(_, _, let records, _, _) = event { completedCount = records }
            }
        }
        let recorder = Recorder()
        let buffer = OfflineBuffer(directory: directory)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [MockSource(id: "photos:local", pages: [page])],
            onProgress: { await recorder.recordProgress($0) },
            onLifecycle: { await recorder.recordLifecycle($0) }
        )

        _ = await core.syncAll()

        let progress = await recorder.progress
        let completedCount = await recorder.completedCount
        XCTAssertEqual(progress.last?.records, 2)
        XCTAssertEqual(completedCount, 2)
    }

    func testCancellationDoesNotPublishSuccessfulCompletion() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return (Data(), URLResponse()) }
            if req.url?.path.hasPrefix("/sync-state/") == true {
                return notFoundResponse(url: req.url!)
            }
            return okResponse(body: "{\"ok\":true}", url: req.url!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let recorder = LifecycleRecorder()
        let buffer = OfflineBuffer(directory: directory)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [CancelledSource()],
            onLifecycle: { await recorder.record($0) }
        )

        let summary = await core.sync(sourceId: "mock:cancelled")
        let events = await recorder.events
        let lastSync = await core.lastSync(sourceId: "mock:cancelled")

        XCTAssertNil(summary?.error)
        XCTAssertNil(lastSync)
        XCTAssertEqual(events.count, 2)
        guard case .started(let sourceId, _, _) = events.first,
              case .idle(let idleSourceId, _) = events.last else {
            return XCTFail("Cancellation should end the started lifecycle in idle: \(events)")
        }
        XCTAssertEqual(sourceId, "mock:cancelled")
        XCTAssertEqual(idleSourceId, "mock:cancelled")
    }

    // MARK: - Push rejection (source removed / paused in Omnesis)

    private func enqueueHealthBatch(_ buffer: OfflineBuffer, withDocument: Bool = false) async throws {
        let batch = Batch(
            id: Batch.makeId(),
            sourceId: "apple-health:local",
            tableName: "health_activity",
            records: [["id": .string("r1"), "steps": .double(100)]],
            schema: nil,
            deletedIds: [],
            documents: withDocument ? [sampleDocument("workout-1")] : [],
            createdAt: Date()
        )
        _ = try await buffer.enqueue(batch)
    }

    private func rejectingSession(reason: String) -> MockSession {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return (Data(), URLResponse()) }
            let path = req.url?.path ?? ""
            if path == "/analytics/ingest" || path == "/documents" {
                return okResponse(
                    body: "{\"ingested\":0,\"rejected\":[{\"sourceId\":\"apple-health:local\",\"reason\":\"\(reason)\"}]}",
                    url: req.url!
                )
            }
            return okResponse(body: "{}", url: req.url!)
        }
        return session
    }

    /// A `removed` rejection discards the batch (the source is gone) and is
    /// surfaced in `Stats.rejected` so the AppStore can disable it locally.
    func testRemovedRejectionDiscardsBatchAndReports() async throws {
        let session = rejectingSession(reason: "removed")
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        try await enqueueHealthBatch(buffer)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let stats = try await uploader.drain()
        XCTAssertEqual(stats.uploaded, 0)
        XCTAssertEqual(stats.rejected, [PushRejection(sourceId: "apple-health:local", reason: "removed")])
        let remaining = try await buffer.count()
        XCTAssertEqual(remaining, 0, "a removed source's batch is discarded — nothing to deliver it to")
    }

    /// A `paused` rejection RETAINS the batch (so the data delivers when
    /// resumed) and still reports the rejection.
    func testPausedRejectionRetainsBatchAndReports() async throws {
        let session = rejectingSession(reason: "paused")
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        try await enqueueHealthBatch(buffer)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let stats = try await uploader.drain()
        XCTAssertEqual(stats.uploaded, 0)
        XCTAssertEqual(stats.rejected, [PushRejection(sourceId: "apple-health:local", reason: "paused")])
        let remaining = try await buffer.count()
        XCTAssertEqual(remaining, 1, "a paused source's batch is retained for delivery on resume")
    }

    /// CollectorCore emits a `.sourceRejected` lifecycle for each rejected
    /// source after a drain, so the AppStore can react.
    func testDrainPendingEmitsSourceRejectedLifecycle() async throws {
        let session = rejectingSession(reason: "removed")
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        try await enqueueHealthBatch(buffer)
        let cursorStore = CursorStore(gateway: gateway)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let recorder = LifecycleRecorder()
        let core = CollectorCore(
            gateway: gateway, buffer: buffer, cursorStore: cursorStore,
            uploader: uploader, sources: [],
            onLifecycle: { event in await recorder.record(event) }
        )
        _ = await core.drainPending()

        let events = await recorder.events
        XCTAssertTrue(
            events.contains(.sourceRejected(sourceId: "apple-health:local", reason: "removed")),
            "drainPending must emit .sourceRejected; got \(events)"
        )
    }

    // MARK: - 403 must not stall the queue behind it

    /// Enqueue a documents-only batch for an arbitrary source, so a test can
    /// interleave a source the gateway forbids with one it accepts. The
    /// document carries the same `sourceId` as its batch — that is what the
    /// gateway's per-source write-scope check reads off the request body.
    private func enqueueBatch(_ buffer: OfflineBuffer, sourceId: String) async throws {
        let content = "Arrived at Studio Northstar"
        let document = DocumentInput(
            providerId: sourceId,
            sourceId: sourceId,
            externalId: "doc-\(sourceId)",
            title: "Visit",
            content: content,
            contentHash: DocumentInput.computeContentHash(content),
            metadata: DocumentMetadata(documentType: "activity", tags: []),
            sourceCreatedAt: "2026-04-18T07:00:00.000Z",
            sourceUpdatedAt: "2026-04-18T07:48:00.000Z"
        )
        let batch = Batch(
            id: Batch.makeId(),
            sourceId: sourceId,
            tableName: nil,
            records: [],
            schema: nil,
            deletedIds: [],
            documents: [document],
            createdAt: Date()
        )
        _ = try await buffer.enqueue(batch)
    }

    /// 403s the named source's document pushes, accepts everything else.
    private func forbiddingSession(forSourceId forbidden: String) -> MockSession {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return (Data(), URLResponse()) }
            let path = req.url?.path ?? ""
            let body = String(data: req.httpBody ?? Data(), encoding: .utf8) ?? ""
            if path == "/documents", body.contains(forbidden) {
                let http = HTTPURLResponse(
                    url: req.url!, statusCode: 403,
                    httpVersion: "HTTP/1.1", headerFields: [:]
                )!
                return (Data("{\"error\":\"write scope required\"}".utf8), http)
            }
            if path == "/documents" || path == "/analytics/ingest" {
                return okResponse(body: "{\"ingested\":1}", url: req.url!)
            }
            return okResponse(body: "{}", url: req.url!)
        }
        return session
    }

    /// One source the gateway refuses must not strand the sources queued
    /// behind it. The buffer drains strictly FIFO, so a 403 that aborted the
    /// pass would block the whole device — silently, since sync cursors
    /// advance when a batch is written to the buffer, not when it uploads.
    func testForbiddenSourceDoesNotBlockLaterBatches() async throws {
        let session = forbiddingSession(forSourceId: "core-location-visits:local")
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        // Forbidden source FIRST — it sits at the head of the FIFO queue.
        try await enqueueBatch(buffer, sourceId: "core-location-visits:local")
        try await enqueueBatch(buffer, sourceId: "apple-health:local")
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let stats = try await uploader.drain()

        XCTAssertEqual(stats.uploaded, 1, "the healthy source must still upload")
        XCTAssertEqual(stats.blocked, ["core-location-visits:local"])
        XCTAssertEqual(stats.skipped, 1)
        let remaining = try await buffer.count()
        XCTAssertEqual(remaining, 1, "the forbidden batch stays on disk for a later retry")
    }

    /// The blocked source's data is retained, not dropped — it delivers once
    /// the gateway grants the device the matching write scope.
    func testForbiddenBatchDeliversOnceScopeIsGranted() async throws {
        let buffer = OfflineBuffer(directory: directory)
        try await enqueueBatch(buffer, sourceId: "core-location-visits:local")

        let forbidding = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test", session: forbiddingSession(forSourceId: "core-location-visits:local")
        )
        let blockedStats = try await Uploader(gateway: forbidding, buffer: buffer).drain()
        XCTAssertEqual(blockedStats.blocked, ["core-location-visits:local"])

        // Same buffer, a gateway that now accepts the source.
        let accepting = MockSession()
        accepting.responder = { [weak self] req in
            guard let self else { return (Data(), URLResponse()) }
            return okResponse(body: "{\"ingested\":1}", url: req.url!)
        }
        let granted = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test", session: accepting
        )
        let stats = try await Uploader(gateway: granted, buffer: buffer).drain()

        XCTAssertEqual(stats.uploaded, 1)
        XCTAssertEqual(stats.blocked, [])
        let remaining = try await buffer.count()
        XCTAssertEqual(remaining, 0, "the retained batch delivered once the scope landed")
    }

    /// A 401 is different in kind: the token itself is dead, so nothing in the
    /// queue can be delivered and the caller must be told to re-pair.
    func testUnauthorizedStillAbortsTheDrain() async throws {
        let session = MockSession()
        session.responder = { req in
            let http = HTTPURLResponse(
                url: req.url!, statusCode: 401,
                httpVersion: "HTTP/1.1", headerFields: [:]
            )!
            return (Data(), http)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        try await enqueueHealthBatch(buffer, withDocument: true)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        do {
            _ = try await uploader.drain()
            XCTFail("a 401 must propagate so the UI can prompt a re-pair")
        } catch GatewayClient.Error.unauthorized {
            // expected
        }
    }

    /// A second batch of an already-blocked source costs no further round
    /// trip: `push` sends analytics before documents, so re-probing would
    /// re-send analytics rows the gateway already accepted.
    func testBlockedSourceIsProbedOncePerDrain() async throws {
        let session = forbiddingSession(forSourceId: "core-location-visits:local")
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        for _ in 0 ..< 4 {
            try await enqueueBatch(buffer, sourceId: "core-location-visits:local")
        }
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        let stats = try await uploader.drain()

        XCTAssertEqual(stats.blocked, ["core-location-visits:local"])
        XCTAssertEqual(stats.skipped, 4, "every batch is skipped…")
        let documentPushes = session.calls.filter { $0.url.hasSuffix("/documents") }
        XCTAssertEqual(documentPushes.count, 1, "…but only the first one is pushed")
        let remaining = try await buffer.count()
        XCTAssertEqual(remaining, 4, "all four are retained")
    }

    /// A drain that finds another drain already in flight observed nothing,
    /// and must say so rather than reporting an empty blocked set — a caller
    /// that treats the two alike clears the warning while the source is still
    /// refused.
    func testConcurrentDrainReportsNoObservation() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { return (Data(), URLResponse()) }
            return okResponse(body: "{\"ingested\":1}", url: req.url!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")),
            token: "omn_test",
            session: session
        )
        let buffer = OfflineBuffer(directory: directory)
        let uploader = Uploader(gateway: gateway, buffer: buffer)

        async let first = uploader.drain()
        async let second = uploader.drain()
        let results = try await [first, second]

        XCTAssertEqual(
            results.filter { $0.blocked == nil }.count, 1,
            "exactly one pass is the no-op re-entrant call"
        )
        XCTAssertEqual(results.filter { $0.blocked != nil }.count, 1)
    }

    private actor LifecycleRecorder {
        private(set) var events: [CollectorCore.Lifecycle] = []
        func record(_ event: CollectorCore.Lifecycle) {
            events.append(event)
        }
    }
}

extension CollectorCoreTests {
    func testSameCoreObservesGatewayCursorResetAndPreparesOnlyOnce() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            guard let self else { return (Data(), URLResponse()) }
            if request.httpMethod == "GET" {
                return okResponse(body: "{\"cursor\":{\"page\":1}}", url: request.url!)
            }
            return okResponse(body: "{}", url: request.url!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test-token", session: session
        )
        let source = MockSource(pages: [])
        let buffer = OfflineBuffer(directory: directory)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source],
            prepareSource: { _, _ in
                source.preparationCount += 1
                if source.preparationCount > 1 { throw URLError(.notConnectedToInternet) }
            }
        )
        _ = await core.sync(sourceId: source.id)
        session.responder = { [weak self] request in
            guard let self else { return (Data(), URLResponse()) }
            if request.httpMethod == "GET" { return notFoundResponse(url: request.url!) }
            return okResponse(body: "{}", url: request.url!)
        }
        _ = await core.sync(sourceId: source.id)
        XCTAssertEqual(source.callCount, 2)
        guard source.cursorsReceived.count == 2 else { return }
        XCTAssertEqual(source.cursorsReceived[0], ["page": .int(1)])
        XCTAssertNil(source.cursorsReceived[1])
        XCTAssertEqual(source.preparationCount, 1)
    }

    func testWarmOfflineSyncStillBuffersAndFailedPreparationIsRetried() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            guard let self else { return (Data(), URLResponse()) }
            if request.httpMethod == "GET" { return notFoundResponse(url: request.url!) }
            return okResponse(body: "{}", url: request.url!)
        }
        let gateway = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test-token", session: session
        )
        let source = MockSource(pages: [
            SyncResult(records: [], tableName: nil, cursor: ["page": .int(1)], hasMore: false),
            SyncResult(records: [["id": .string("offline")]], tableName: "samples", cursor: ["page": .int(2)], hasMore: false),
        ])
        let buffer = OfflineBuffer(directory: directory)
        let core = CollectorCore(
            gateway: gateway,
            buffer: buffer,
            cursorStore: CursorStore(gateway: gateway),
            uploader: Uploader(gateway: gateway, buffer: buffer),
            sources: [source],
            prepareSource: { _, _ in
                source.preparationCount += 1
                if source.preparationCount == 1 { throw URLError(.notConnectedToInternet) }
            }
        )
        _ = await core.sync(sourceId: source.id)
        XCTAssertEqual(source.callCount, 0)
        _ = await core.sync(sourceId: source.id)
        session.responder = { _ in throw URLError(.notConnectedToInternet) }
        _ = await core.sync(sourceId: source.id)
        XCTAssertEqual(source.preparationCount, 2)
        XCTAssertEqual(source.callCount, 2)
        guard source.cursorsReceived.count == 2 else { return }
        XCTAssertEqual(source.cursorsReceived[1], ["page": .int(1)])
        let queued = try await buffer.count()
        XCTAssertEqual(queued, 1)
    }
}
