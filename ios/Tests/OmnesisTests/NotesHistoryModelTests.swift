// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

@MainActor
final class NotesHistoryModelTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        var respond: ((URLRequest) async throws -> (Data, URLResponse))!
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            try await respond(request)
        }
    }

    private let noteJSON = """
    {"id":"n1","day":"2026-06-12","capturedAt":"2026-06-12T10:00:00Z",
    "updatedAt":"2026-06-12T10:00:00Z","text":"Workshop note",
    "agent":{"state":"done","receipt":{"text":"Added a task.","changes":[]}}}
    """

    private func response(_ request: URLRequest, body: String, status: Int = 200) -> (Data, URLResponse) {
        (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    func testSuccessfulEditPreservesReceiptWithoutFollowupRead() async throws {
        let session = Session()
        let note = try JSONDecoder().decode(NoteEntry.self, from: Data(noteJSON.utf8))
        session.respond = { request in
            XCTAssertEqual(request.httpMethod, "PATCH")
            return self.response(request, body: self.noteJSON.replacingOccurrences(of: "Workshop note", with: "Edited note"))
        }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client, entries: [note])
        let saved = try await model.edit(note, text: "Edited note")
        XCTAssertEqual(saved.text, "Edited note")
        XCTAssertEqual(saved.agent?.receipt?.text, "Added a task.")
        XCTAssertNil(saved.transcription)
        XCTAssertEqual(model.entries.first?.text, "Edited note")
    }

    func testReadStartedBeforeDeletionCannotRestoreNote() async throws {
        let session = Session()
        let note = try JSONDecoder().decode(NoteEntry.self, from: Data(noteJSON.utf8))
        var resumeRead: CheckedContinuation<Void, Never>?
        session.respond = { request in
            if request.httpMethod == "DELETE" { return self.response(request, body: "", status: 204) }
            await withCheckedContinuation { resumeRead = $0 }
            return self.response(request, body: "{\"entries\":[\(self.noteJSON)],\"pageInfo\":{\"hasMore\":false}}")
        }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client, entries: [note])
        let read = Task { await model.load() }
        while resumeRead == nil {
            await Task.yield()
        }
        try await model.remove(note)
        resumeRead?.resume()
        await read.value
        XCTAssertTrue(model.entries.isEmpty)
    }

    func testCaptureAndOfflineDeliveryInvalidateMountedHistory() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PendingNoteStore(directory: directory)
        let session = Session()
        session.respond = { self.response($0, body: self.noteJSON, status: 201) }
        let coordinator = NotesCoordinator(store: store)
        try coordinator.rebuild(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")),
            token: "test",
            deviceId: "test-device",
            session: session
        )
        let outcome = await coordinator.save(text: "Workshop note", surface: .app)
        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(coordinator.historyRevision, 1)
        try await store.enqueue(PendingNote(text: "Offline workshop note", surface: "ios-app"))
        await coordinator.drainPending()
        XCTAssertEqual(coordinator.historyRevision, 2)
    }

    func testCaptureRefreshAddsNewHeadAndRetainsOlderPages() async throws {
        let session = Session()
        let old = try JSONDecoder().decode(NoteEntry.self, from: Data(noteJSON.utf8))
        let newest = noteJSON.replacingOccurrences(of: "n1", with: "new-note").replacingOccurrences(of: "T10:", with: "T11:")
        session.respond = { self.response($0, body: "{\"entries\":[\(newest)],\"pageInfo\":{\"hasMore\":false}}") }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client, entries: [old])
        await model.refreshAfterCapture()
        XCTAssertEqual(model.entries.map(\.id), ["new-note", "n1"])
    }

    func testCaptureRefreshReopensPaginationForNewOfflineBacklog() async throws {
        let session = Session()
        let old = try JSONDecoder().decode(NoteEntry.self, from: Data(noteJSON.utf8))
        let newest = noteJSON.replacingOccurrences(of: "n1", with: "new-note").replacingOccurrences(of: "T10:", with: "T11:")
        session.respond = { request in
            self.response(
                request,
                body: "{\"entries\":[\(newest)],\"pageInfo\":{\"hasMore\":true,\"nextCursor\":\"new-backlog\"}}"
            )
        }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client, entries: [old])
        XCTAssertNil(model.nextCursor)
        await model.refreshAfterCapture()
        XCTAssertEqual(model.nextCursor, "new-backlog")
        XCTAssertEqual(model.entries.map(\.id), ["new-note", "n1"])
    }

    func testCaptureRefreshWaitsForInitialPageThenLoadsNewHead() async throws {
        let session = Session()
        let started = expectation(description: "Initial history read is in flight")
        var release: CheckedContinuation<Void, Never>?
        var reads = 0
        let newest = noteJSON.replacingOccurrences(of: "n1", with: "new-note").replacingOccurrences(of: "T10:", with: "T11:")
        session.respond = { request in
            reads += 1
            let body: String
            if reads == 1 {
                await withCheckedContinuation { release = $0
                    started.fulfill()
                }
                body = self.noteJSON
            } else { body = newest }
            return self.response(request, body: "{\"entries\":[\(body)],\"pageInfo\":{\"hasMore\":false}}")
        }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client)
        let initial = Task { await model.load() }
        await fulfillment(of: [started], timeout: 1)
        let refresh = Task { await model.refreshAfterCapture() }
        await Task.yield()
        XCTAssertEqual(reads, 1)
        try XCTUnwrap(release).resume()
        await initial.value
        await refresh.value
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(model.entries.map(\.id), ["new-note", "n1"])
    }

    func testFreshCursorDiscoversBacklogBetweenNewHeadAndCachedOlderNotes() async throws {
        let session = Session()
        let old = NoteEntry(
            id: "older",
            day: "2026-06-11",
            capturedAt: "2026-06-11T10:00:00Z",
            updatedAt: "2026-06-11T10:00:00Z",
            text: "Older workshop note",
            surface: nil,
            deviceId: nil
        )
        let ascendingNotes = (0 ..< 30).map { index in
            let stamp = String(format: "2026-06-12T10:%02d:00Z", index)
            return NoteEntry(
                id: "new-\(index)",
                day: "2026-06-12",
                capturedAt: stamp,
                updatedAt: stamp,
                text: "Workshop note \(index)",
                surface: nil,
                deviceId: nil
            )
        }
        let newNotes = ascendingNotes.reversed()
        let encoder = JSONEncoder()
        func page(_ notes: [NoteEntry], cursor: String) throws -> String {
            let entries = try XCTUnwrap(String(bytes: encoder.encode(notes), encoding: .utf8))
            return "{\"entries\":\(entries),\"pageInfo\":{\"hasMore\":true,\"nextCursor\":\"\(cursor)\"}}"
        }
        var requests = 0
        var cursors: [String?] = []
        session.respond = { request in
            cursors
                .append(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value)
            requests += 1
            let body: String = switch requests {
            case 1: try page([old], cursor: "old-tail")
            case 2: try page(Array(newNotes.prefix(25)), cursor: "fresh-middle")
            default: try page(Array(newNotes.suffix(5)) + [old], cursor: "older-remainder")
            }
            return self.response(request, body: body)
        }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client)
        await model.load()
        XCTAssertEqual(model.nextCursor, "old-tail")
        await model.refreshAfterCapture()
        XCTAssertEqual(model.nextCursor, "fresh-middle")
        await model.load(more: true)
        XCTAssertEqual(cursors, [nil, nil, "fresh-middle"])
        XCTAssertEqual(model.entries.map(\.id), newNotes.map(\.id) + [old.id])
        XCTAssertEqual(model.entries.count, 31)
        XCTAssertEqual(model.nextCursor, "older-remainder")
    }

    func testMergedPageUsesIdTieOrderAndFreshVersionWithoutDuplicates() async throws {
        let session = Session()
        let stamp = "2026-06-12T10:00:00Z"
        let cached = NoteEntry(
            id: "note-b",
            day: "2026-06-12",
            capturedAt: stamp,
            updatedAt: stamp,
            text: "Old wording",
            surface: nil,
            deviceId: nil
        )
        let fresh = NoteEntry(
            id: "note-b",
            day: "2026-06-12",
            capturedAt: stamp,
            updatedAt: stamp,
            text: "Updated wording",
            surface: nil,
            deviceId: nil
        )
        let sibling = NoteEntry(
            id: "note-a",
            day: "2026-06-12",
            capturedAt: stamp,
            updatedAt: stamp,
            text: "Another note",
            surface: nil,
            deviceId: nil
        )
        let entries = try XCTUnwrap(String(bytes: JSONEncoder().encode([sibling, fresh]), encoding: .utf8))
        session.respond = { self.response($0, body: "{\"entries\":\(entries),\"pageInfo\":{\"hasMore\":false}}") }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client, entries: [cached])
        await model.refreshAfterCapture()
        XCTAssertEqual(model.entries.map(\.id), ["note-a", "note-b"])
        XCTAssertEqual(model.entries.last?.text, "Updated wording")
    }

    func testFreshNoteWithoutQueueRowRefreshesIntoAgentReply() async throws {
        let session = Session()
        let stamp = NotesTime.isoString(from: Date())
        let note = NoteEntry(
            id: "n1",
            day: "2026-06-12",
            capturedAt: stamp,
            updatedAt: stamp,
            receivedAt: stamp,
            text: "Workshop note",
            surface: nil,
            deviceId: nil
        )
        session.respond = { self.response($0, body: "{\"entries\":[\(self.noteJSON)]}") }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client, entries: [note])
        XCTAssertTrue(note.shouldRefreshReceipt())
        await model.refreshPending()
        XCTAssertEqual(model.entries.first?.agent?.receipt?.text, "Added a task.")
        XCTAssertFalse(model.entries[0].shouldRefreshReceipt())
    }

    func testHistoricalNoteWithoutAgentDoesNotPollForever() {
        let now = Date()
        let stamp = NotesTime.isoString(from: now.addingTimeInterval(-61))
        let note = NoteEntry(
            id: "n1",
            day: "2026-06-12",
            capturedAt: stamp,
            updatedAt: stamp,
            text: "Workshop note",
            surface: nil,
            deviceId: nil
        )
        XCTAssertFalse(note.shouldRefreshReceipt(now: now))
    }

    func testUndoExplainsLaterChangeConflict() async throws {
        let session = Session()
        session.respond = { self.response($0, body: "{\"error\":\"conflict\"}", status: 409) }
        let tasks = try TasksClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: nil, tasks: tasks)
        do { try await model.undo(seq: 42)
            XCTFail("Expected conflict")
        } catch { XCTAssertEqual(error.localizedDescription, "A later change to this task has to be undone first.") }
        XCTAssertFalse(model.undoneSequences.contains(42))
    }

    func testFailedEditOfRemovedNoteConvergesLocally() async throws {
        let session = Session()
        let note = try JSONDecoder().decode(NoteEntry.self, from: Data(noteJSON.utf8))
        session.respond = { self.response($0, body: "", status: 404) }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client, entries: [note])
        do { _ = try await model.edit(note, text: "Changed note")
            XCTFail("Expected not found")
        } catch GatewayClient.Error.notFound {}
        XCTAssertTrue(model.entries.isEmpty)
    }

    func testAlreadyDeletedNoteIsRemovedLocally() async throws {
        let session = Session()
        let note = try JSONDecoder().decode(NoteEntry.self, from: Data(noteJSON.utf8))
        session.respond = { self.response($0, body: "", status: 404) }
        let client = try NotesClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test", session: session)
        let model = NotesHistoryModel(client: client, entries: [note])
        try await model.remove(note)
        XCTAssertTrue(model.entries.isEmpty)
    }
}
