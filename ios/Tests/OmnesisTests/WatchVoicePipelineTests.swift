// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

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

/// The iPhone side of a watch note recorded for gateway dictation: it is
/// kept in the inbox, transcribed on the device for the text shown at once,
/// and saved as a voice note under its ref. The inbox is empty afterwards on
/// every path, and an interrupted item resumes from where it got to.
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

    private func metadata(ref: String) -> [String: String] {
        WatchVoiceRecording(
            ref: ref,
            captureTime: NoteCaptureTime(capturedAt: now, timeZoneId: "Europe/London", utcOffsetSeconds: 0),
            locale: "en_GB"
        ).metadata
    }

    /// A recording as WatchConnectivity hands it over, admitted to the inbox.
    private func received(ref: String = UUID().uuidString) throws -> WatchVoiceInbox.Item {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let delivered = directory.appendingPathComponent("\(UUID().uuidString).m4a")
        try Data(repeating: 0x2A, count: 4096).write(to: delivered)
        let item = try XCTUnwrap(inbox.admit(file: delivered, metadata: metadata(ref: ref)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: delivered.path), "moved out of the WatchConnectivity inbox")
        return item
    }

    /// The pipeline, saving by consuming the recording the way the note
    /// pipeline does.
    private func pipeline(
        onDevice: String?,
        record: Record,
        saves: Bool = true,
        claimed: Set<String> = []
    )
        -> WatchVoicePipeline {
        WatchVoicePipeline(
            transcribeOnDevice: { _, locale in
                record.add("on-device \(locale ?? "-")")
                return onDevice
            },
            saveVoiceNote: { text, _, id, audio in
                let bytes = (try? Data(contentsOf: audio.file))?.count ?? 0
                record.add("voice note \(id) [\(text)] \(bytes) bytes \(audio.locale ?? "-")")
                try? FileManager.default.removeItem(at: audio.file)
                return saves
            },
            notify: { record.add($0 == .voiceNoteFailed ? "notify: failed" : "notify: other") },
            claim: { !claimed.contains($0) }
        )
    }

    private var inboxIsEmpty: Bool {
        ((try? FileManager.default.contentsOfDirectory(atPath: inbox.directory.path)) ?? []).isEmpty
    }

    func testTheDevicesTranscriptRidesTheVoiceNote() async throws {
        let record = Record()
        let item = try received(ref: "note-ref")
        let outcome = await pipeline(onDevice: "  \(spoken)\n", record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .saved(text: spoken))
        XCTAssertEqual(record.all, ["on-device en_GB", "voice note note-ref [\(spoken)] 4096 bytes en_GB"])
        XCTAssertTrue(inboxIsEmpty)
    }

    /// The phone heard nothing: the recording still goes, with no text, and
    /// the gateway shows a placeholder until its transcript lands.
    func testNothingHeardOnTheDeviceStillSendsTheRecording() async throws {
        let record = Record()
        let item = try received(ref: "silent")
        let outcome = await pipeline(onDevice: nil, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .saved(text: ""))
        XCTAssertEqual(record.all, ["on-device en_GB", "voice note silent [] 4096 bytes en_GB"])
        XCTAssertTrue(inboxIsEmpty)
    }

    func testANoteThatCannotBeKeptIsReported() async throws {
        let record = Record()
        let item = try received(ref: "lost")
        let outcome = await pipeline(onDevice: spoken, record: record, saves: false).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(record.all.last, "notify: failed")
        XCTAssertTrue(inboxIsEmpty)
    }

    func testARecordingIsSavedOnce() async throws {
        let record = Record()
        let item = try received(ref: "repeat")
        let outcome = await pipeline(onDevice: spoken, record: record, claimed: ["repeat"]).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .dropped(.duplicate))
        XCTAssertTrue(record.all.isEmpty)
        XCTAssertTrue(inboxIsEmpty)
    }

    func testMalformedMetadataIsDropped() async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let delivered = directory.appendingPathComponent("stray.m4a")
        try Data([1, 2, 3]).write(to: delivered)
        let item = try XCTUnwrap(inbox.admit(file: delivered, metadata: ["voiceKind": "note"]))
        let record = Record()

        let outcome = await pipeline(onDevice: spoken, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .dropped(.malformed))
        XCTAssertTrue(record.all.isEmpty)
        XCTAssertTrue(inboxIsEmpty)
    }

    // MARK: - Interruption and relaunch

    /// A transcript found before the process ended is kept, and the next
    /// attempt saves with it without transcribing again.
    func testAResumedItemSavesWithItsSavedTranscript() async throws {
        var item = try received(ref: "resumed")
        item.state.attempts = 1
        item.state.transcript = spoken
        try inbox.save(item)

        let relaunched = WatchVoiceInbox(directory: inbox.directory)
        let leftovers = relaunched.claimLeftovers()
        XCTAssertEqual(leftovers.count, 1)
        let record = Record()
        let outcome = try await pipeline(onDevice: "not used", record: record)
            .handle(XCTUnwrap(leftovers.first), inbox: relaunched)

        XCTAssertEqual(outcome, .saved(text: spoken))
        XCTAssertEqual(record.all, ["voice note resumed [\(spoken)] 4096 bytes en_GB"])
        XCTAssertTrue(inboxIsEmpty)
    }

    /// An item that keeps ending the process is given up, with a notice.
    func testAnItemThatNeverFinishesIsGivenUp() async throws {
        var item = try received()
        item.state.attempts = WatchVoicePipeline.maxAttempts
        try inbox.save(item)
        let record = Record()

        let outcome = await pipeline(onDevice: spoken, record: record).handle(item, inbox: inbox)

        XCTAssertEqual(outcome, .dropped(.exhausted))
        XCTAssertEqual(record.all, ["notify: failed"])
        XCTAssertTrue(inboxIsEmpty)
    }

    /// A scan running while an item is being worked on leaves it alone.
    func testAScanDuringProcessingLeavesTheItemAlone() async throws {
        let item = try received()
        let counted = Record()
        let inbox: WatchVoiceInbox = inbox
        let observing = WatchVoicePipeline(
            transcribeOnDevice: { _, _ in
                counted.add("claimable \(inbox.claimLeftovers().count)")
                return nil
            },
            saveVoiceNote: { _, _, _, _ in true },
            notify: { _ in },
            claim: { _ in true }
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
        XCTAssertEqual(relaunched.claimLeftovers().map(\.id), [admitted.id])
        XCTAssertTrue(relaunched.claimLeftovers().isEmpty, "claimed once")
    }

    func testOrphanFilesAreSwept() throws {
        try FileManager.default.createDirectory(at: inbox.directory, withIntermediateDirectories: true)
        try Data([1]).write(to: inbox.directory.appendingPathComponent("lonely.m4a"))
        let state = WatchVoiceInbox.State(metadata: metadata(ref: "gone"), transcript: spoken)
        try JSONEncoder().encode(state).write(to: inbox.directory.appendingPathComponent("handed-over.json"))

        XCTAssertTrue(inbox.claimLeftovers().isEmpty)
        XCTAssertTrue(inboxIsEmpty)
    }
}
