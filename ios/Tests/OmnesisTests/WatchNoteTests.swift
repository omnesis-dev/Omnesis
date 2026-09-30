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

    /// The reply tags are what watch builds already in use read, so they
    /// stay as they are.
    func testReplyTagsAreStable() {
        let tags: [WatchNoteOutcome: String] = [
            .saved: "saved", .queuedOnPhone: "queuedOnPhone", .rejected: "rejected",
            .captureFailed: "captureFailed", .reachedPhone: "reachedPhone", .relayFailed: "relayFailed",
        ]
        for (outcome, tag) in tags {
            XCTAssertEqual(WatchNoteWire.reply(for: outcome), ["outcome": tag])
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
