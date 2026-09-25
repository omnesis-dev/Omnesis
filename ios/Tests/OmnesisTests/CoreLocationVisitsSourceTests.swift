// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Drives the whole `sync(cursor:)` flow — drain, geocode, emit, advance
/// cursor — through the fakes. Possible because the source depends only on
/// the platform-neutral provider / resolver seams, so it isn't `os(iOS)`-
/// gated like `ActivitySegmentsSource`.
final class CoreLocationVisitsSourceTests: XCTestCase {
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

    // Two invented places at two invented coordinates.
    private let parkCoord = (lat: 37.7690, lon: -122.4830)
    private let streetCoord = (lat: 37.7599, lon: -122.4148)

    private func resolver() -> FakeVisitPlaceResolver {
        FakeVisitPlaceResolver(byCoordinate: [
            FakeVisitPlaceResolver.key(latitude: parkCoord.lat, longitude: parkCoord.lon):
                ResolvedPlace(name: "Rowan Park", locality: "San Francisco", country: "United States"),
            FakeVisitPlaceResolver.key(latitude: streetCoord.lat, longitude: streetCoord.lon):
                ResolvedPlace(name: "Mission District", locality: "San Francisco", country: "United States"),
        ])
    }

    /// The instant the fixtures are judged against.
    ///
    /// Stated, not `Date()`. The source prunes its cursor against a retention
    /// window measured from the clock, so a suite whose fixtures are pinned to
    /// a date and whose source reads the wall clock passes until the window
    /// slides past them — and then fails on every run afterwards. Moving the
    /// date forward only re-arms that; the clock the fixtures move with is the
    /// fix, and this is the one line that ties the two together.
    private var syncedAt: Date {
        date("2026-07-21T23:00:00.000Z")
    }

    private func source(
        provider: any CoreLocationVisitProviding,
        resolver: any VisitPlaceResolving
    )
        -> CoreLocationVisitsSource {
        CoreLocationVisitsSource(provider: provider, resolver: resolver, now: { self.syncedAt })
    }

    private func visit(
        _ coord: (lat: Double, lon: Double),
        arrival: String,
        departure: String?
    )
        -> RawVisit {
        RawVisit(
            latitude: coord.lat,
            longitude: coord.lon,
            horizontalAccuracy: 30,
            arrival: date(arrival),
            departure: departure.map(date)
        )
    }

    func testBootstrapEmitsRecordsAndDocuments() async throws {
        let provider = FakeVisitProvider(visits: [
            visit(parkCoord, arrival: "2026-07-21T18:30:00.000Z", departure: "2026-07-21T20:15:00.000Z"),
            visit(streetCoord, arrival: "2026-07-21T21:00:00.000Z", departure: "2026-07-21T21:40:00.000Z"),
        ])
        let source = source(provider: provider, resolver: resolver())

        let result = try await source.sync(cursor: nil)

        XCTAssertEqual(result.records.count, 2)
        XCTAssertEqual(result.documents.count, 2)
        XCTAssertEqual(result.tableName, "location_visits")
        XCTAssertFalse(result.hasMore)
        // Cursor now remembers both arrivals.
        let cursor = CoreLocationVisitsCursor.decode(from: result.cursor)
        XCTAssertEqual(cursor.emittedArrivals.count, 2)
        // Record ↔ document bound by id.
        let recordIds = Set(result.records.compactMap { record -> String? in
            if case .string(let id)? = record["id"] { return id }
            return nil
        })
        XCTAssertEqual(recordIds, Set(result.documents.map(\.externalId)))
    }

    func testIncrementalSkipsAlreadyEmitted() async throws {
        let visits = [
            visit(parkCoord, arrival: "2026-07-21T18:30:00.000Z", departure: "2026-07-21T20:15:00.000Z"),
            visit(streetCoord, arrival: "2026-07-21T21:00:00.000Z", departure: "2026-07-21T21:40:00.000Z"),
        ]
        let source = source(provider: FakeVisitProvider(visits: visits), resolver: resolver())

        // First sync emits both; the provider re-delivers them (buffer is
        // pruned by age, not on read), so the second sync must emit nothing.
        let first = try await source.sync(cursor: nil)
        XCTAssertEqual(first.records.count, 2)
        let second = try await source.sync(cursor: first.cursor)
        XCTAssertEqual(second.records.count, 0)
        XCTAssertEqual(second.documents.count, 0)
    }

    func testUnnameableVisitSkippedAndRetriedLater() async throws {
        // The resolver knows the park but not the street coordinate (returns
        // nil — as if offline for that one).
        let onlyPark = FakeVisitPlaceResolver(byCoordinate: [
            FakeVisitPlaceResolver.key(latitude: parkCoord.lat, longitude: parkCoord.lon):
                ResolvedPlace(name: "Rowan Park"),
        ])
        let provider = FakeVisitProvider(visits: [
            visit(parkCoord, arrival: "2026-07-21T18:30:00.000Z", departure: "2026-07-21T20:15:00.000Z"),
            visit(streetCoord, arrival: "2026-07-21T21:00:00.000Z", departure: "2026-07-21T21:40:00.000Z"),
        ])
        let source = source(provider: provider, resolver: onlyPark)

        let first = try await source.sync(cursor: nil)
        // Only the named visit is emitted.
        XCTAssertEqual(first.records.count, 1)
        XCTAssertEqual(first.documents.first?.title.contains("Rowan Park"), true)
        // The unnamed arrival is NOT recorded, so it's still eligible.
        let cursor = CoreLocationVisitsCursor.decode(from: first.cursor)
        XCTAssertEqual(cursor.emittedArrivals.count, 1)

        // The device comes back online: the street coordinate now resolves.
        // The retried visit (never marked emitted) is picked up; the already
        // emitted park visit is not re-emitted.
        onlyPark.byCoordinate[FakeVisitPlaceResolver.key(latitude: streetCoord.lat, longitude: streetCoord.lon)] =
            ResolvedPlace(name: "Mission District", locality: "San Francisco")
        let second = try await source.sync(cursor: first.cursor)
        XCTAssertEqual(second.records.count, 1)
        XCTAssertEqual(second.documents.first?.title.contains("Mission District"), true)
    }

    func testArrivalOnlyVisitProducesNothing() async throws {
        let provider = FakeVisitProvider(visits: [
            visit(parkCoord, arrival: "2026-07-21T18:30:00.000Z", departure: nil),
        ])
        let source = source(provider: provider, resolver: resolver())
        let result = try await source.sync(cursor: nil)
        XCTAssertEqual(result.records.count, 0)
        XCTAssertEqual(result.documents.count, 0)
    }
}
