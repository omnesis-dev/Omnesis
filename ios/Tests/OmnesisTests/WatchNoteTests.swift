// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class WatchNoteTests: XCTestCase {
    // MARK: - Wire

    func testRequestCarriesTheNoteUnderTheNoteKind() {
        let captureTime = NoteCaptureTime(
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000.25),
            timeZoneId: "Europe/London",
            utcOffsetSeconds: 3600
        )
        let msg = WatchNoteWire.request(text: "Buy oat milk", captureTime: captureTime, ref: "n1")
        XCTAssertEqual(msg["kind"], "note")
        XCTAssertEqual(msg["text"], "Buy oat milk")
        XCTAssertEqual(WatchNoteWire.captureTime(from: msg), captureTime)
        XCTAssertEqual(WatchNoteWire.ref(from: msg), "n1")
    }

    /// A note from a watch build that predates refs still reads, ref-less.
    func testANoteWithoutARefStillReads() {
        let msg: [String: Any] = ["kind": "note", "text": "Buy oat milk"]
        XCTAssertEqual(WatchNoteWire.text(from: msg), "Buy oat milk")
        XCTAssertNil(WatchNoteWire.ref(from: msg))
    }

    func testTextFromExtractsAndTrims() {
        XCTAssertEqual(
            WatchNoteWire.text(from: ["kind": "note", "text": "  spaced  "]),
            "spaced"
        )
    }

    func testTextFromRejectsNonNoteMessages() {
        // An ask message must not be read as a note (the phone routes by kind).
        XCTAssertNil(WatchNoteWire.text(from: ["kind": "ask", "question": "what's up"]))
        XCTAssertNil(WatchNoteWire.text(from: ["text": "no kind"]))
        XCTAssertNil(WatchNoteWire.text(from: ["kind": "note", "text": "   "]))
        XCTAssertNil(WatchNoteWire.text(from: [:]))
    }

    func testCaptureTimeRejectsIncompleteRelayMetadata() {
        XCTAssertNil(WatchNoteWire.captureTime(from: ["capturedAt": "2026-08-15T10:00:00Z"]))
    }

    func testCaptureTimeRejectsImpossibleUtcOffset() {
        XCTAssertNil(WatchNoteWire.captureTime(from: [
            "capturedAt": "2026-08-15T10:00:00Z",
            "capturedTimeZoneId": "Etc/UTC",
            "capturedUtcOffsetSeconds": "64801",
        ]))
    }

    func testReplyOutcomeRoundTripsEveryCase() {
        let all: [WatchNoteOutcome] = [
            .saved, .queuedOnPhone, .rejected, .captureFailed, .reachedPhone,
            .phoneUnreachable, .watchLinkInactive, .relayFailed, .queuedForPhone,
        ]
        for outcome in all {
            let reply = WatchNoteWire.reply(for: outcome)
            XCTAssertEqual(WatchNoteWire.outcome(from: reply), outcome, "round-trip failed for \(outcome)")
        }
    }

    func testUnknownOrMissingOutcomeTagFallsBackToRelayFailed() {
        XCTAssertEqual(WatchNoteWire.outcome(from: ["outcome": "bogus"]), .relayFailed)
        XCTAssertEqual(WatchNoteWire.outcome(from: [:]), .relayFailed)
    }

    // MARK: - Outcome

    func testKindClassification() {
        XCTAssertEqual(WatchNoteOutcome.saved.kind, .success)
        // Saved-but-unconfirmed and queued are statuses, never failures —
        // neither should nudge the user into re-dictating a duplicate.
        XCTAssertEqual(WatchNoteOutcome.queuedOnPhone.kind, .status)
        XCTAssertEqual(WatchNoteOutcome.reachedPhone.kind, .status)
        XCTAssertEqual(WatchNoteOutcome.queuedForPhone.kind, .status)
        for failure in [WatchNoteOutcome.rejected, .captureFailed, .phoneUnreachable, .watchLinkInactive, .relayFailed] {
            XCTAssertEqual(failure.kind, .failure, "\(failure) should read as failure")
        }
    }

    func testEveryOutcomeHasNonEmptySpokenCopy() {
        let all: [WatchNoteOutcome] = [
            .saved, .queuedOnPhone, .rejected, .captureFailed, .reachedPhone,
            .phoneUnreachable, .watchLinkInactive, .relayFailed, .queuedForPhone,
        ]
        for outcome in all {
            XCTAssertFalse(WatchNoteDialog.text(for: outcome).isEmpty, "no copy for \(outcome)")
        }
    }

    // MARK: - Capture → outcome mapping

    func testCaptureOutcomeMapping() {
        XCTAssertEqual(WatchNoteOutcome(capture: .saved), .saved)
        XCTAssertEqual(WatchNoteOutcome(capture: .queued(.unreachable)), .queuedOnPhone)
        XCTAssertEqual(WatchNoteOutcome(capture: .queued(.featureOff)), .queuedOnPhone)
        XCTAssertEqual(WatchNoteOutcome(capture: .queued(.unauthorized)), .queuedOnPhone)
        XCTAssertEqual(WatchNoteOutcome(capture: .rejected("too long")), .rejected)
        XCTAssertEqual(WatchNoteOutcome(capture: .failed("disk full")), .captureFailed)
    }
}
