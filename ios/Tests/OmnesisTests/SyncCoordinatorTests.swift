// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

#if canImport(SwiftUI) && canImport(UIKit)
@available(iOS 17.0, *)
@MainActor
final class SyncCoordinatorTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-sync-coordinator-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testRebuildDuringDrainKeepsOneDeliveryPipelineAndClearsHealthState() async throws {
        let gate = UploadGate()
        let session = SuspendedUploadSession(gate: gate)
        let directory = try XCTUnwrap(directory)
        let coordinator = SyncCoordinator(
            bufferDirectoryProvider: { directory },
            gatewayFactory: { pairing in
                GatewayClient(baseURL: pairing.url, token: pairing.token, session: session)
            }
        )
        let pairing = Self.pairing(url: "https://gateway.example.com")
        await coordinator.rebuildCollector(pairing: pairing, sources: [])
        let firstBuffer = try XCTUnwrap(coordinator.buffer)
        let firstUploader = try XCTUnwrap(coordinator.uploader)
        try await firstBuffer.enqueue(Self.makeAgedBatch())

        let firstDrain = Task { await coordinator.drainPending() }
        await gate.waitUntilStarted()

        let replacementFinished = CompletionFlag()
        let replacement = Task {
            await coordinator.rebuildCollector(pairing: pairing, sources: [])
            await replacementFinished.mark()
        }
        await Task.yield()
        let finishedWhileDrainSuspended = await replacementFinished.value
        XCTAssertFalse(finishedWhileDrainSuspended)
        XCTAssertTrue(firstBuffer === coordinator.buffer)
        XCTAssertTrue(firstUploader === coordinator.uploader)
        let countDuringDrain = try await coordinator.buffer?.count()
        XCTAssertEqual(countDuringDrain, 1)

