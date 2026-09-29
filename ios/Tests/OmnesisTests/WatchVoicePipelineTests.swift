// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A gateway transcriber that answers every recording the same way.
private struct FixedTranscriber: DictationTranscribing {
    let text: String?

    func transcribe(audio: Data, contentType: String, language: String?) async throws -> DictationTranscription {
        guard let text else { throw DictationTranscribeError.disabled }
        return DictationTranscription(text: text)
    }
}

/// Everything the pipeline did, for the assertions.
private final class Record: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }

    func add(_ entry: String) {
        lock.lock()
        entries.append(entry)
        lock.unlock()
    }
}

/// The iPhone side of gateway dictation on the watch: a recording arrives,
/// is kept in the inbox, transcribed — by the gateway, or on the device when
/// the gateway cannot — and becomes a saved note or an asked question. The
/// inbox is empty afterwards on every path, and an interrupted item resumes
/// from where it got to.
final class WatchVoicePipelineTests: XCTestCase {
    private var directory: URL!
    private var inbox: WatchVoiceInbox!
    private let now = Date(timeIntervalSince1970: 1_790_000_000)
    private let spoken = "Pick up the bike from the workshop on Saturday"

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("watch-voice-\(UUID().uuidString)", isDirectory: true)
        inbox = WatchVoiceInbox(directory: directory.appendingPathComponent("inbox", isDirectory: true))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func metadata(
        kind: WatchVoiceKind = .note,
        ref: String = UUID().uuidString,
        capturedAt: Date? = nil
    )
        -> [String: String] {
        WatchVoiceRecording(
            kind: kind,
            ref: ref,
            captureTime: NoteCaptureTime(capturedAt: capturedAt ?? now, timeZoneId: "Europe/London", utcOffsetSeconds: 0),
            locale: "en_GB"
        ).metadata
    }

    /// A recording as WatchConnectivity hands it over, admitted to the inbox.
    private func received(
        kind: WatchVoiceKind = .note,
        ref: String = UUID().uuidString,
        capturedAt: Date? = nil,
        bytes: Int = 4096
    ) throws
        -> WatchVoiceInbox.Item {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let delivered = directory.appendingPathComponent("\(UUID().uuidString).m4a")
        try Data(repeating: 0x2A, count: bytes).write(to: delivered)
        let item = try XCTUnwrap(inbox.admit(
            file: delivered,
            metadata: metadata(kind: kind, ref: ref, capturedAt: capturedAt)
        ))
        XCTAssertFalse(FileManager.default.fileExists(atPath: delivered.path), "moved out of the WatchConnectivity inbox")
        return item
    }

    private func pipeline(
        gateway: String??,
        onDevice: String?,
        record: Record,
        claimed: Set<String> = [],
        maxAudioBytes: Int = 1_000_000
    )
        -> WatchVoicePipeline {
        let now = now
        return WatchVoicePipeline(
            gatewayRoute: {
                gateway.map {
                    GatewayDictationRoute(transcriber: FixedTranscriber(text: $0), maxAudioBytes: maxAudioBytes)
                }
            },
            transcribeOnDevice: { _, locale in
                record.add("on-device \(locale ?? "-")")
                return onDevice
            },
            saveNote: { text, _, id in record.add("note \(id): \(text)") },
            ask: { record.add("ask: \($0)") },
            notify: { record.add("notify: \(Self.label($0))") },
            claim: { !claimed.contains($0) },
            now: { now }
        )
    }

    private static func label(_ notice: WatchVoiceNotice) -> String {
        switch notice {
        case .untranscribed(let kind): "untranscribed \(kind.rawValue)"
        case .questionExpired: "question expired"
        }
    }

    private var inboxIsEmpty: Bool {
        ((try? FileManager.default.contentsOfDirectory(atPath: inbox.directory.path)) ?? []).isEmpty
    }

    // MARK: - Transcription and routing

