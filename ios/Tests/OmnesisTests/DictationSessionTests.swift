// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A gateway transcriber that answers from a script and records what it
/// was sent.
private final class ScriptedTranscriber: DictationTranscribing, @unchecked Sendable {
    enum Script {
        case text(String)
        case failure(Error)
        /// Waits until cancelled, like an upload still in flight.
        case hang
    }

    struct Call {
        let bytes: Int
        let contentType: String
        let language: String?
    }

    let script: Script
    private(set) var calls: [Call] = []

    init(_ script: Script) {
        self.script = script
    }

    func transcribe(audio: Data, contentType: String, language: String?) async throws -> DictationTranscription {
        calls.append(Call(bytes: audio.count, contentType: contentType, language: language))
        switch script {
        case .text(let text):
            return DictationTranscription(text: text)
        case .failure(let error):
            throw error
        case .hang:
            try await Task.sleep(for: .seconds(60))
            return DictationTranscription(text: "too late")
        }
    }
}

/// The dictation state machine, driven the way the mic adapter drives it but
/// with no microphone: a scripted gateway transcriber and a temporary file
/// standing in for the recording.
///
/// The fallback rule under test: the on-device draft is always there, so any
/// gateway failure keeps it, and the recording never outlives the session.
@MainActor
final class DictationSessionTests: XCTestCase {
    private let draft = "book the dentist for thirsty"
    private let refined = "Book the dentist for Thursday."

