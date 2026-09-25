// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AppleHealthCursorTests: XCTestCase {
    func testDecodeEmptyCursorGivesDefaults() {
        let c = AppleHealthCursor.decode(from: nil)
        XCTAssertEqual(c.cycleIndex, 0)
        XCTAssertTrue(c.anchorsByIdentifier.isEmpty)
        XCTAssertNil(c.lastCycleCompletedAt)
    }

    func testRoundTripViaSyncCursor() {
        var c = AppleHealthCursor(cycleIndex: 7)
        c.setAnchor("base64-blob-a", for: "HKQuantityTypeIdentifierBodyMass")
        c.setAnchor("base64-blob-b", for: "HKQuantityTypeIdentifierStepCount")
        c.lastCycleCompletedAt = "2026-04-18T12:34:56.789Z"

        let encoded = c.encode()
        let decoded = AppleHealthCursor.decode(from: encoded)

        XCTAssertEqual(decoded.cycleIndex, 7)
        XCTAssertEqual(decoded.anchor(for: "HKQuantityTypeIdentifierBodyMass"), "base64-blob-a")
        XCTAssertEqual(decoded.anchor(for: "HKQuantityTypeIdentifierStepCount"), "base64-blob-b")
        XCTAssertEqual(decoded.lastCycleCompletedAt, "2026-04-18T12:34:56.789Z")
    }

    func testSetAnchorNilRemoves() {
        var c = AppleHealthCursor()
        c.setAnchor("x", for: "A")
        c.setAnchor(nil, for: "A")
        XCTAssertNil(c.anchor(for: "A"))
    }

    func testMalformedFieldsFallBackToDefaults() {
        let raw: SyncCursor = [
            "cycleIndex": .string("not-a-number"),
            "anchorsByIdentifier": .array([]), // wrong type
            "lastCycleCompletedAt": .int(42),
        ]
        let c = AppleHealthCursor.decode(from: raw)
        XCTAssertEqual(c.cycleIndex, 0)
        XCTAssertTrue(c.anchorsByIdentifier.isEmpty)
        XCTAssertNil(c.lastCycleCompletedAt)
    }
}