    func testGatewayTextBecomesANoteKeyedByTheRef() async throws {
        let record = Record()
        let item = try received(kind: .note, ref: "note-ref")
        let outcome = await pipeline(gateway: .some(spoken), onDevice: nil, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .savedNote(text: spoken, by: .gateway))
        XCTAssertEqual(record.all, ["note note-ref: \(spoken)"], "the ref is the note's idempotency key")
        XCTAssertTrue(inboxIsEmpty)
    }

    func testGatewayTextBecomesAQuestion() async throws {
        let record = Record()
        let question = "When is the ferry on Friday?"
        let item = try received(kind: .ask)
        let outcome = await pipeline(gateway: .some(question), onDevice: nil, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .asked(question: question, by: .gateway))
        XCTAssertEqual(record.all, ["ask: \(question)"])
        XCTAssertTrue(inboxIsEmpty)
    }

    func testGatewayFailureFallsBackToTheDeviceInTheWatchsLocale() async throws {
        let record = Record()
        let item = try received(ref: "fallback")
        let outcome = await pipeline(gateway: .some(nil), onDevice: spoken, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .savedNote(text: spoken, by: .onDevice))
        XCTAssertEqual(record.all, ["on-device en_GB", "note fallback: \(spoken)"])
        XCTAssertTrue(inboxIsEmpty)
    }

    func testGatewayDictationOffTranscribesOnTheDevice() async throws {
        let record = Record()
        let item = try received()
        let outcome = await pipeline(gateway: nil, onDevice: "  \(spoken)\n", record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .savedNote(text: spoken, by: .onDevice))
    }

