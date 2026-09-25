// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PhotosCursorTests: XCTestCase {
    func testDefaultCursorStartsAtScreenshotsPhase() {
        let cursor = PhotosCursor.decode(from: nil)
        XCTAssertEqual(cursor.phase, .screenshots)
        XCTAssertNil(cursor.lastAssetId)
        XCTAssertNil(cursor.backfillCompletedAt)
    }

    func testPhaseOrderIsScreenshotsThenRecentThenBackfillThenSteady() {
        XCTAssertEqual(PhotosCursor(phase: .screenshots).nextPhase, .recent)
        XCTAssertEqual(PhotosCursor(phase: .recent).nextPhase, .backfill)
        XCTAssertEqual(PhotosCursor(phase: .backfill).nextPhase, .steady)
        XCTAssertEqual(PhotosCursor(phase: .steady).nextPhase, .steady, "steady is terminal — never wraps back")
    }

    func testEncodeDecodeRoundTrip() {
        let cursor = PhotosCursor(
            phase: .recent,
            lastAssetId: "asset-42",
            lastAssetDate: "2026-03-10T00:00:00Z",
            backfillCompletedAt: nil
        )
        let decoded = PhotosCursor.decode(from: cursor.encode())
        XCTAssertEqual(decoded, cursor)
    }

    func testDecodeIgnoresUnknownPhaseAndFallsBackToScreenshots() {
        let malformed: SyncCursor = ["phase": .string("bogus")]
        let decoded = PhotosCursor.decode(from: malformed)
        XCTAssertEqual(decoded.phase, .screenshots)
    }

    func testEncodeOmitsNilFields() {
        let cursor = PhotosCursor(phase: .screenshots)
        let encoded = cursor.encode()
        XCTAssertNil(encoded["lastAssetId"])
        XCTAssertNil(encoded["lastAssetDate"])
        XCTAssertNil(encoded["backfillCompletedAt"])
        XCTAssertEqual(encoded["phase"], .string("screenshots"))
    }

    func testBackfillCompletedAtSurvivesRoundTripOnceStamped() {
        let cursor = PhotosCursor(phase: .steady, backfillCompletedAt: "2026-05-01T00:00:00Z")
        let decoded = PhotosCursor.decode(from: cursor.encode())
        XCTAssertEqual(decoded.phase, .steady)
        XCTAssertEqual(decoded.backfillCompletedAt, "2026-05-01T00:00:00Z")
    }
}