    private func makeRecording(bytes: Int = 2048) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("dictation-test-\(UUID().uuidString).m4a")
        try Data(repeating: 0x2A, count: bytes).write(to: url)
        return url
    }

    private func route(_ transcriber: ScriptedTranscriber, maxAudioBytes: Int = 1_000_000) -> GatewayDictationRoute {
        GatewayDictationRoute(transcriber: transcriber, maxAudioBytes: maxAudioBytes)
    }

    /// Lets a cancelled refinement task run to its end, where it would write
    /// if its guard were wrong.
    private func yieldToAbandonedWork() async {
        for _ in 0 ..< 20 {
            await Task.yield()
        }
        try? await Task.sleep(for: .milliseconds(50))
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    /// Record, speak, stop, and let the on-device final arrive.
    private func dictate(
        _ session: DictationSession,
        route: GatewayDictationRoute?,
        recording: URL?
    ) {
        session.begin(route: route)
        session.recognized("book the")
        session.recognized(draft)
        session.stop(recording: recording)
        session.recognitionEnded()
    }

    // MARK: - Gateway refinement

    func testGatewayTextReplacesTheDraft() async throws {
        let transcriber = ScriptedTranscriber(.text("  \(refined)\n"))
        let session = DictationSession(language: "en")
        let recording = try makeRecording()

        dictate(session, route: route(transcriber), recording: recording)
        XCTAssertEqual(session.state, .refining)
        XCTAssertEqual(session.transcript, draft, "the draft stays visible while the gateway works")
        XCTAssertTrue(session.routesToGateway)

        await session.refinementSettled()

        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(session.transcript, refined)
        XCTAssertFalse(session.usedOnDeviceFallback)
        XCTAssertEqual(transcriber.calls.count, 1)
        XCTAssertEqual(transcriber.calls.first?.bytes, 2048)
        XCTAssertEqual(transcriber.calls.first?.contentType, "audio/mp4")
        XCTAssertEqual(transcriber.calls.first?.language, "en")
        XCTAssertFalse(exists(recording), "the recording is deleted once transcribed")
        XCTAssertFalse(session.routesToGateway, "cleared once settled")
    }

    func testGatewayFailureKeepsTheDraftAndSaysSo() async throws {
        let transcriber = ScriptedTranscriber(.failure(DictationTranscribeError.transcriberUnavailable("down")))
        let session = DictationSession(language: "en")
        let recording = try makeRecording()

        dictate(session, route: route(transcriber), recording: recording)
        await session.refinementSettled()

        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(session.transcript, draft)
        XCTAssertTrue(session.usedOnDeviceFallback)
        XCTAssertFalse(exists(recording))
    }

    func testNetworkFailureKeepsTheDraft() async throws {
        let transcriber = ScriptedTranscriber(.failure(URLError(.timedOut)))
        let session = DictationSession(language: "en")
        let recording = try makeRecording()

        dictate(session, route: route(transcriber), recording: recording)
        await session.refinementSettled()

        XCTAssertEqual(session.transcript, draft)
        XCTAssertTrue(session.usedOnDeviceFallback)
    }

    func testRecordingOverTheLimitIsNeverSent() async throws {
        let transcriber = ScriptedTranscriber(.text(refined))
        let session = DictationSession(language: "en")
        let recording = try makeRecording(bytes: 4096)

        dictate(session, route: route(transcriber, maxAudioBytes: 1024), recording: recording)
        await session.refinementSettled()

        XCTAssertTrue(transcriber.calls.isEmpty)
        XCTAssertEqual(session.transcript, draft)
        XCTAssertTrue(session.usedOnDeviceFallback)
        XCTAssertFalse(exists(recording))
    }

    func testSilentGatewayResultKeepsTheDraft() async throws {
        let transcriber = ScriptedTranscriber(.text("   "))
        let session = DictationSession(language: "en")

        try dictate(session, route: route(transcriber), recording: makeRecording())
        await session.refinementSettled()

        XCTAssertEqual(session.transcript, draft)
        XCTAssertTrue(session.usedOnDeviceFallback)
    }

    /// Nothing heard on the device either: there is no draft to have fallen
    /// back to, so there is nothing to mention.
    func testFailureWithAnEmptyDraftRaisesNoNote() async throws {
        let transcriber = ScriptedTranscriber(.failure(URLError(.notConnectedToInternet)))
        let session = DictationSession(language: "en")

        session.begin(route: route(transcriber))
        try session.stop(recording: makeRecording())
        session.recognitionEnded()
        await session.refinementSettled()

        XCTAssertEqual(session.transcript, "")
        XCTAssertFalse(session.usedOnDeviceFallback)
    }

    // MARK: - Cancel

    func testCancelDuringRefinementDropsEverything() async throws {
        let transcriber = ScriptedTranscriber(.hang)
        let session = DictationSession(language: "en")
        let recording = try makeRecording()

        dictate(session, route: route(transcriber), recording: recording)
        XCTAssertEqual(session.state, .refining)

        session.cancel()

        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(session.transcript, "")
        XCTAssertFalse(exists(recording), "cancel deletes the recording at once")
        await yieldToAbandonedWork()
        XCTAssertEqual(session.transcript, "", "a late answer never lands after a cancel")
        XCTAssertFalse(session.usedOnDeviceFallback)
    }

    func testCancelWhileListeningDeletesTheRecordingHandedOver() throws {
        let session = DictationSession(language: "en")
        let recording = try makeRecording()
        session.begin(route: route(ScriptedTranscriber(.text(refined))))
        session.recognized(draft)
        session.stop(recording: recording)

        session.cancel()

        XCTAssertEqual(session.state, .idle)
        XCTAssertFalse(exists(recording))
    }

    /// A refinement abandoned by a restart must not write into the session
    /// that replaced it.
    func testAbandonedRefinementCannotReachTheNextSession() async throws {
        let session = DictationSession(language: "en")
        try dictate(session, route: route(ScriptedTranscriber(.hang)), recording: makeRecording())

        session.cancel()
        session.begin(route: nil)
        session.recognized("second thought")
        await yieldToAbandonedWork()

        XCTAssertEqual(session.state, .listening)
        XCTAssertEqual(session.transcript, "second thought")
    }

    // MARK: - On-device paths

    func testWithoutARouteTheDraftIsFinal() throws {
        let session = DictationSession(language: "en")
        let stray = try makeRecording()

        dictate(session, route: nil, recording: stray)

        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(session.transcript, draft)
        XCTAssertFalse(session.routesToGateway)
        XCTAssertFalse(exists(stray), "a recording with nowhere to go is deleted")
    }

    /// Recording for the gateway failed: the on-device text stands, and the
    /// person is told, since they expected the gateway's.
    func testFailedRecordingKeepsTheDraftAndSaysSo() {
        let transcriber = ScriptedTranscriber(.text(refined))
        let session = DictationSession(language: "en")

        dictate(session, route: route(transcriber), recording: nil)

        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(session.transcript, draft)
        XCTAssertTrue(transcriber.calls.isEmpty)
        XCTAssertTrue(session.usedOnDeviceFallback)
        XCTAssertFalse(session.routesToGateway)
    }

    /// An on-device session whose recognizer ends on its own ends with what
    /// it heard.
    func testRecognizerEndingOnItsOwnEndsAnOnDeviceSession() {
        let session = DictationSession(language: "en")

        session.begin(route: nil)
        session.recognized(draft)
        session.recognitionEnded()

        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(session.transcript, draft)
    }

    /// A gateway session outlives its recognizer: it keeps recording, and the
    /// person's stop still sends the whole recording.
    func testGatewaySessionKeepsRecordingWhenTheRecognizerEnds() async throws {
        let transcriber = ScriptedTranscriber(.text(refined))
        let session = DictationSession(language: "en")
        let recording = try makeRecording()

        session.begin(route: route(transcriber))
        session.recognized(draft)
        session.recognitionEnded()
        XCTAssertEqual(session.state, .listening)
        XCTAssertFalse(session.hasLiveDraft)

        session.stop(recording: recording)
        XCTAssertEqual(session.state, .refining, "no recognizer final to wait for")
        await session.refinementSettled()

        XCTAssertEqual(session.transcript, refined)
        XCTAssertEqual(transcriber.calls.count, 1)
    }

    /// Speech recognition denied or unsupported: the gateway session records
    /// without a draft and goes straight to the gateway on stop.
    func testGatewaySessionWithoutARecognizer() async throws {
        let transcriber = ScriptedTranscriber(.text(refined))
        let session = DictationSession(language: "en")

        session.begin(route: route(transcriber), liveDraft: false)
        XCTAssertEqual(session.state, .listening)
        XCTAssertEqual(session.transcript, "")
        try session.stop(recording: makeRecording())
        XCTAssertEqual(session.state, .refining)
        await session.refinementSettled()

        XCTAssertEqual(session.transcript, refined)
        XCTAssertFalse(session.routesToGateway, "cleared once settled")
    }

    // MARK: - Use draft

    func testUseDraftKeepsTheDraftAndDropsTheUpload() async throws {
        let session = DictationSession(language: "en")
        let recording = try makeRecording()
        dictate(session, route: route(ScriptedTranscriber(.hang)), recording: recording)

        session.useDraft()

        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(session.transcript, draft)
        XCTAssertTrue(session.skippedRefinement)
        XCTAssertFalse(session.usedOnDeviceFallback, "the person chose the draft; nothing failed")
        XCTAssertFalse(exists(recording))
        await yieldToAbandonedWork()
        XCTAssertEqual(session.transcript, draft, "a late answer never lands after Use draft")

        session.begin(route: nil)
        XCTAssertFalse(session.skippedRefinement)
    }

    func testUseDraftOnlyAppliesWhileRefining() {
        let session = DictationSession(language: "en")
        session.begin(route: nil)
        session.recognized(draft)

        session.useDraft()

        XCTAssertEqual(session.state, .listening)
    }

    func testPartialsAfterTheDraftIsWithTheGatewayAreIgnored() throws {
        let session = DictationSession(language: "en")
        try dictate(session, route: route(ScriptedTranscriber(.hang)), recording: makeRecording())

        session.recognized("stray late partial")

        XCTAssertEqual(session.transcript, draft)
        session.cancel()
    }

    func testNextSessionClearsTheFallbackNote() async throws {
        let session = DictationSession(language: "en")
        try dictate(session, route: route(ScriptedTranscriber(.failure(URLError(.timedOut)))), recording: makeRecording())
        await session.refinementSettled()
        XCTAssertTrue(session.usedOnDeviceFallback)

        session.begin(route: nil)

        XCTAssertFalse(session.usedOnDeviceFallback)
        XCTAssertEqual(session.transcript, "")
    }

    func testUnavailableIsStickyThroughCancel() {
        let session = DictationSession(language: "en")
        session.markUnavailable()
        session.cancel()
        XCTAssertEqual(session.state, .unavailable)
    }

    func testWrappingUpCoversBothWaits() {
        XCTAssertTrue(DictationState.finishing.isWrappingUp)
        XCTAssertTrue(DictationState.refining.isWrappingUp)
        XCTAssertFalse(DictationState.listening.isWrappingUp)
        XCTAssertFalse(DictationState.idle.isWrappingUp)
        XCTAssertFalse(DictationState.unavailable.isWrappingUp)
    }

    // MARK: - Recording budget

    func testLongRecordingsStopAtTheDurationCap() {
        let seconds = DictationRecordingFormat.maxDuration(forMaxAudioBytes: 25 * 1024 * 1024, bitRate: 64000)
        XCTAssertEqual(seconds, DictationRecordingFormat.maxRecordingDuration)
        XCTAssertEqual(DictationRecordingFormat.maxRecordingDuration, 300)
    }

    func testSmallLimitsStopUnderTheGatewayLimit() {
        let limit = 1_000_000
        let seconds = DictationRecordingFormat.maxDuration(forMaxAudioBytes: limit, bitRate: 64000)
        XCTAssertLessThan(seconds * 64000 / 8, Double(limit))
        XCTAssertLessThan(seconds, DictationRecordingFormat.maxRecordingDuration)
        XCTAssertEqual(DictationRecordingFormat.maxDuration(forMaxAudioBytes: 0, bitRate: 64000), 0)
    }

    /// The encoder's offer decides: the preferred rate when it is there,
    /// the highest below it for a narrowband input.
    func testBitRateComesFromTheEncodersOffer() {
        XCTAssertEqual(DictationRecordingFormat.bitRate(choosingFrom: [32000, 48000, 64000, 96000]), 64000)
        XCTAssertEqual(DictationRecordingFormat.bitRate(choosingFrom: [8000, 12000, 16000, 20000, 24000]), 24000)
        XCTAssertEqual(DictationRecordingFormat.bitRate(choosingFrom: [96000, 128_000]), 96000)
        XCTAssertNil(DictationRecordingFormat.bitRate(choosingFrom: []))
    }
}
