// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class ActivitySegmentsCursorTests: XCTestCase {
    func testDecodeEmptyCursorGivesDefaults() {
        let cursor = ActivitySegmentsCursor.decode(from: nil)
        XCTAssertNil(cursor.lastConfirmedStart)
    }

    func testRoundTripViaSyncCursor() {
        let start = Date(timeIntervalSinceReferenceDate: 800_000_000)
        let cursor = ActivitySegmentsCursor(lastConfirmedStart: start)
        let decoded = ActivitySegmentsCursor.decode(from: cursor.encode())
        // ISO 8601 with fractional seconds round-trips to millisecond precision.
        let decodedInterval = decoded.lastConfirmedStart?.timeIntervalSinceReferenceDate ?? 0
        XCTAssertEqual(decodedInterval, start.timeIntervalSinceReferenceDate, accuracy: 0.001)
    }

    func testEncodeWithNoWatermarkProducesEmptyCursor() {
        let cursor = ActivitySegmentsCursor()
        XCTAssertTrue(cursor.encode().isEmpty)
    }

    func testMalformedFieldFallsBackToDefaults() {
        let raw: SyncCursor = ["lastConfirmedStart": .int(42)]
        let cursor = ActivitySegmentsCursor.decode(from: raw)
        XCTAssertNil(cursor.lastConfirmedStart)
    }

    func testPendingSegmentsRoundTripViaSyncCursor() {
        let start = Date(timeIntervalSinceReferenceDate: 800_000_000)
        let segment = ActivitySegment(type: .walking, start: start, end: start.addingTimeInterval(600), confidence: .medium)
        let cursor = ActivitySegmentsCursor(lastConfirmedStart: start, pendingSegments: [segment])

        let decoded = ActivitySegmentsCursor.decode(from: cursor.encode())

        XCTAssertEqual(decoded.pendingSegments.count, 1)
        let roundTripped = decoded.pendingSegments[0]
        XCTAssertEqual(roundTripped.type, .walking)
        XCTAssertEqual(roundTripped.confidence, .medium)
        XCTAssertEqual(roundTripped.start.timeIntervalSinceReferenceDate, segment.start.timeIntervalSinceReferenceDate, accuracy: 0.001)
        XCTAssertEqual(roundTripped.end.timeIntervalSinceReferenceDate, segment.end.timeIntervalSinceReferenceDate, accuracy: 0.001)
    }

    func testMalformedPendingSegmentsArrayIsDroppedNotCrashed() {
        let raw: SyncCursor = ["pendingSegments": .array([.object(["type": .string("not-a-real-type")])])]
        let cursor = ActivitySegmentsCursor.decode(from: raw)
        XCTAssertTrue(cursor.pendingSegments.isEmpty)
    }
}
