// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PendingNoteStoreTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-pending-notes-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testEnqueueListRoundTripsFields() async throws {
        let store = PendingNoteStore(directory: directory)
        let capturedAt = Date(timeIntervalSince1970: 1_772_000_000)
        let note = PendingNote(
            text: "Renew the gym membership",
            capturedAt: capturedAt,
            capturedTimeZoneId: "Europe/London",
            capturedUtcOffsetSeconds: 0,
            surface: "ios-siri"
        )

        try await store.enqueue(note)
        let listed = await store.list()

        XCTAssertEqual(listed, [note])
        // ISO-8601 date coding truncates sub-second precision; the
        // original capture time must survive to the second.
        XCTAssertEqual(
            listed.first?.capturedAt.timeIntervalSince1970 ?? 0,
            capturedAt.timeIntervalSince1970,
            accuracy: 1
        )
    }

    func testEnqueueFailsClosedWhenBackupExclusionCannotBeApplied() async throws {
        let store = PendingNoteStore(directory: directory)
        try FileManager.default.removeItem(at: directory)

        do {
            try await store.enqueue(PendingNote(text: "Private note", surface: "ios-app"))
            XCTFail("A note must not be written without backup exclusion")
        } catch {
            XCTAssertEqual(
                error as? ProtectedStoreError,
                .backupExclusionFailed(.pendingNotes)
            )
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testListIsFIFOByCreationOrder() async throws {
        let store = PendingNoteStore(directory: directory)
        let t0 = Date(timeIntervalSince1970: 1_772_000_000)
        for index in 0 ..< 5 {
            let note = PendingNote(
                id: PendingNote.makeId(now: t0.addingTimeInterval(Double(index))),
                text: "note \(index)",
                surface: "ios-app"
            )
            try await store.enqueue(note)
        }

        let texts = await store.list().map(\.text)
        XCTAssertEqual(texts, ["note 0", "note 1", "note 2", "note 3", "note 4"])
    }

    func testPersistsAcrossInstancesOverSameDirectory() async throws {
        let writer = PendingNoteStore(directory: directory)
        try await writer.enqueue(PendingNote(text: "written by intent process path", surface: "ios-siri"))

        // A second instance (the coordinator's) sees the note without
        // any cache coordination — disk is the single source of truth.
        let reader = PendingNoteStore(directory: directory)
        let listed = await reader.list()
        XCTAssertEqual(listed.map(\.text), ["written by intent process path"])

        // And a removal through the reader is visible to the writer.
        try await reader.remove(id: listed[0].id)
        let countAfter = await writer.count()
        XCTAssertEqual(countAfter, 0)
    }

    func testRemoveMissingIdIsANoOp() async throws {
        let store = PendingNoteStore(directory: directory)
        try await store.remove(id: "never-existed")
        let count = await store.count()
        XCTAssertEqual(count, 0)
    }

    func testRemoveAllEmptiesTheQueue() async throws {
        let store = PendingNoteStore(directory: directory)
        try await store.enqueue(PendingNote(text: "one", surface: "ios-app"))
        try await store.enqueue(PendingNote(text: "two", surface: "ios-app"))

        await store.removeAll()

        let count = await store.count()
        XCTAssertEqual(count, 0)
    }

    func testCorruptFileIsSkippedNotFatal() async throws {
        let store = PendingNoteStore(directory: directory)
        try await store.enqueue(PendingNote(text: "good note", surface: "ios-app"))
        try Data("not json".utf8).write(to: directory.appendingPathComponent("zzz-corrupt.json"))

        let listed = await store.list()
        XCTAssertEqual(listed.map(\.text), ["good note"])
    }

    func testNoteIdRoundTripsAndDefaultsToAUUID() async throws {
        let store = PendingNoteStore(directory: directory)
        let note = PendingNote(text: "carries an idempotency key", surface: "ios-app")
        // Freshly captured notes always mint a key…
        let noteId = try XCTUnwrap(note.noteId)
        XCTAssertNotNil(UUID(uuidString: noteId))

        try await store.enqueue(note)
        let listed = await store.list()

        // …and it survives the disk round trip unchanged.
        XCTAssertEqual(listed.first?.noteId, noteId)
    }

    func testQueueFileWithoutNoteIdStillDecodes() async throws {
        // A queue file written before the idempotency key existed must
        // keep decoding (nil key) — not be skipped as corrupt.
        let store = PendingNoteStore(directory: directory)
        let legacy = """
        {"id":"20260309T080000000-legacy01","text":"written by an older build",
         "capturedAt":"2026-03-09T08:00:00Z","surface":"ios-app"}
        """
        try Data(legacy.utf8).write(to: directory.appendingPathComponent("20260309T080000000-legacy01.json"))

        let listed = await store.list()

        XCTAssertEqual(listed.map(\.text), ["written by an older build"])
        XCTAssertNil(listed.first?.noteId)
        XCTAssertNil(listed.first?.deliveryDiagnostics)
    }

    func testLocationRoundTrips() async throws {
        let store = PendingNoteStore(directory: directory)
        // A whole-second capture time so the note round-trips byte-equal
        // (ISO-8601 date coding truncates sub-second precision).
        let note = PendingNote(
            text: "Idea at the park",
            capturedAt: Date(timeIntervalSince1970: 1_772_000_000),
            surface: "ios-app",
            location: NoteLocation(latitude: 48.8566, longitude: 2.3522, placeName: "Paris")
        )
        try await store.enqueue(note)

        let listed = await store.list()
        XCTAssertEqual(listed, [note])
        XCTAssertEqual(listed.first?.location?.placeName, "Paris")
        XCTAssertEqual(listed.first?.location?.latitude ?? 0, 48.8566, accuracy: 0.0001)
    }

    func testQueueFileWithoutLocationStillDecodes() async throws {
        // A queue file written before location existed (or a fix-less
        // capture) decodes with a nil location — not skipped as corrupt.
        let store = PendingNoteStore(directory: directory)
        let legacy = """
        {"id":"20260309T080000000-legacy02","noteId":"6f8f57e2-3b0c-4a5e-9c1d-2a7b8e4d0f11",
         "text":"no location here","capturedAt":"2026-03-09T08:00:00Z","surface":"ios-app"}
        """
        try Data(legacy.utf8).write(to: directory.appendingPathComponent("20260309T080000000-legacy02.json"))

        let listed = await store.list()
        XCTAssertEqual(listed.map(\.text), ["no location here"])
        XCTAssertNil(listed.first?.location)
    }

    func testMakeIdSortsByTimestamp() {
        let early = PendingNote.makeId(now: Date(timeIntervalSince1970: 1_772_000_000))
        let late = PendingNote.makeId(now: Date(timeIntervalSince1970: 1_772_000_060))
        XCTAssertLessThan(early, late)
    }

    func testDeliveryDiagnosticsRoundTripAndFailedRedeliveryUpdate() async throws {
        let store = PendingNoteStore(directory: directory)
        let firstAttempt = Date(timeIntervalSince1970: 1_772_000_010)
        let retry = Date(timeIntervalSince1970: 1_772_000_070)
        let note = PendingNote(
            text: "Review the garden plan",
            capturedAt: Date(timeIntervalSince1970: 1_772_000_000),
            surface: "ios-app",
            deliveryDiagnostics: PendingNoteDeliveryDiagnostics(
                attemptCount: 1,
                lastAttemptAt: firstAttempt,
                lastFailure: PendingNoteDeliveryFailure(kind: .unreachable, code: -1009)
            )
        )
        try await store.enqueue(note)

        try await store.recordFailedRedelivery(
            id: note.id,
            failure: PendingNoteDeliveryFailure(kind: .unauthorized, code: 401),
            attemptedAt: retry
        )

        let listed = await store.list()
        let diagnostics = try XCTUnwrap(listed.first?.deliveryDiagnostics)
        XCTAssertEqual(diagnostics.attemptCount, 2)
        XCTAssertEqual(diagnostics.lastFailure, PendingNoteDeliveryFailure(kind: .unauthorized, code: 401))
        XCTAssertTrue(diagnostics.redeliveryFailed)
        XCTAssertEqual(diagnostics.lastAttemptAt?.timeIntervalSince1970 ?? 0, retry.timeIntervalSince1970, accuracy: 1)
    }

    func testRecordingFailureAfterConcurrentRemovalIsNoOp() async throws {
        let store = PendingNoteStore(directory: directory)
        let note = PendingNote(text: "Temporary queued thought", surface: "ios-app")
        try await store.enqueue(note)
        try await store.remove(id: note.id)

        try await store.recordFailedRedelivery(
            id: note.id,
            failure: PendingNoteDeliveryFailure(kind: .unreachable)
        )

        let remaining = await store.count()
        XCTAssertEqual(remaining, 0)
    }

    func testRemoveDropsDeliveryDiagnosticsSidecar() async throws {
        let store = PendingNoteStore(directory: directory)
        let note = PendingNote(text: "Queued garden note", surface: "ios-app")
        try await store.enqueue(note)
        try await store.recordFailedRedelivery(
            id: note.id,
            failure: PendingNoteDeliveryFailure(kind: .unreachable)
        )

        try await store.remove(id: note.id)

        let contents = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertTrue(contents.isEmpty)
    }

    func testWarningAfterFiveMinutesOrFailedRedelivery() {
        let now = Date(timeIntervalSince1970: 1_772_001_000)
        let fresh = PendingNote(
            text: "Fresh note",
            capturedAt: now.addingTimeInterval(-299),
            surface: "ios-app"
        )
        let aged = PendingNote(
            text: "Aged note",
            capturedAt: now.addingTimeInterval(-300),
            surface: "ios-app"
        )
        let retried = PendingNote(
            text: "Retried note",
            capturedAt: now.addingTimeInterval(-10),
            surface: "ios-app",
            deliveryDiagnostics: PendingNoteDeliveryDiagnostics(
                attemptCount: 2,
                lastAttemptAt: now,
                lastFailure: PendingNoteDeliveryFailure(kind: .unreachable),
                redeliveryFailed: true
            )
        )

        XCTAssertFalse(fresh.warrantsDeliveryWarning(now: now))
        XCTAssertTrue(aged.warrantsDeliveryWarning(now: now))
        XCTAssertTrue(retried.warrantsDeliveryWarning(now: now))
    }
}