        await gate.release()
        let completedOutcome = await firstDrain.value
        await replacement.value
        XCTAssertEqual(completedOutcome, .delivered)
        XCTAssertEqual(coordinator.bufferedBatches, 0)
        XCTAssertNil(coordinator.oldestBufferedAge)
        let finalCount = try await coordinator.buffer?.count()
        XCTAssertEqual(finalCount, 0)
    }

    func testPairingChangeDuringDrainKeepsOneOwnerAndRoutesNextPassToNewGateway() async throws {
        let oldGate = UploadGate()
        let newGate = UploadGate(open: true)
        let oldRequests = RequestCount()
        let newRequests = RequestCount()
        let oldSession = SuspendedUploadSession(gate: oldGate, requests: oldRequests)
        let newSession = SuspendedUploadSession(gate: newGate, requests: newRequests)
        let directory = try XCTUnwrap(directory)
        let coordinator = SyncCoordinator(
            bufferDirectoryProvider: { directory },
            gatewayFactory: { pairing in
                let session = pairing.url.host == "old.example.com" ? oldSession : newSession
                return GatewayClient(baseURL: pairing.url, token: pairing.token, session: session)
            }
        )
        await coordinator.rebuildCollector(pairing: Self.pairing(url: "https://old.example.com"), sources: [])
        let firstBuffer = try XCTUnwrap(coordinator.buffer)
        let firstUploader = try XCTUnwrap(coordinator.uploader)
        try await firstBuffer.enqueue(Self.makeAgedBatch(suffix: "old"))

        let oldDrain = Task { await coordinator.drainPending() }
        await oldGate.waitUntilStarted()
        let replacementFinished = CompletionFlag()
        let replacement = Task {
            await coordinator.rebuildCollector(
                pairing: Self.pairing(url: "https://new.example.com"),
                sources: []
            )
            await replacementFinished.mark()
        }
        await Task.yield()
        let finishedWhileOldDrainSuspended = await replacementFinished.value
        XCTAssertFalse(finishedWhileOldDrainSuspended)

        XCTAssertTrue(firstBuffer === coordinator.buffer)
        XCTAssertTrue(firstUploader === coordinator.uploader)

        await oldGate.release()
        let oldOutcome = await oldDrain.value
        await replacement.value
        XCTAssertEqual(oldOutcome, .delivered)
        try await firstBuffer.enqueue(Self.makeAgedBatch(suffix: "new"))
        let newOutcome = await coordinator.drainPending()
        XCTAssertEqual(newOutcome, .delivered)
        let oldRequestCount = await oldRequests.value
        let newRequestCount = await newRequests.value
        XCTAssertEqual(oldRequestCount, 1)
        XCTAssertEqual(newRequestCount, 1)
    }

    func testBackgroundRefreshPublishesTheDrainedBufferState() async throws {
        let gate = UploadGate(open: true)
        let session = SuspendedUploadSession(gate: gate)
        let directory = try XCTUnwrap(directory)
        let coordinator = SyncCoordinator(
            bufferDirectoryProvider: { directory },
            gatewayFactory: { pairing in
                GatewayClient(baseURL: pairing.url, token: pairing.token, session: session)
            }
        )
        await coordinator.rebuildCollector(pairing: Self.pairing(url: "https://gateway.example.com"), sources: [])
        let buffer = try XCTUnwrap(coordinator.buffer)
        try await buffer.enqueue(Self.makeAgedBatch())
        await coordinator.refreshBufferCount()
        XCTAssertEqual(coordinator.bufferedBatches, 1)
        XCTAssertNotNil(coordinator.oldestBufferedAge)
        let background = try XCTUnwrap(coordinator.bgCoordinator)

        await background.performRefresh()

        XCTAssertEqual(coordinator.bufferedBatches, 0)
        XCTAssertNil(coordinator.oldestBufferedAge)
    }

    func testRetryReportsPausedBatchesThenDeliversThemAfterResume() async throws {
        let session = PausableUploadSession()
        let directory = try XCTUnwrap(directory)
        let coordinator = SyncCoordinator(
            bufferDirectoryProvider: { directory },
            gatewayFactory: { pairing in
                GatewayClient(baseURL: pairing.url, token: pairing.token, session: session)
            }
        )
        await coordinator.rebuildCollector(pairing: Self.pairing(url: "https://gateway.example.com"), sources: [])
        let buffer = try XCTUnwrap(coordinator.buffer)
        for suffix in ["one", "two", "three"] {
            try await buffer.enqueue(Self.makeAgedBatch(suffix: suffix))
        }
        await coordinator.refreshBufferCount()

        await coordinator.retryDelivery()

        XCTAssertEqual(coordinator.retryPhase, .reported(.paused))
        XCTAssertEqual(coordinator.bufferedBatches, 3)
        XCTAssertNotNil(coordinator.oldestBufferedAge)

        await session.resume()
        await coordinator.retryDelivery()

        XCTAssertEqual(coordinator.retryPhase, .reported(.delivered))
        XCTAssertEqual(coordinator.bufferedBatches, 0)
        XCTAssertNil(coordinator.oldestBufferedAge)
    }

    func testTearDownInvalidatesOldPipelineAndNewPairCannotReceiveItsWork() async throws {
        let oldRequests = RequestCount()
        let newRequests = RequestCount()
        let oldSession = SuspendedUploadSession(gate: UploadGate(open: true), requests: oldRequests)
        let newSession = SuspendedUploadSession(gate: UploadGate(open: true), requests: newRequests)
        let directory = try XCTUnwrap(directory)
        let coordinator = SyncCoordinator(
            bufferDirectoryProvider: { directory },
            gatewayFactory: { pairing in
                let session = pairing.url.host == "old.example.com" ? oldSession : newSession
                return GatewayClient(baseURL: pairing.url, token: pairing.token, session: session)
            }
        )
        await coordinator.rebuildCollector(pairing: Self.pairing(url: "https://old.example.com"), sources: [])
        let firstBuffer = try XCTUnwrap(coordinator.buffer)
        let firstUploader = try XCTUnwrap(coordinator.uploader)
        try await firstBuffer.enqueue(Self.makeAgedBatch())
        await coordinator.refreshBufferCount()
        XCTAssertEqual(coordinator.bufferedBatches, 1)

        await coordinator.tearDownCollector()
        XCTAssertNil(coordinator.buffer)
        XCTAssertEqual(coordinator.bufferedBatches, 0)
        XCTAssertNil(coordinator.oldestBufferedAge)
        do {
            try await firstBuffer.enqueue(Self.makeAgedBatch(suffix: "stale"))
            XCTFail("An invalidated buffer accepted work after teardown")
        } catch {}
        do {
            _ = try await firstBuffer.count()
            XCTFail("An invalidated buffer returned a count after teardown")
        } catch {}
        do {
            _ = try await firstBuffer.oldestBatchAge()
            XCTFail("An invalidated buffer returned an age after teardown")
        } catch {}

        await coordinator.rebuildCollector(
            pairing: Self.pairing(url: "https://new.example.com", token: "new-token"),
            sources: []
        )
        XCTAssertFalse(firstBuffer === coordinator.buffer)
        XCTAssertFalse(firstUploader === coordinator.uploader)
        let emptyOutcome = await coordinator.drainPending()
        XCTAssertEqual(emptyOutcome, .idle)
        let newBuffer = try XCTUnwrap(coordinator.buffer)
        try await newBuffer.enqueue(Self.makeAgedBatch(suffix: "new"))
        let deliveredOutcome = await coordinator.drainPending()
        XCTAssertEqual(deliveredOutcome, .delivered)
        let oldRequestCount = await oldRequests.value
        let newRequestCount = await newRequests.value
        XCTAssertEqual(oldRequestCount, 0)
        XCTAssertEqual(newRequestCount, 1)
    }

    func testCredentialChangeFailsClosedWhenOldBufferCannotBeRemoved() async throws {
        let fileManager = FailingRemovalFileManager()
        let directory = try XCTUnwrap(directory)
        let session = SuspendedUploadSession(gate: UploadGate(open: true))
        let coordinator = SyncCoordinator(
            bufferDirectoryProvider: { directory },
            bufferFileManager: fileManager,
            gatewayFactory: { pairing in
                GatewayClient(baseURL: pairing.url, token: pairing.token, session: session)
            }
        )
        var reportedError: String?
        coordinator.setOnError { reportedError = $0 }
        await coordinator.rebuildCollector(
            pairing: Self.pairing(url: "https://old.example.com", token: "old-token"),
            sources: []
        )
        let oldBuffer = try XCTUnwrap(coordinator.buffer)
        try await oldBuffer.enqueue(Self.makeAgedBatch())
        fileManager.shouldFailRemoval = true

        await coordinator.rebuildCollector(
            pairing: Self.pairing(url: "https://new.example.com", token: "new-token"),
            sources: []
        )

        XCTAssertNil(coordinator.core)
        XCTAssertNil(coordinator.buffer)
        XCTAssertNotNil(reportedError)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
    }

    func testReplacementWaitsForOldSourceToQuiesceBeforeTakingOwnership() async throws {
        let sourceGate = UploadGate()
        let oldRequests = RequestCount()
        let newRequests = RequestCount()
        let oldSession = SuspendedUploadSession(
            gate: UploadGate(open: true),
            requests: oldRequests
        )
        let newSession = SuspendedUploadSession(
            gate: UploadGate(open: true),
            requests: newRequests
        )
        let directory = try XCTUnwrap(directory)
        let coordinator = SyncCoordinator(
            bufferDirectoryProvider: { directory },
            gatewayFactory: { pairing in
                let session = pairing.token == "old-token" ? oldSession : newSession
                return GatewayClient(baseURL: pairing.url, token: pairing.token, session: session)
            }
        )
        await coordinator.rebuildCollector(
            pairing: Self.pairing(url: "https://old.example.com", token: "old-token"),
            sources: [SuspendedSource(gate: sourceGate)]
        )

        let oldSync = Task { await coordinator.syncAll() }
        await sourceGate.waitUntilStarted()
        let replacementFinished = CompletionFlag()
        let replacement = Task {
            await coordinator.rebuildCollector(
                pairing: Self.pairing(url: "https://new.example.com", token: "new-token"),
                sources: []
            )
            await replacementFinished.mark()
        }
        await Task.yield()
        let finishedWhileOldSourceSuspended = await replacementFinished.value
        XCTAssertFalse(finishedWhileOldSourceSuspended)
        await sourceGate.release()
        await replacement.value
        await oldSync.value

        let currentBuffer = try XCTUnwrap(coordinator.buffer)
        let currentCount = try await currentBuffer.count()
        let oldRequestCount = await oldRequests.value
        let newRequestCount = await newRequests.value
        XCTAssertEqual(currentCount, 0)
        XCTAssertEqual(oldRequestCount, 1)
        XCTAssertEqual(newRequestCount, 0)
    }

    func testSamePairingReplacementCannotLetObsoleteCursorOverwriteSuccessor() async throws {
        let sourceGate = UploadGate()
        let cursorWrites = CursorWrites()
        let session = SuspendedUploadSession(
            gate: UploadGate(open: true),
            cursorWrites: cursorWrites
        )
        let directory = try XCTUnwrap(directory)
        let coordinator = SyncCoordinator(
            bufferDirectoryProvider: { directory },
            gatewayFactory: { pairing in
                GatewayClient(baseURL: pairing.url, token: pairing.token, session: session)
            }
        )
        let pairing = Self.pairing(url: "https://gateway.example.com")
        await coordinator.rebuildCollector(
            pairing: pairing,
            sources: [SuspendedSource(gate: sourceGate)]
        )

        let oldSync = Task { await coordinator.syncAll() }
        await sourceGate.waitUntilStarted()
        let replacement = Task {
            await coordinator.rebuildCollector(
                pairing: pairing,
                sources: [FixedCursorSource(cursorValue: "new")]
            )
        }
        await Task.yield()
        await sourceGate.release()
        await replacement.value
        await oldSync.value

        await coordinator.syncAll()
        let writes = await cursorWrites.values
        XCTAssertEqual(writes.count, 2)
        XCTAssertTrue(writes[0].contains("old"))
        XCTAssertTrue(writes[1].contains("new"))
    }

    private static func pairing(url: String, token: String = "test-token") -> Pairing {
        Pairing(
            url: URL(string: url)!,
            token: token,
            accountId: "local",
            deviceId: "device-test",
            gatewayName: "Test Gateway"
        )
    }

    private static func makeAgedBatch(suffix: String = "sample") -> Batch {
        let createdAt = Date().addingTimeInterval(-10 * 60 * 60)
        return Batch(
            id: Batch.makeId(now: createdAt),
            sourceId: "apple-health:local",
            tableName: "health_body",
            records: [["id": .string("\(suffix)-1"), "value": .double(72)]],
            schema: nil,
            deletedIds: [],
            createdAt: createdAt
        )
    }
}

