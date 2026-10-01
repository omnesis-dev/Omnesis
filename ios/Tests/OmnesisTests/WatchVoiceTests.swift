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

    // MARK: - Returning to the watch face

    func testLeavesOnlyOnceTheTransferCarriesTheNoteAndNothingElseRuns() {
        XCTAssertTrue(WatchVoiceDismissal.shouldLeave(showingSent: true, carriedByTransfer: true, otherWorkInFlight: false))
        XCTAssertFalse(
            WatchVoiceDismissal.shouldLeave(showingSent: false, carriedByTransfer: true, otherWorkInFlight: false),
            "a failure, a tap on the confirmation or a new recording keeps the app"
        )
        XCTAssertFalse(
            WatchVoiceDismissal.shouldLeave(showingSent: true, carriedByTransfer: false, otherWorkInFlight: false),
            "a note still waiting for the link keeps the app running to hand it over"
        )
        XCTAssertFalse(
            WatchVoiceDismissal.shouldLeave(showingSent: true, carriedByTransfer: true, otherWorkInFlight: true),
            "an ask, a dictated note or a spoken answer would be cut off"
        )
        XCTAssertGreaterThanOrEqual(WatchVoiceDismissal.confirmationDelay, 1.5)
    }

    // MARK: - Outbox

    private func entry(_ ref: String, queuedAt: Date, failures: Int = 0, lastFailureAt: Date? = nil) -> WatchOutboxPolicy.Entry {
        WatchOutboxPolicy.Entry(
            metadata: WatchVoiceRecording(
                ref: ref,
                captureTime: NoteCaptureTime(capturedAt: queuedAt, timeZoneId: "Europe/London", utcOffsetSeconds: 0),
                locale: "en_GB"
            ).metadata,
            queuedAt: queuedAt,
            failures: failures,
            lastFailureAt: lastFailureAt
        )
    }

    func testEveryWaitingNoteNoTransferCarriesIsSent() {
        let plan = WatchOutboxPolicy.plan(
            [entry("a", queuedAt: now), entry("b", queuedAt: now.addingTimeInterval(-60))],
            carried: ["b"],
            trigger: .linkMayHaveChanged,
            now: now
        )
        XCTAssertEqual(plan, ["a": .send, "b": .wait], "a note already carried is never sent twice")
    }

    func testAFailedNoteWaitsOutItsBackoffOnARetry() {
        let failed = entry("f", queuedAt: now.addingTimeInterval(-600), failures: 1, lastFailureAt: now.addingTimeInterval(-10))
        XCTAssertEqual(WatchOutboxPolicy.plan([failed], carried: [], trigger: .retry, now: now), ["f": .wait])
        let later = now.addingTimeInterval(WatchOutboxPolicy.backoff(afterFailures: 1))
        XCTAssertEqual(WatchOutboxPolicy.plan([failed], carried: [], trigger: .retry, now: later), ["f": .send])
        XCTAssertEqual(
            WatchOutboxPolicy.nextRetry([failed], carried: [], now: now),
            now.addingTimeInterval(-10 + WatchOutboxPolicy.backoff(afterFailures: 1))
        )
    }

    /// The link coming back is worth trying at once, backoff or not.
    func testTheLinkComingBackSendsAFailedNoteAtOnce() {
        let failed = entry("f", queuedAt: now, failures: 3, lastFailureAt: now)
        XCTAssertEqual(WatchOutboxPolicy.plan([failed], carried: [], trigger: .linkMayHaveChanged, now: now), ["f": .send])
    }

    func testBackoffGrowsAndIsBounded() {
        let steps = (1 ... 8).map { WatchOutboxPolicy.backoff(afterFailures: $0) }
        XCTAssertEqual(steps, steps.sorted())
        XCTAssertEqual(steps.first, 30)
        XCTAssertEqual(steps.last, 60 * 60)
    }

    func testNotesPastRetentionOrTheCapAreDropped() {
        let old = entry("old", queuedAt: now.addingTimeInterval(-WatchOutboxPolicy.retention - 1))
        XCTAssertEqual(WatchOutboxPolicy.plan([old], carried: ["old"], trigger: .linkMayHaveChanged, now: now), ["old": .drop])

        let many = (0 ... WatchOutboxPolicy.maxEntries).map { entry("n\($0)", queuedAt: now.addingTimeInterval(TimeInterval(-$0))) }
        let plan = WatchOutboxPolicy.plan(many, carried: [], trigger: .linkMayHaveChanged, now: now)
        XCTAssertEqual(plan["n\(WatchOutboxPolicy.maxEntries)"], .drop, "the oldest beyond the cap")
        XCTAssertEqual(plan["n0"], .send)
        XCTAssertEqual(plan.values.filter { $0 == .drop }.count, 1)
    }

    // MARK: - Notes dictated as text

    private func textEntry(_ ref: String, queuedAt: Date) -> WatchOutboxPolicy.Entry {
        WatchOutboxPolicy.Entry(
            metadata: WatchNoteWire.request(text: "Water the tomatoes", captureTime: .now(date: queuedAt), ref: ref),
            queuedAt: queuedAt
        )
    }

    /// A text note waits in the same outbox as a recording, and goes the
    /// fastest way the link allows.
    func testATextNoteGoesLiveWhenReachableAndQueuedOtherwise() {
        let note = textEntry("t1", queuedAt: now)
        XCTAssertTrue(note.isTextNote)
        XCTAssertEqual(note.ref, "t1")
        XCTAssertEqual(WatchOutboxPolicy.transport(for: note, phoneReachable: true), .liveMessage)
        XCTAssertEqual(WatchOutboxPolicy.transport(for: note, phoneReachable: false), .queuedTransfer)
        let recording = entry("r1", queuedAt: now)
        XCTAssertFalse(recording.isTextNote)
        XCTAssertEqual(WatchOutboxPolicy.transport(for: recording, phoneReachable: true), .file)
    }

    /// A text note carried by a live message or a queued transfer is not
    /// handed over again; the rest follow the same rules as recordings.
    func testTextNotesFollowTheSameOutboxRules() {
        let failed = WatchOutboxPolicy.Entry(
            metadata: WatchNoteWire.request(text: "Book the vet", captureTime: .now(date: now), ref: "t3"),
            queuedAt: now,
            failures: 1,
            lastFailureAt: now
        )
        let plan = WatchOutboxPolicy.plan(
            [
                textEntry("t1", queuedAt: now),
                textEntry("t2", queuedAt: now),
                failed,
                textEntry("old", queuedAt: now.addingTimeInterval(-WatchOutboxPolicy.retention - 1)),
            ],
            carried: ["t2"],
            trigger: .retry,
            now: now
        )
        XCTAssertEqual(plan, ["t1": .send, "t2": .wait, "t3": .wait, "old": .drop])
    }

    // MARK: - The phone saves a note once

    /// A note can reach the phone as a live message and as a queued copy;
    /// both carry its ref, and whichever arrives second is dropped.
    func testTheLiveAndQueuedCopiesOfANoteAreSavedOnce() {
        let message = WatchNoteWire.request(text: "Water the tomatoes", captureTime: .now(date: now), ref: "shared-ref")
        let queued = WatchRelayQueue.queued(message, envelope: .init(queuedAt: now, attempts: 0, lastErrorCode: nil))

        var liveFirst = WatchRelayRecentRefs()
        XCTAssertTrue(liveFirst.insert(WatchNoteWire.ref(from: message)), "the live copy is saved")
        XCTAssertEqual(WatchRelayInbox.route(queued: queued, now: now, handled: &liveFirst), .drop(.duplicate))

        var queuedFirst = WatchRelayRecentRefs()
        XCTAssertEqual(
            WatchRelayInbox.route(queued: queued, now: now, handled: &queuedFirst),
            .saveNote(text: "Water the tomatoes", captureTime: .now(date: now))
        )
        XCTAssertFalse(queuedFirst.insert(WatchNoteWire.ref(from: message)), "the live copy is answered, not saved")
    }
}
