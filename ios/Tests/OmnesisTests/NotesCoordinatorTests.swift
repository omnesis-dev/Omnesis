// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Save / drain policy for quick-capture notes, driven through a mock
/// HTTP layer + a temp-dir `PendingNoteStore`. UIKit-free by design so
/// this runs in the sim-less SwiftPM logic lane.
@MainActor
final class NotesCoordinatorTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var responder: ((URLRequest) async -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            guard let responder else { throw URLError(.cannotConnectToHost) }
            return await responder(request)
        }
    }

    private actor RequestBlocker {
        private var started = false
        private var startWaiters: [CheckedContinuation<Void, Never>] = []
        private var releaseContinuation: CheckedContinuation<Void, Never>?

        func block() async {
            started = true
            startWaiters.forEach { $0.resume() }
            startWaiters.removeAll()
            await withCheckedContinuation { releaseContinuation = $0 }
        }

        func waitUntilStarted() async {
            if started { return }
            await withCheckedContinuation { startWaiters.append($0) }
        }

        func release() {
            releaseContinuation?.resume()
            releaseContinuation = nil
        }
    }

    private var directory: URL!
    private let base = URL(string: "http://gateway.local:7600")!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-notes-coord-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private func entryJSON(id: String, text: String, capturedAt: String = "2026-03-09T09:00:00.000Z") -> String {
        """
        {"id":"\(id)","day":"2026-03-09","capturedAt":"\(capturedAt)",
         "updatedAt":"\(capturedAt)","text":"\(text)","surface":"ios-app","deviceId":"dev_1"}
        """
    }

    private func ok(_ body: String, status: Int = 200, url: URL) -> (Data, URLResponse) {
        (
            Data(body.utf8),
            HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        )
    }

    /// Returns a fixed location, so a save's POST body can be asserted to
    /// carry it without touching CoreLocation.
    private struct StubLocationProvider: NoteLocationProviding {
        let location: NoteLocation?
        func current(promptIfNeeded: Bool) async -> NoteLocation? {
            location
        }
    }

    private func makeCoordinator(
        session: MockSession,
        location: NoteLocation? = nil
    )
        -> NotesCoordinator {
        let coordinator = NotesCoordinator(
            store: PendingNoteStore(directory: directory),
            locationProvider: location.map(StubLocationProvider.init)
        )
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_1", session: session)
        return coordinator
    }

    private func lastPostBody(_ session: MockSession) throws -> [String: Any] {
        let post = try XCTUnwrap(session.requests.last { $0.httpMethod == "POST" })
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(post.httpBody)) as? [String: Any]
        )
    }

    // MARK: - Save

    func testSaveDeliversWithoutQueueing() async {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { fatalError() }
            if req.httpMethod == "POST" {
                return ok(entryJSON(id: "note_1", text: "hello brain"), status: 201, url: req.url!)
            }
            return ok(#"{"day":"2026-03-09","entries":[\#(entryJSON(id: "note_1", text: "hello brain"))]}"#, url: req.url!)
        }
        let coordinator = makeCoordinator(session: session)

        let outcome = await coordinator.save(text: "  hello brain  ", surface: .app)

        XCTAssertEqual(outcome, .saved)
        XCTAssertTrue(coordinator.pending.isEmpty)
    }

    func testSaveAttachesResolvedLocationToThePost() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { fatalError() }
            if req.httpMethod == "POST" {
                return ok(entryJSON(id: "note_1", text: "geotagged"), status: 201, url: req.url!)
            }
            return ok(#"{"day":"2026-03-09","entries":[]}"#, url: req.url!)
        }
        let coordinator = makeCoordinator(
            session: session,
            location: NoteLocation(latitude: 48.8566, longitude: 2.3522, placeName: "Paris")
        )

        _ = await coordinator.save(text: "geotagged", surface: .app)

        let body = try lastPostBody(session)
        XCTAssertEqual(body["latitude"] as? Double ?? 0, 48.8566, accuracy: 0.0001)
        XCTAssertEqual(body["placeName"] as? String, "Paris")
    }

    func testSavePreservesCaptureClockSnapshottedBeforeLocationWork() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { fatalError() }
            if req.httpMethod == "POST" {
                return ok(entryJSON(id: "note_1", text: "travel note"), status: 201, url: req.url!)
            }
            return ok(#"{"day":"2026-03-09","entries":[]}"#, url: req.url!)
        }
        let coordinator = makeCoordinator(session: session, location: NoteLocation(latitude: 1, longitude: 2))
        let captureTime = NoteCaptureTime(
            capturedAt: Date(timeIntervalSince1970: 1_772_000_000),
            timeZoneId: "Asia/Tokyo",
            utcOffsetSeconds: 32400
        )

        _ = await coordinator.save(text: "travel note", surface: .app, captureTime: captureTime)

        let body = try lastPostBody(session)
        XCTAssertEqual(body["capturedAt"] as? String, NotesTime.isoString(from: captureTime.capturedAt))
        XCTAssertEqual(body["capturedTimeZoneId"] as? String, "Asia/Tokyo")
        XCTAssertEqual(body["capturedUtcOffsetSeconds"] as? Int, 32400)
    }

    func testSaveWithoutAProviderSendsNoLocation() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { fatalError() }
            if req.httpMethod == "POST" {
                return ok(entryJSON(id: "note_1", text: "plain"), status: 201, url: req.url!)
            }
            return ok(#"{"day":"2026-03-09","entries":[]}"#, url: req.url!)
        }
        let coordinator = makeCoordinator(session: session) // no location provider

        _ = await coordinator.save(text: "plain", surface: .app)

        let body = try lastPostBody(session)
        XCTAssertNil(body["latitude"])
        XCTAssertNil(body["placeName"])
    }

    func testDrainReplaysAQueuedNotesStoredLocation() async throws {
        // Queue a geotagged note while offline, then let a drain deliver
        // it — the POST must carry the location snapshotted at capture.
        let store = PendingNoteStore(directory: directory)
        try await store.enqueue(
            PendingNote(
                text: "queued in London",
                capturedTimeZoneId: "Europe/London",
                capturedUtcOffsetSeconds: 3600,
                surface: "ios-app",
                location: NoteLocation(latitude: 51.5074, longitude: -0.1278, placeName: "London")
            )
        )

        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { fatalError() }
            if req.httpMethod == "POST" {
                return ok(entryJSON(id: "note_1", text: "queued in London"), status: 201, url: req.url!)
            }
            return ok(#"{"day":"2026-03-09","entries":[]}"#, url: req.url!)
        }
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_1", session: session)

        await coordinator.drainPending()

        let body = try lastPostBody(session)
        XCTAssertEqual(body["latitude"] as? Double ?? 0, 51.5074, accuracy: 0.0001)
        XCTAssertEqual(body["placeName"] as? String, "London")
        XCTAssertEqual(body["capturedTimeZoneId"] as? String, "Europe/London")
        XCTAssertEqual(body["capturedUtcOffsetSeconds"] as? Int, 3600)
        XCTAssertTrue(coordinator.pending.isEmpty)
    }

    func testSaveQueuesWhenGatewayUnreachable() async {
        let session = MockSession()
        session.responder = nil // every request throws
        let coordinator = makeCoordinator(session: session)

        let outcome = await coordinator.save(text: "note while offline", surface: .app)

        XCTAssertEqual(outcome, .queued(.unreachable))
        XCTAssertEqual(coordinator.pending.map(\.text), ["note while offline"])
        XCTAssertEqual(coordinator.pending.first?.deliveryDiagnostics?.attemptCount, 1)
        XCTAssertEqual(coordinator.pending.first?.deliveryDiagnostics?.lastFailure.kind, .unreachable)
        XCTAssertFalse(coordinator.pending.first?.deliveryDiagnostics?.redeliveryFailed ?? true)
    }

    func testSaveQueuesOn404FromNonExperimentalGateway() async {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.ok(#"{"error":"not found"}"#, status: 404, url: req.url!)
        }
        let coordinator = makeCoordinator(session: session)

        let outcome = await coordinator.save(text: "kept for later", surface: .siri)

        // Distinguished from plain unreachability so the UI can say
        // "update your gateway" instead of "waiting for network".
        XCTAssertEqual(outcome, .queued(.featureOff))
        XCTAssertEqual(coordinator.pending.map(\.surface), ["ios-siri"])
        XCTAssertEqual(coordinator.pending.first?.deliveryDiagnostics?.lastFailure.kind, .featureOff)
        XCTAssertEqual(coordinator.pending.first?.deliveryDiagnostics?.lastFailure.code, 404)
    }

    func testSaveQueuesOn401AsUnauthorized() async {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.ok(#"{"error":"unauthorized"}"#, status: 401, url: req.url!)
        }
        let coordinator = makeCoordinator(session: session)

        let outcome = await coordinator.save(text: "kept until re-pair", surface: .app)

        XCTAssertEqual(outcome, .queued(.unauthorized))
        XCTAssertEqual(coordinator.pending.count, 1)
        XCTAssertEqual(coordinator.pending.first?.deliveryDiagnostics?.lastFailure.kind, .unauthorized)
        XCTAssertEqual(coordinator.pending.first?.deliveryDiagnostics?.lastFailure.code, 401)
    }

    func testSaveRejectedOn422DoesNotQueue() async {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.ok(#"{"error":"invalid note"}"#, status: 422, url: req.url!)
        }
        let coordinator = makeCoordinator(session: session)

        let outcome = await coordinator.save(text: "the gateway refuses this", surface: .app)

        // Deterministic rejection: retrying would fail identically, so
        // nothing may enter the queue — the UI keeps the text instead.
        guard case .rejected = outcome else {
            return XCTFail("expected .rejected, got \(outcome)")
        }
        XCTAssertTrue(coordinator.pending.isEmpty)
        let onDisk = await PendingNoteStore(directory: directory).count()
        XCTAssertEqual(onDisk, 0)
    }

    func testSaveRejectsOverlongTextClientSideWithoutRequest() async {
        let session = MockSession()
        let coordinator = makeCoordinator(session: session)
        let overlong = String(repeating: "a", count: NoteCaptureService.maxTextLength + 1)

        let outcome = await coordinator.save(text: overlong, surface: .app)

        guard case .rejected = outcome else {
            return XCTFail("expected .rejected, got \(outcome)")
        }
        // Enforced at capture: no POST attempted, nothing queued.
        XCTAssertTrue(session.requests.isEmpty)
        XCTAssertTrue(coordinator.pending.isEmpty)
    }

    func testSaveAtExactCapIsAccepted() async {
        let session = MockSession()
        session.responder = { [weak self] req in
            guard let self else { fatalError() }
            if req.httpMethod == "POST" {
                return ok(entryJSON(id: "note_cap", text: "long"), status: 201, url: req.url!)
            }
            return ok(#"{"day":"2026-03-09","entries":[]}"#, url: req.url!)
        }
        let coordinator = makeCoordinator(session: session)
        let atCap = String(repeating: "a", count: NoteCaptureService.maxTextLength)

        let outcome = await coordinator.save(text: atCap, surface: .app)

        XCTAssertEqual(outcome, .saved)
    }

    func testSaveEmptyTextFailsWithoutQueueing() async {
        let session = MockSession()
        let coordinator = makeCoordinator(session: session)

        let outcome = await coordinator.save(text: "   \n ", surface: .app)

        guard case .failed = outcome else {
            return XCTFail("expected .failed, got \(outcome)")
        }
        XCTAssertTrue(coordinator.pending.isEmpty)
        XCTAssertTrue(session.requests.isEmpty)
    }

    func testSaveWithoutClientQueues() async {
        let coordinator = NotesCoordinator(store: PendingNoteStore(directory: directory))

        let outcome = await coordinator.save(text: "captured before pairing", surface: .siri)

        XCTAssertEqual(outcome, .queued(.unreachable))
        XCTAssertEqual(coordinator.pending.count, 1)
        XCTAssertEqual(coordinator.pending.first?.deliveryDiagnostics?.attemptCount, 0)
        XCTAssertEqual(coordinator.pending.first?.deliveryDiagnostics?.lastFailure.kind, .unpaired)
    }

    func testSaveSuccessDrainsEarlierQueuedNotes() async throws {
        let store = PendingNoteStore(directory: directory)
        try await store.enqueue(PendingNote(text: "queued earlier offline", surface: "ios-siri"))

        let session = MockSession()
        var postedTexts: [String] = []
        session.responder = { [weak self] req in
            guard let self else { fatalError() }
            if req.httpMethod == "POST" {
                let sent = (try? JSONSerialization.jsonObject(with: req.httpBody ?? Data())) as? [String: Any]
                postedTexts.append(sent?["text"] as? String ?? "")
                return ok(entryJSON(id: "note_\(postedTexts.count)", text: "x"), status: 201, url: req.url!)
            }
            return ok(#"{"day":"2026-03-09","entries":[]}"#, url: req.url!)
        }
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_1", session: session)

        let outcome = await coordinator.save(text: "fresh note", surface: .app)

        // A successful save proves the gateway is reachable — the
        // queued backlog is drained in the same pass.
        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(postedTexts, ["fresh note", "queued earlier offline"])
        XCTAssertTrue(coordinator.pending.isEmpty)
    }

    // MARK: - Drain

    func testDrainPostsOriginalCapturedAtAndIdempotencyKeyAndClearsQueue() async throws {
        let store = PendingNoteStore(directory: directory)
        let capturedAt = try XCTUnwrap(NotesTime.date(fromISO: "2026-03-08T22:15:00.000Z"))
        let note = PendingNote(text: "spoken yesterday offline", capturedAt: capturedAt, surface: "ios-siri")
        try await store.enqueue(note)

        let session = MockSession()
        session.responder = { [weak self] req in
            self!.ok(self!.entryJSON(id: "note_9", text: "spoken yesterday offline"), status: 201, url: req.url!)
        }
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_1", session: session)

        await coordinator.drainPending()

        XCTAssertTrue(coordinator.pending.isEmpty)
        let request = try XCTUnwrap(session.requests.first)
        let sent = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
        XCTAssertEqual(sent?["capturedAt"] as? String, "2026-03-08T22:15:00.000Z")
        XCTAssertEqual(sent?["surface"] as? String, "ios-siri")
        XCTAssertEqual(sent?["deviceId"] as? String, "dev_1")
        // The persisted idempotency key rides along so a drain retry of
        // a landed-but-unacknowledged POST can't duplicate the note.
        XCTAssertNotNil(note.noteId)
        XCTAssertEqual(sent?["id"] as? String, note.noteId)
        let remaining = await store.count()
        XCTAssertEqual(remaining, 0)
    }

    func testDrainSkipsDeterministicallyRejectedRowAndContinues() async throws {
        let store = PendingNoteStore(directory: directory)
        let t0 = Date(timeIntervalSince1970: 1_772_000_000)
        for index in 0 ..< 3 {
            try await store.enqueue(PendingNote(
                id: PendingNote.makeId(now: t0.addingTimeInterval(Double(index))),
                text: "note \(index)",
                surface: "ios-app"
            ))
        }

        let session = MockSession()
        var posts = 0
        session.responder = { [weak self] req in
            guard let self else { fatalError() }
            posts += 1
            if posts == 2 {
                // The middle note is deterministically invalid — the
                // gateway will refuse it on every retry.
                return ok(#"{"error":"invalid note"}"#, status: 422, url: req.url!)
            }
            return ok(entryJSON(id: "note_\(posts)", text: "x"), status: 201, url: req.url!)
        }
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_1", session: session)

        await coordinator.drainPending()

        // The rejected row is skipped (kept for the user to fix or
        // swipe-delete) and the rest of the queue still delivers.
        XCTAssertEqual(posts, 3)
        XCTAssertEqual(coordinator.pending.map(\.text), ["note 1"])
        XCTAssertEqual(coordinator.pending.first?.deliveryDiagnostics?.lastFailure.kind, .rejected)
        XCTAssertTrue(coordinator.pending.first?.deliveryDiagnostics?.redeliveryFailed ?? false)
    }

    func testDrainStopsAtFirstFailureAndKeepsRemainder() async throws {
        let store = PendingNoteStore(directory: directory)
        let t0 = Date(timeIntervalSince1970: 1_772_000_000)
        for index in 0 ..< 3 {
            try await store.enqueue(PendingNote(
                id: PendingNote.makeId(now: t0.addingTimeInterval(Double(index))),
                text: "note \(index)",
                surface: "ios-app"
            ))
        }

        let session = MockSession()
        var posts = 0
        session.responder = { [weak self] req in
            posts += 1
            if posts == 1 {
                return self!.ok(self!.entryJSON(id: "note_a", text: "note 0"), status: 201, url: req.url!)
            }
            return self!.ok("unavailable", status: 503, url: req.url!)
        }
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_1", session: session)

        await coordinator.drainPending()

        // First delivered and removed; the failure on the second stops
        // the pass (no third POST) and both stay queued for next time.
        XCTAssertEqual(posts, 2)
        XCTAssertEqual(coordinator.pending.map(\.text), ["note 1", "note 2"])
        XCTAssertTrue(coordinator.pending[0].deliveryDiagnostics?.redeliveryFailed ?? false)
        XCTAssertEqual(coordinator.warnedPending().map(\.text), ["note 1"])
    }

    func testDrainWithoutClientIsANoOp() async throws {
        let store = PendingNoteStore(directory: directory)
        try await store.enqueue(PendingNote(text: "waiting", surface: "ios-app"))
        let coordinator = NotesCoordinator(store: store)

        await coordinator.drainPending()

        let count = await store.count()
        XCTAssertEqual(count, 1)
    }

    func testDeletePendingWaitsForInFlightDrainMutation() async throws {
        let store = PendingNoteStore(directory: directory)
        let note = PendingNote(text: "Queued before retry", surface: "ios-app")
        try await store.enqueue(note)
        let blocker = RequestBlocker()
        let session = MockSession()
        session.responder = { [weak self] req in
            await blocker.block()
            return self!.ok("unavailable", status: 503, url: req.url!)
        }
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_1", session: session)

        let drain = Task { await coordinator.drainPending() }
        await blocker.waitUntilStarted()
        let deleteStarted = expectation(description: "delete task started")
        let deletion = Task {
            deleteStarted.fulfill()
            await coordinator.deletePending(id: note.id)
        }
        await fulfillment(of: [deleteStarted], timeout: 1)
        try await Task.sleep(nanoseconds: 20_000_000)

        // The discard is queued behind the whole HTTP + queue mutation,
        // not interleaved while the drain is suspended.
        let countWhileDraining = await store.count()
        XCTAssertEqual(countWhileDraining, 1)

        await blocker.release()
        await drain.value
        await deletion.value
        let finalCount = await store.count()
        XCTAssertEqual(finalCount, 0)
        XCTAssertTrue(coordinator.pending.isEmpty)
    }

    func testRefreshPendingWaitsForInFlightDrainMutation() async throws {
        let store = PendingNoteStore(directory: directory)
        try await store.enqueue(PendingNote(text: "Queued before retry", surface: "ios-app"))
        let blocker = RequestBlocker()
        let session = MockSession()
        session.responder = { [weak self] req in
            await blocker.block()
            return self!.ok(self!.entryJSON(id: "note_delivered", text: "Queued before retry"), status: 201, url: req.url!)
        }
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_1", session: session)

        let drain = Task { await coordinator.drainPending() }
        await blocker.waitUntilStarted()
        let refreshFinished = expectation(description: "refresh waits for drain")
        refreshFinished.isInverted = true
        let refresh = Task {
            await coordinator.refreshPending()
            refreshFinished.fulfill()
        }

        // A refresh cannot snapshot and later republish queue state while
        // the retry owns the queue across its suspended HTTP operation.
        await fulfillment(of: [refreshFinished], timeout: 0.05)
        await blocker.release()
        await drain.value
        await refresh.value

        XCTAssertTrue(coordinator.pending.isEmpty)
        let remaining = await store.count()
        XCTAssertEqual(remaining, 0)
    }

    func testNextWarningDeadlineUsesOldestQuietNote() async throws {
        let now = Date(timeIntervalSince1970: 1_772_001_000)
        let store = PendingNoteStore(directory: directory)
        try await store.enqueue(PendingNote(
            text: "Newer queued note",
            capturedAt: now.addingTimeInterval(-30),
            surface: "ios-app"
        ))
        try await store.enqueue(PendingNote(
            text: "Older queued note",
            capturedAt: now.addingTimeInterval(-120),
            surface: "ios-app"
        ))
        let coordinator = NotesCoordinator(store: store)
        await coordinator.refreshPending()

        XCTAssertEqual(
            coordinator.nextWarningDeadline(now: now),
            now.addingTimeInterval(180)
        )
    }

    func testTeardownAndWipeQueueDropsPendingNotes() async throws {
        let store = PendingNoteStore(directory: directory)
        try await store.enqueue(PendingNote(text: "gone on unpair", surface: "ios-app"))
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_1", session: MockSession())

        coordinator.teardownAndWipeQueue()
        // The wipe is fire-and-forget onto the actor; give it a beat.
        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertTrue(coordinator.pending.isEmpty)
        let count = await store.count()
        XCTAssertEqual(count, 0)
        // The client is gone too: a post-teardown drain must not POST.
        await coordinator.drainPending()
    }
}