@available(iOS 17.0, *)
private actor UploadGate {
    private var isOpen: Bool
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(open: Bool = false) {
        self.isOpen = open
    }

    func suspendIfNeeded() async {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        guard !isOpen else { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilStarted() async {
        guard !started else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        isOpen = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor RequestCount {
    private(set) var value = 0

    func increment() {
        value += 1
    }
}

private actor CursorWrites {
    private(set) var values: [String] = []
    func append(_ value: String) {
        values.append(value)
    }
}

private actor CompletionFlag {
    private(set) var value = false
    func mark() {
        value = true
    }
}

private final class FailingRemovalFileManager: FileManager, @unchecked Sendable {
    var shouldFailRemoval = false

    override func removeItem(at URL: URL) throws {
        if shouldFailRemoval {
            throw CocoaError(.fileWriteNoPermission)
        }
        try super.removeItem(at: URL)
    }
}

@available(iOS 17.0, *)
private struct SuspendedSource: OmnesisSource {
    let id = "test-source:device-test"
    let displayName = "Test Source"
    let analyticsSchemas: [AnalyticsTableSchema] = []
    let gate: UploadGate

    func sync(cursor: SyncCursor?) async throws -> SyncResult {
        await gate.suspendIfNeeded()
        return SyncResult(
            records: [["id": .string("old-generation-record")]],
            tableName: "test_records",
            cursor: ["generation": .string("old")],
            hasMore: false
        )
    }
}

@available(iOS 17.0, *)
private struct FixedCursorSource: OmnesisSource {
    let id = "test-source:device-test"
    let displayName = "Test Source"
    let analyticsSchemas: [AnalyticsTableSchema] = []
    let cursorValue: String

    func sync(cursor: SyncCursor?) async throws -> SyncResult {
        SyncResult(
            records: [["id": .string("new-generation-record")]],
            tableName: "test_records",
            cursor: ["generation": .string(cursorValue)],
            hasMore: false
        )
    }
}

@available(iOS 17.0, *)
private final class SuspendedUploadSession: URLSessionLike, @unchecked Sendable {
    private let gate: UploadGate
    private let requests: RequestCount?
    private let cursorWrites: CursorWrites?

    init(
        gate: UploadGate,
        requests: RequestCount? = nil,
        cursorWrites: CursorWrites? = nil
    ) {
        self.gate = gate
        self.requests = requests
        self.cursorWrites = cursorWrites
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        if request.url?.path.hasPrefix("/sync-state/") == true,
           request.httpMethod == "POST" {
            let body = String(data: request.httpBody ?? Data(), encoding: .utf8) ?? ""
            await cursorWrites?.append(body)
        }
        if request.url?.path == "/analytics/ingest" {
            await requests?.increment()
            await gate.suspendIfNeeded()
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data("{\"ingested\":1}".utf8), response)
    }
}

@available(iOS 17.0, *)
private actor PausableUploadSession: URLSessionLike {
    private var paused = true

    func resume() {
        paused = false
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        guard request.url?.path == "/analytics/ingest" else {
            return (Data("{}".utf8), response)
        }

        let isPaused = paused
        let body = isPaused
            ? #"{"ingested":0,"rejected":[{"sourceId":"apple-health:local","reason":"paused"}]}"#
            : #"{"ingested":1,"rejected":[]}"#
        return (Data(body.utf8), response)
    }
}
#endif
