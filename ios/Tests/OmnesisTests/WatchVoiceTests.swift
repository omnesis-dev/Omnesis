// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The contract between the watch and the iPhone for gateway dictation on
/// the watch: the gate the phone publishes in the application context, and
/// the metadata a recording travels with.
final class WatchVoiceTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    // MARK: - Gate

    func testGateRoundTripsThroughTheApplicationContext() throws {
        let gate = WatchDictationGate(active: true, maxAudioBytes: 26_214_400, updatedAt: now)
        let decoded = try XCTUnwrap(WatchDictationGate(applicationContext: gate.applicationContext))
        XCTAssertEqual(decoded.active, true)
        XCTAssertEqual(decoded.maxAudioBytes, 26_214_400)
        XCTAssertEqual(decoded.updatedAt.timeIntervalSince1970, now.timeIntervalSince1970, accuracy: 0.001)
    }

    func testMissingOrUnreadableGateIsNone() {
        XCTAssertNil(WatchDictationGate(applicationContext: [:]))
        XCTAssertNil(WatchDictationGate(applicationContext: ["dictationGate": ["active": "1"]]))
        XCTAssertNil(WatchDictationGate(applicationContext: ["dictationGate": "on"]))
    }

    func testActiveGateRecordsUpToTheWatchCap() {
        let gate = WatchDictationGate(active: true, maxAudioBytes: 26_214_400, updatedAt: now)
        XCTAssertEqual(gate.recordingLimit(now: now), WatchVoiceFormat.maxDuration)
        XCTAssertEqual(WatchVoiceFormat.maxDuration, 120)
    }

    func testSmallByteLimitShortensTheRecording() throws {
        // 90 000 bytes: nine tenths of it at 24 kbps is 27 seconds.
        let gate = WatchDictationGate(active: true, maxAudioBytes: 90000, updatedAt: now)
        XCTAssertEqual(try XCTUnwrap(gate.recordingLimit(now: now)), 27, accuracy: 0.001)
    }

    func testSystemDictationWhenTheGateSaysSo() {
        XCTAssertNil(WatchDictationGate(active: false, maxAudioBytes: 26_214_400, updatedAt: now).recordingLimit(now: now))
        XCTAssertNil(WatchDictationGate(active: true, maxAudioBytes: 0, updatedAt: now).recordingLimit(now: now))
        XCTAssertNil(WatchDictationGate(active: true, maxAudioBytes: 10, updatedAt: now).recordingLimit(now: now))
        let stale = WatchDictationGate(
            active: true,
            maxAudioBytes: 26_214_400,
            updatedAt: now.addingTimeInterval(-WatchDictationGate.staleAfter - 1)
        )
        XCTAssertNil(stale.recordingLimit(now: now), "a gate the phone stopped refreshing is not trusted")
    }

    // MARK: - Recording metadata

    private func recording(locale: String? = "en_GB") -> WatchVoiceRecording {
        WatchVoiceRecording(
            ref: "3b7c2f0e-8a41-4d7e-9f52-1c6a0e5d9b21",
            captureTime: NoteCaptureTime(capturedAt: now, timeZoneId: "Europe/Paris", utcOffsetSeconds: 7200),
            locale: locale
        )
    }

    func testMetadataRoundTrips() throws {
        let original = recording()
        let decoded = try XCTUnwrap(WatchVoiceRecording(metadata: original.metadata))
        XCTAssertEqual(decoded.ref, original.ref)
        XCTAssertEqual(decoded.captureTime.timeZoneId, "Europe/Paris")
        XCTAssertEqual(decoded.captureTime.utcOffsetSeconds, 7200)
        XCTAssertEqual(decoded.captureTime.capturedAt.timeIntervalSince1970, now.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(decoded.locale, "en_GB")
    }

    func testLocaleIsOptional() throws {
        let decoded = try XCTUnwrap(WatchVoiceRecording(metadata: recording(locale: nil).metadata))
        XCTAssertNil(decoded.locale)
    }

    func testIncompleteMetadataIsRejected() {
        let full = recording().metadata
        for key in ["voiceKind", "ref", "capturedAt", "capturedTimeZoneId", "capturedUtcOffsetSeconds"] {
            var partial = full
            partial.removeValue(forKey: key)
            XCTAssertNil(WatchVoiceRecording(metadata: partial), "missing \(key)")
        }
        var unknownKind = full
        unknownKind["voiceKind"] = "ask"
        XCTAssertNil(WatchVoiceRecording(metadata: unknownKind))
    }
}