    /// A recording over the gateway's limit is never uploaded.
    func testOversizeRecordingSkipsTheGateway() async throws {
        let record = Record()
        let item = try received(bytes: 4096)
        let outcome = await pipeline(gateway: .some(spoken), onDevice: "on the phone", record: record, maxAudioBytes: 1024)
            .handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .savedNote(text: "on the phone", by: .onDevice))
    }

    func testNothingTranscribedIsReportedAndNothingKept() async throws {
        let record = Record()
        let item = try received(kind: .ask)
        let outcome = await pipeline(gateway: .some(nil), onDevice: "  ", record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .untranscribed(.ask))
        XCTAssertEqual(record.all, ["on-device en_GB", "notify: untranscribed ask"])
        XCTAssertTrue(inboxIsEmpty)
    }

    // MARK: - Drops

    func testARecordingIsActedOnOnce() async throws {
        let record = Record()
        let item = try received(ref: "repeat")
        let outcome = await pipeline(gateway: .some(spoken), onDevice: nil, record: record, claimed: ["repeat"])
            .handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .dropped(.duplicate))
        XCTAssertTrue(record.all.isEmpty)
        XCTAssertTrue(inboxIsEmpty)
    }

    func testAnOldQuestionIsDroppedAndThePersonTold() async throws {
        let record = Record()
        let item = try received(kind: .ask, capturedAt: now.addingTimeInterval(-WatchRelayQueue.askExpiry - 1))
        let outcome = await pipeline(gateway: .some(spoken), onDevice: nil, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .dropped(.expired))
        XCTAssertEqual(record.all, ["notify: question expired"])
        XCTAssertTrue(inboxIsEmpty)
    }

    /// A note has no age limit: it is saved with its own capture time.
    func testAnOldNoteIsStillSaved() async throws {
        let record = Record()
        let item = try received(kind: .note, capturedAt: now.addingTimeInterval(-WatchRelayQueue.askExpiry * 10))
        let outcome = await pipeline(gateway: .some(spoken), onDevice: nil, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .savedNote(text: spoken, by: .gateway))
    }

    func testMalformedMetadataIsDropped() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let delivered = directory.appendingPathComponent("stray.m4a")
        try Data([1, 2, 3]).write(to: delivered)
        let item = try XCTUnwrap(inbox.admit(file: delivered, metadata: ["voiceKind": "note"]))
        let record = Record()

        let outcome = await pipeline(gateway: .some(spoken), onDevice: nil, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .dropped(.malformed))
        XCTAssertTrue(inboxIsEmpty)
    }

    // MARK: - Interruption and relaunch

    /// A transcript found before the process ended is kept, the recording
    /// deleted, and the next attempt acts on the transcript without
    /// transcribing again.
    func testAResumedItemActsOnItsSavedTranscript() async throws {
        var item = try received(kind: .note, ref: "resumed")
        item.state.attempts = 1
        item.state.transcript = spoken
        item.state.transcribedOnDevice = true
        try inbox.save(item)
        inbox.removeAudio(item)

        let relaunched = WatchVoiceInbox(directory: inbox.directory)
        let leftovers = relaunched.claimLeftovers()
        XCTAssertEqual(leftovers.count, 1)
        let record = Record()
        let outcome = try await pipeline(gateway: .some("not used"), onDevice: nil, record: record)
            .handle(XCTUnwrap(leftovers.first), inbox: relaunched)

        XCTAssertEqual(outcome, .savedNote(text: spoken, by: .onDevice))
        XCTAssertEqual(record.all, ["note resumed: \(spoken)"])
        XCTAssertTrue(inboxIsEmpty)
    }

    /// An item that keeps ending the process is given up, with a notice.
    func testAnItemThatNeverFinishesIsGivenUp() async throws {
        var item = try received(kind: .note)
        item.state.attempts = WatchVoicePipeline.maxAttempts
        try inbox.save(item)
        let record = Record()

        let outcome = await pipeline(gateway: .some(spoken), onDevice: nil, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .dropped(.exhausted))
        XCTAssertEqual(record.all, ["notify: untranscribed note"])
        XCTAssertTrue(inboxIsEmpty)
    }

    /// A scan running while an item is being worked on leaves it alone.
    func testAScanDuringProcessingLeavesTheItemAlone() async throws {
        let item = try received(kind: .note)
        let counted = Record()
        let inbox: WatchVoiceInbox = inbox
        let now = now
        let observing = WatchVoicePipeline(
            gatewayRoute: {
                let saved = inbox.claimLeftovers()
                counted.add("claimable \(saved.count)")
                return nil
            },
            transcribeOnDevice: { _, _ in nil },
            saveNote: { _, _, _ in },
            ask: { _ in },
            notify: { _ in },
            claim: { _ in true },
            now: { now }
        )
        _ = await observing.handle(item, inbox: inbox)

        XCTAssertEqual(counted.all, ["claimable 0"], "an owned item is never claimed by a scan")
        XCTAssertTrue(inboxIsEmpty)
    }

    /// The launch scan and a live admit never both own one recording.
    func testTheLaunchScanSkipsItemsAlreadyOwned() throws {
        let admitted = try received()
        XCTAssertTrue(inbox.claimLeftovers().isEmpty, "the admitting delivery owns it")

        let relaunched = WatchVoiceInbox(directory: inbox.directory)
        let first = relaunched.claimLeftovers()
        XCTAssertEqual(first.map(\.id), [admitted.id])
        XCTAssertTrue(relaunched.claimLeftovers().isEmpty, "claimed once")
    }

    func testOrphanFilesAreSwept() throws {
        try FileManager.default.createDirectory(at: inbox.directory, withIntermediateDirectories: true)
        try Data([1]).write(to: inbox.directory.appendingPathComponent("lonely.m4a"))
        let untranscribed = WatchVoiceInbox.State(metadata: metadata())
        try JSONEncoder().encode(untranscribed).write(to: inbox.directory.appendingPathComponent("silent.json"))

        XCTAssertTrue(inbox.claimLeftovers().isEmpty)
        XCTAssertTrue(inboxIsEmpty)
    }
}
