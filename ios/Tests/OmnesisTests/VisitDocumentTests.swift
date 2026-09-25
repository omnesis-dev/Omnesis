// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class VisitDocumentTests: XCTestCase {
    private static let providerId = "core-location-visits:local"
    private static let sourceId = "core-location-visits:local"

    private var calendar: Calendar!
    private var iso8601: ISO8601DateFormatter!

    override func setUp() {
        super.setUp()
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        calendar = cal
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        iso8601 = formatter
    }

    private func date(_ iso: String) -> Date {
        // swiftlint:disable:next force_unwrapping
        iso8601.date(from: iso)!
    }

    private func resolved(
        arrival: String,
        departure: String,
        place: ResolvedPlace
    )
        -> ResolvedVisit {
        ResolvedVisit(
            arrival: date(arrival),
            departure: date(departure),
            latitude: 37.7599,
            longitude: -122.4148,
            horizontalAccuracy: 30,
            place: place
        )
    }

    // MARK: - Record

    func testSchemaDeclaresObservedVisitTemporalProjection() throws {
        let projection = try XCTUnwrap(VisitSchema.table.temporalProjection)
        XCTAssertEqual(projection.slot, "visit")
        XCTAssertEqual(projection.start, "$semanticTime")
        XCTAssertEqual(projection.end, "departure_time")
        XCTAssertEqual(projection.label, "place_name")
        XCTAssertEqual(projection.kind, .constant(.visit))
        XCTAssertEqual(projection.modality, .constant(.observed))
        XCTAssertEqual(projection.status, .constant(.completed))

        let data = try JSONEncoder().encode(VisitSchema.table)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let wire = try XCTUnwrap(json["temporalProjection"] as? [String: Any])
        XCTAssertEqual(Set(wire.keys), ["slot", "start", "end", "label", "kind", "modality", "status"])
        XCTAssertEqual(wire["start"] as? String, "$semanticTime")
        XCTAssertEqual(wire["end"] as? String, "departure_time")
        XCTAssertEqual(wire["label"] as? String, "place_name")
        XCTAssertEqual(wire["kind"] as? String, "visit")
        XCTAssertEqual(wire["modality"] as? String, "observed")
        XCTAssertEqual(wire["status"] as? String, "completed")
    }

    func testRecordShapeAndDeterministicId() {
        let visit = resolved(
            arrival: "2026-07-21T18:30:00.000Z",
            departure: "2026-07-21T20:15:00.000Z",
            place: ResolvedPlace(
                name: "Mission District",
                subLocality: "Mission District",
                locality: "San Francisco",
                administrativeArea: "California",
                country: "United States"
            )
        )
        let record = VisitSchema.record(from: visit, accountId: "local")
        XCTAssertEqual(record["place_name"], .string("Mission District"))
        XCTAssertEqual(record["account_id"], .string("local"))
        XCTAssertEqual(record["locality"], .string("San Francisco"))
        XCTAssertEqual(record["country"], .string("United States"))
        XCTAssertEqual(record["latitude"], .double(37.7599))
        XCTAssertEqual(record["duration_seconds"], .int(105 * 60))
        // Deterministic id → a re-delivered visit upserts rather than
        // duplicating.
        XCTAssertEqual(record["id"], VisitSchema.record(from: visit, accountId: "local")["id"])
    }

    func testRecordNullsAbsentPlaceComponents() {
        let visit = resolved(
            arrival: "2026-07-21T18:30:00.000Z",
            departure: "2026-07-21T20:15:00.000Z",
            place: ResolvedPlace(name: "Somewhere", locality: "San Francisco")
        )
        let record = VisitSchema.record(from: visit, accountId: "local")
        XCTAssertEqual(record["sub_locality"], .null)
        XCTAssertEqual(record["country"], .null)
        XCTAssertEqual(record["locality"], .string("San Francisco"))
    }

    // MARK: - Document

    func testDocumentTitleContentAndBinding() {
        let visit = resolved(
            arrival: "2026-07-21T18:30:00.000Z", // 14:30 America/New_York
            departure: "2026-07-21T20:15:00.000Z", // 16:15
            place: ResolvedPlace(
                name: "Rowan Park",
                locality: "San Francisco",
                administrativeArea: "California",
                country: "United States"
            )
        )
        let doc = VisitDocumentBuilder.document(
            from: visit,
            providerId: Self.providerId,
            sourceId: Self.sourceId,
            accountId: "local",
            calendar: calendar
        )
        XCTAssertEqual(doc.title, "Visited Rowan Park — July 21")
        XCTAssertTrue(doc.content.contains("14:30 → 16:15"), doc.content)
        XCTAssertTrue(doc.content.contains("(1h 45m)"), doc.content)
        XCTAssertTrue(doc.content.contains("San Francisco, California, United States"), doc.content)
        // Bound 1:1 to its analytics row.
        XCTAssertEqual(doc.externalId, VisitSchema.rowId(arrival: visit.arrival, accountId: "local"))
        XCTAssertEqual(doc.metadata.documentType, "visit")
        XCTAssertEqual(doc.metadata.tags, ["location", "visit"])
        XCTAssertEqual(doc.sourceCreatedAt, iso8601.string(from: visit.arrival))
        XCTAssertEqual(doc.contentHash, DocumentInput.computeContentHash(doc.content))
    }

    func testDocumentDoesNotRepeatNameInAreaContext() {
        let visit = resolved(
            arrival: "2026-07-21T18:30:00.000Z",
            departure: "2026-07-21T19:00:00.000Z",
            place: ResolvedPlace(
                name: "San Francisco",
                locality: "San Francisco",
                administrativeArea: "California",
                country: "United States"
            )
        )
        let doc = VisitDocumentBuilder.document(
            from: visit,
            providerId: Self.providerId,
            sourceId: Self.sourceId,
            accountId: "local",
            calendar: calendar
        )
        // "San Francisco" is the name, so the area context starts at the
        // region — the city isn't echoed.
        XCTAssertTrue(doc.content.contains("California, United States"), doc.content)
        XCTAssertFalse(doc.content.contains("San Francisco, San Francisco"), doc.content)
    }

    func testDurationLabelFormats() {
        XCTAssertEqual(VisitTime.durationLabel(105 * 60), "1h 45m")
        XCTAssertEqual(VisitTime.durationLabel(60 * 60), "1h")
        XCTAssertEqual(VisitTime.durationLabel(45 * 60), "45m")
        XCTAssertEqual(VisitTime.durationLabel(20), "0m")
        // Never renders a negative duration (a departure earlier than arrival
        // clamps to zero).
        XCTAssertEqual(VisitTime.durationLabel(-3600), "0m")
    }

    func testDocumentOmitsCoordinatesFromContentAndExtra() {
        let visit = resolved(
            arrival: "2026-07-21T18:30:00.000Z",
            departure: "2026-07-21T19:00:00.000Z",
            place: ResolvedPlace(name: "Rowan Park")
        )
        let doc = VisitDocumentBuilder.document(
            from: visit,
            providerId: Self.providerId,
            sourceId: Self.sourceId,
            accountId: "local",
            calendar: calendar
        )
        XCTAssertFalse(doc.content.contains("37.7599"), "raw coordinate leaked into content")
        XCTAssertNil(doc.metadata.extra?["latitude"], "raw coordinate leaked into extra")
        XCTAssertNil(doc.metadata.extra?["longitude"], "raw coordinate leaked into extra")
    }
}
