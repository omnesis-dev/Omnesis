// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class CoreLocationVisitsCursorTests: XCTestCase {
    private var iso8601: ISO8601DateFormatter!

    override func setUp() {
        super.setUp()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        iso8601 = formatter
    }

    private func date(_ iso: String) -> Date {
        // swiftlint:disable:next force_unwrapping
        iso8601.date(from: iso)!
    }

    func testEmptyCursorEncodesEmpty() {
        XCTAssertTrue(CoreLocationVisitsCursor().encode().isEmpty)
    }

    func testEncodeDecodeRoundTrips() {
        let arrivals: Set<String> = [
            iso8601.string(from: date("2026-07-21T09:00:00.000Z")),
            iso8601.string(from: date("2026-07-21T14:00:00.000Z")),
        ]
        let cursor = CoreLocationVisitsCursor(emittedArrivals: arrivals)
        let decoded = CoreLocationVisitsCursor.decode(from: cursor.encode())
        XCTAssertEqual(decoded.emittedArrivals, arrivals)
    }

    func testRecordingAddsNewArrivals() {
        let now = date("2026-07-21T20:00:00.000Z")
        let cursor = CoreLocationVisitsCursor()
            .recording([iso8601.string(from: date("2026-07-21T14:00:00.000Z"))], now: now)
        XCTAssertEqual(cursor.emittedArrivals.count, 1)
    }

    func testRecordingPrunesArrivalsPastRetention() {
        let now = date("2026-07-21T20:00:00.000Z")
        let old = iso8601.string(from: now.addingTimeInterval(-Double(CoreLocationVisitsRetention.days + 1) * 86400))
        let recent = iso8601.string(from: date("2026-07-21T14:00:00.000Z"))
        let cursor = CoreLocationVisitsCursor(emittedArrivals: [old])
            .recording([recent], now: now)
        XCTAssertEqual(cursor.emittedArrivals, [recent])
    }
}
