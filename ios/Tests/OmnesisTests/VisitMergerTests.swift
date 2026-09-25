// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class VisitMergerTests: XCTestCase {
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

    private func visit(arrival: String, departure: String?, lat: Double = 1, lon: Double = 2) -> RawVisit {
        RawVisit(
            latitude: lat,
            longitude: lon,
            horizontalAccuracy: 30,
            arrival: date(arrival),
            departure: departure.map(date)
        )
    }

    func testDropsArrivalOnlyVisits() {
        let raw = [
            visit(arrival: "2026-07-21T09:00:00.000Z", departure: nil),
            visit(arrival: "2026-07-21T14:00:00.000Z", departure: "2026-07-21T15:30:00.000Z"),
        ]
        let fresh = VisitMerger.selectFresh(raw: raw, alreadyEmittedArrivals: [])
        XCTAssertEqual(fresh.count, 1)
        XCTAssertEqual(fresh[0].arrival, date("2026-07-21T14:00:00.000Z"))
    }

    func testDedupsDuplicateArrivalKeepingLatestDeparture() {
        let raw = [
            visit(arrival: "2026-07-21T14:00:00.000Z", departure: "2026-07-21T15:00:00.000Z"),
            visit(arrival: "2026-07-21T14:00:00.000Z", departure: "2026-07-21T15:30:00.000Z"),
        ]
        let fresh = VisitMerger.selectFresh(raw: raw, alreadyEmittedArrivals: [])
        XCTAssertEqual(fresh.count, 1)
        XCTAssertEqual(fresh[0].departure, date("2026-07-21T15:30:00.000Z"))
    }

    func testSkipsAlreadyEmitted() {
        let already = iso8601.string(from: date("2026-07-21T09:00:00.000Z"))
        let raw = [
            visit(arrival: "2026-07-21T09:00:00.000Z", departure: "2026-07-21T09:45:00.000Z"),
            visit(arrival: "2026-07-21T14:00:00.000Z", departure: "2026-07-21T15:30:00.000Z"),
        ]
        let fresh = VisitMerger.selectFresh(raw: raw, alreadyEmittedArrivals: [already])
        XCTAssertEqual(fresh.count, 1)
        XCTAssertEqual(fresh[0].arrival, date("2026-07-21T14:00:00.000Z"))
    }

    func testDropsUnknownArrival() {
        let raw = [
            RawVisit(
                latitude: 1,
                longitude: 2,
                horizontalAccuracy: 30,
                arrival: .distantPast,
                departure: date("2026-07-21T10:00:00.000Z")
            ),
            visit(arrival: "2026-07-21T14:00:00.000Z", departure: "2026-07-21T15:30:00.000Z"),
        ]
        let fresh = VisitMerger.selectFresh(raw: raw, alreadyEmittedArrivals: [])
        XCTAssertEqual(fresh.count, 1)
        XCTAssertEqual(fresh[0].arrival, date("2026-07-21T14:00:00.000Z"))
    }

    func testSortsByArrival() {
        let raw = [
            visit(arrival: "2026-07-21T18:00:00.000Z", departure: "2026-07-21T19:00:00.000Z"),
            visit(arrival: "2026-07-21T09:00:00.000Z", departure: "2026-07-21T10:00:00.000Z"),
            visit(arrival: "2026-07-21T14:00:00.000Z", departure: "2026-07-21T15:00:00.000Z"),
        ]
        let fresh = VisitMerger.selectFresh(raw: raw, alreadyEmittedArrivals: [])
        XCTAssertEqual(fresh.map(\.arrival), [
            date("2026-07-21T09:00:00.000Z"),
            date("2026-07-21T14:00:00.000Z"),
            date("2026-07-21T18:00:00.000Z"),
        ])
    }
}
