// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Voice notes (experimental gateway dictation): a note saved at once with
/// the phone's transcript and its recording attached for the gateway. Covers
/// the multipart request, when a capture attaches its recording, delivery
/// with its text fallback, and the offline queue carrying the recording.
@MainActor
final class VoiceNoteTests: XCTestCase {
    /// Answers each path with a scripted status, and records every request.
    private final class ScriptedSession: URLSessionLike, @unchecked Sendable {
        private let lock = NSLock()
        private var log: [URLRequest] = []
        var voiceStatus = 202
        var textStatus = 201
        var unreachable = false

        var requests: [URLRequest] {
            lock.lock()
            defer { lock.unlock() }
            return log
        }

        var paths: [String] {
            requests.compactMap { $0.url?.path }
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            lock.lock()
            log.append(request)
            lock.unlock()
            if unreachable { throw URLError(.notConnectedToInternet) }
            let voice = request.url?.path == "/notes/voice"
            let status = voice ? voiceStatus : textStatus
            let body: String = if voice {
                status == 202
                    ? #"{"id":"6f8f57e2-3b0c-4a5e-9c1d-2a7b8e4d0f11","transcription":"pending"}"#
                    : #"{"error":"no","code":"X"}"#
            } else {
                """
                {"id":"n1","day":"2026-09-30","capturedAt":"2026-09-30T09:00:00.000Z",
                 "updatedAt":"2026-09-30T09:00:00.000Z","text":"t","surface":"ios-app","deviceId":null}
                """
            }
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(body.utf8), response)
        }
    }

    private var directory: URL!
    private let base = URL(string: "https://gateway.example.com:7600")!
    private let captureTime = NoteCaptureTime(
        capturedAt: Date(timeIntervalSince1970: 1_790_000_000),
        timeZoneId: "Europe/London",
        utcOffsetSeconds: 3600
    )
    private let noteId = "6f8f57e2-3b0c-4a5e-9c1d-2a7b8e4d0f11"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-notes-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func recording(bytes: Int = 2048) throws -> NoteAudio {
        let file = directory.appendingPathComponent("\(UUID().uuidString).m4a")
        try Data(repeating: 0x2A, count: bytes).write(to: file)
        return NoteAudio(file: file, locale: "en_GB")
    }

    private var store: PendingNoteStore {
        PendingNoteStore(directory: directory.appendingPathComponent("queue", isDirectory: true))
    }

    private func capture(
        _ text: String,
        audio: NoteAudio?,
        session: ScriptedSession,
        store: PendingNoteStore
    ) async
        -> NoteCaptureService.Outcome {
        await NoteCaptureService.capture(
            text: text,
            surface: .app,
            client: NotesClient(baseURL: base, token: "omn_t", session: session),
            deviceId: "dev_phone",
            store: store,
            captureTime: captureTime,
            noteId: noteId,
            audio: audio
        )
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    // MARK: - Request

    func testTheVoiceNoteIsAMultipartOfNoteAndAudio() throws {
        let upload = VoiceNoteUpload(
            id: noteId,
            text: "Book the dentist for Thursday",
            capturedAt: captureTime.capturedAt,
            capturedTimeZoneId: "Europe/London",
            capturedUtcOffsetSeconds: 3600,
            surface: "ios-app",
            deviceId: "dev_phone",
            location: NoteLocation(latitude: 51.5, longitude: -0.12, placeName: "Example Park"),
            language: "en_GB"
        )
        let audio = Data([0x00, 0x01, 0x02, 0x03])
        let request = try NotesClient.voiceNoteRequest(
            baseURL: base,
            token: "omn_t",
            note: upload,
            audio: audio,
            boundary: "BOUNDARY"
        )

        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/notes/voice")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "multipart/form-data; boundary=BOUNDARY")
        XCTAssertGreaterThanOrEqual(request.timeoutInterval, 60)

        let body = try XCTUnwrap(request.httpBody)
        let text = try XCTUnwrap(String(bytes: body, encoding: .utf8))
        XCTAssertTrue(text.hasPrefix("--BOUNDARY\r\nContent-Disposition: form-data; name=\"note\"\r\n"))
        XCTAssertTrue(text
            .contains("Content-Disposition: form-data; name=\"audio\"; filename=\"note.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n"))
        XCTAssertTrue(text.hasSuffix("\r\n--BOUNDARY--\r\n"))
        XCTAssertNotNil(body.range(of: audio), "the recording's bytes are sent as they are")

        let noteStart = try XCTUnwrap(text.range(of: "Content-Type: application/json\r\n\r\n")).upperBound
        let noteEnd = try XCTUnwrap(text.range(of: "\r\n--BOUNDARY", range: noteStart ..< text.endIndex)).lowerBound
        let note = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text[noteStart ..< noteEnd].utf8)) as? [String: Any])
        XCTAssertEqual(note["id"] as? String, noteId)
        XCTAssertEqual(note["text"] as? String, "Book the dentist for Thursday")
        XCTAssertEqual(note["surface"] as? String, "ios-app")
        XCTAssertEqual(note["language"] as? String, "en_GB")
        XCTAssertEqual(note["capturedTimeZoneId"] as? String, "Europe/London")
        XCTAssertEqual(note["placeName"] as? String, "Example Park")
        XCTAssertNotNil(note["capturedAt"] as? String)
    }

    // MARK: - A voice-note capture

    func testRunsBuildOneVoiceNoteWithAHiddenTranscript() {
        let start = Date(timeIntervalSince1970: 1_790_000_000)
        var state = VoiceNoteCaptureState()
        XCTAssertFalse(state.hasRecording)

        state.startRun(at: start)
        XCTAssertTrue(state.isRecording)
        XCTAssertTrue(state.hasRecording)
        state.heard("book the")
        state.heard("book the dentist")
        XCTAssertEqual(state.duration(at: start.addingTimeInterval(5)), 5, accuracy: 0.001)
        state.stopRun(at: start.addingTimeInterval(8))
        // The final result arrives after the run stopped.
        state.heard("book the dentist for Thursday")
        XCTAssertFalse(state.isRecording)
        XCTAssertEqual(state.duration(at: start.addingTimeInterval(60)), 8, accuracy: 0.001)

        state.startRun(at: start.addingTimeInterval(20))
        state.heard("and call the garage")
        state.stopRun(at: start.addingTimeInterval(24))

        XCTAssertEqual(state.hiddenTranscript, "book the dentist for Thursday and call the garage")
        XCTAssertEqual(state.duration(at: start.addingTimeInterval(100)), 12, accuracy: 0.001)
    }

    /// Discarding the recording makes the capture an empty typed note.
    func testDiscardingTheRecordingStartsOverAsTyping() {
        var state = VoiceNoteCaptureState()
        state.startRun(at: Date())
        state.heard("something private")
        state.discard()

        XCTAssertFalse(state.hasRecording)
        XCTAssertEqual(state.hiddenTranscript, "")
        XCTAssertEqual(state, VoiceNoteCaptureState())
    }

    func testTheLengthReadsAsAClockAndAloud() {
        XCTAssertEqual(VoiceNoteCaptureState.clock(0), "0:00")
        XCTAssertEqual(VoiceNoteCaptureState.clock(12.9), "0:12")
        XCTAssertEqual(VoiceNoteCaptureState.clock(72), "1:12")
        XCTAssertTrue(VoiceNoteCaptureState.spokenDuration(12).contains("12"))
        XCTAssertTrue(VoiceNoteCaptureState.spokenDuration(72).contains("1"))
    }

    /// A voice note is saved with its recording and, as its text, the
    /// transcript the screen never showed.
    func testAVoiceNoteSavesItsHiddenTranscriptWithTheRecording() async throws {
        var state = VoiceNoteCaptureState()
        state.startRun(at: Date())
        state.heard("Book the dentist")
        state.stopRun(at: Date())
        let session = ScriptedSession()

        let outcome = try await capture(state.hiddenTranscript, audio: recording(), session: session, store: store)

        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(session.paths, ["/notes/voice"])
        let body = try XCTUnwrap(session.requests.first?.httpBody)
        XCTAssertNotNil(body.range(of: Data(#""text":"Book the dentist""#.utf8)))
    }

    // MARK: - Delivery

    func testAVoiceNoteIsDeliveredWithItsRecording() async throws {
        let session = ScriptedSession()
        let audio = try recording()
        let store = store

        let outcome = await capture("Book the dentist", audio: audio, session: session, store: store)

        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(session.paths, ["/notes/voice"])
        XCTAssertFalse(exists(audio.file), "the recording is deleted once delivered")
        let queued = await store.count()
        XCTAssertEqual(queued, 0)
    }

    /// A gateway that does not take voice notes gets the phone's text.
    func testUnavailableVoiceNotesFallBackToText() async throws {
        for status in [404, 409, 413, 503] {
            let session = ScriptedSession()
            session.voiceStatus = status
            let audio = try recording()

            let outcome = await capture("Book the dentist", audio: audio, session: session, store: store)

            XCTAssertEqual(outcome, .saved, "status \(status)")
            XCTAssertEqual(session.paths, ["/notes/voice", "/notes"], "status \(status)")
            XCTAssertFalse(exists(audio.file), "the recording is dropped (status \(status))")
            let plain = try XCTUnwrap(session.requests.last?.httpBody)
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: plain) as? [String: Any])
            XCTAssertEqual(json["id"] as? String, noteId, "the same idempotency key")
            XCTAssertEqual(json["text"] as? String, "Book the dentist")
        }
    }

    func testATextlessVoiceNoteThatCannotGoAsAudioIsRefused() async throws {
        let session = ScriptedSession()
        session.voiceStatus = 409
        let audio = try recording()

        let outcome = await capture("", audio: audio, session: session, store: store)

        XCTAssertEqual(outcome, .rejected(VoiceNoteDelivery.refusedMessage))
        XCTAssertEqual(session.paths, ["/notes/voice"])
        XCTAssertFalse(exists(audio.file))
    }

    func testATextNoteIsUnchanged() async {
        let session = ScriptedSession()
        let outcome = await capture("Just typed", audio: nil, session: session, store: store)
        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(session.paths, ["/notes"])
    }

    // MARK: - Offline queue

    func testAnUndeliveredVoiceNoteIsQueuedWithItsRecording() async throws {
        let session = ScriptedSession()
        session.unreachable = true
        let audio = try recording(bytes: 3000)
        let store = store

        let outcome = await capture("Book the dentist", audio: audio, session: session, store: store)

        XCTAssertEqual(outcome, .queued(.unreachable))
        XCTAssertFalse(exists(audio.file), "moved into the queue")
        let queued = await store.list()
        XCTAssertEqual(queued.count, 1)
        XCTAssertEqual(queued.first?.voice, PendingNoteVoice(locale: "en_GB"))
        XCTAssertEqual(queued.first?.noteId, noteId)
        let queuedId = try XCTUnwrap(queued.first?.id)
        let keptFile = await store.audioFile(for: queuedId)
        let kept = try XCTUnwrap(keptFile)
        XCTAssertEqual(try Data(contentsOf: kept).count, 3000)
    }

    func testTheDrainDeliversAQueuedVoiceNoteAndItsRecording() async throws {
        let session = ScriptedSession()
        session.unreachable = true
        let store = store
        _ = try await capture("Book the dentist", audio: recording(), session: session, store: store)
        let first = await store.list().first
        let id = try XCTUnwrap(first?.id)
        let keptFile = await store.audioFile(for: id)
        let kept = try XCTUnwrap(keptFile)

        session.unreachable = false
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_phone", session: session)
        await coordinator.drainPending()

        XCTAssertEqual(session.paths.last, "/notes/voice")
        let remaining = await store.count()
        XCTAssertEqual(remaining, 0)
        XCTAssertFalse(exists(kept), "the recording goes with the delivered note")
    }

    func testTheDrainFallsBackToTextWhenVoiceNotesAreOff() async throws {
        let session = ScriptedSession()
        session.unreachable = true
        let store = store
        _ = try await capture("Book the dentist", audio: recording(), session: session, store: store)

        session.unreachable = false
        session.voiceStatus = 503
        let coordinator = NotesCoordinator(store: store)
        coordinator.rebuild(baseURL: base, token: "omn_t", deviceId: "dev_phone", session: session)
        await coordinator.drainPending()

        XCTAssertEqual(Array(session.paths.suffix(2)), ["/notes/voice", "/notes"])
        let remaining = await store.count()
        XCTAssertEqual(remaining, 0)
        XCTAssertFalse(
            ((try? FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("queue").path)) ?? [])
                .contains { $0.hasSuffix(".m4a") },
            "no recording left behind"
        )
    }

    func testDiscardingAQueuedVoiceNoteDeletesItsRecording() async throws {
        let session = ScriptedSession()
        session.unreachable = true
        let store = store
        _ = try await capture("Book the dentist", audio: recording(), session: session, store: store)
        let first = await store.list().first
        let id = try XCTUnwrap(first?.id)
        let keptFile = await store.audioFile(for: id)
        let kept = try XCTUnwrap(keptFile)

        try await store.remove(id: id)

        XCTAssertFalse(exists(kept))
    }
}
