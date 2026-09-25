// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class ActivitySegmentDocumentTests: XCTestCase {
    private static let providerId = "activity-segments:local"
    private static let sourceId = "activity-segments:local"

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

    // MARK: - Schema / record

    func testRecordShapeAndDeterministicId() {
        let segment = ActivitySegment(
            type: .automotive,
            start: date("2026-04-18T13:03:00.000Z"),
            end: date("2026-04-18T13:41:00.000Z"),
            confidence: .high
        )
        let record = ActivitySegmentSchema.record(from: segment, accountId: "local")
        XCTAssertEqual(record["type"], .string("automotive"))
        XCTAssertEqual(record["account_id"], .string("local"))
        XCTAssertEqual(record["duration_seconds"], .int(38 * 60))
        XCTAssertEqual(record["confidence"], .string("high"))
        // Deterministic — the same segment always produces the same id,
        // so a redundant re-upload during backfill upserts rather than
        // duplicating.
        let again = ActivitySegmentSchema.record(from: segment, accountId: "local")
        XCTAssertEqual(record["id"], again["id"])
    }

    // MARK: - Daily document

    func testDailyDocumentAggregatesEverySegmentThatDay() {
        let segments = [
            ActivitySegment(
                type: .automotive,
                start: date("2026-04-18T13:03:00.000Z"),
                end: date("2026-04-18T13:41:00.000Z"),
                confidence: .high
            ),
            ActivitySegment(
                type: .walking,
                start: date("2026-04-18T13:41:00.000Z"),
                end: date("2026-04-18T13:47:00.000Z"),
                confidence: .medium
            ),
        ]
        let docs = ActivitySegmentDocumentBuilder.dailyDocuments(
            from: segments, calendar: calendar, providerId: Self.providerId, sourceId: Self.sourceId
        )
        XCTAssertEqual(docs.count, 1)
        let doc = docs[0]
        XCTAssertEqual(doc.externalId, "activity-segments-day:2026-04-18")
        XCTAssertEqual(doc.title, "Movement — April 18")
        XCTAssertTrue(doc.content.contains("Driving"), doc.content)
        XCTAssertTrue(doc.content.contains("38m"), doc.content)
        XCTAssertTrue(doc.content.contains("Walking"), doc.content)
        XCTAssertTrue(doc.content.contains("6m"), doc.content)
        XCTAssertTrue(doc.content.contains("·"), "multiple segments join with a separator: \(doc.content)")
        XCTAssertEqual(doc.metadata.rollingAggregate, true)
        XCTAssertEqual(doc.metadata.tags, ["movement"])
    }

    func testDailyDocumentSplitsIntoOnePerDayAcrossMidnight() {
        let segment = ActivitySegment(
            type: .stationary,
            start: date("2026-04-19T03:00:00.000Z"), // 23:00 on the 18th, America/New_York
            end: date("2026-04-19T05:00:00.000Z"), // 01:00 on the 19th
            confidence: .high
        )
        let docs = ActivitySegmentDocumentBuilder.dailyDocuments(
            from: [segment], calendar: calendar, providerId: Self.providerId, sourceId: Self.sourceId
        )
        XCTAssertEqual(docs.count, 2)
        XCTAssertEqual(docs[0].externalId, "activity-segments-day:2026-04-18")
        XCTAssertEqual(docs[1].externalId, "activity-segments-day:2026-04-19")
    }

    func testDailyDocumentExternalIdIsStableAcrossRebuilds() {
        let segments = [
            ActivitySegment(
                type: .walking,
                start: date("2026-04-18T13:00:00.000Z"),
                end: date("2026-04-18T13:10:00.000Z"),
                confidence: .high
            ),
        ]
        let first = ActivitySegmentDocumentBuilder.dailyDocuments(
            from: segments, calendar: calendar, providerId: Self.providerId, sourceId: Self.sourceId
        )
        let second = ActivitySegmentDocumentBuilder.dailyDocuments(
            from: segments, calendar: calendar, providerId: Self.providerId, sourceId: Self.sourceId
        )
        XCTAssertEqual(first[0].externalId, second[0].externalId)
        XCTAssertEqual(first[0].contentHash, second[0].contentHash)
    }

    func testEmptySegmentsProduceNoDocuments() {
        let docs = ActivitySegmentDocumentBuilder.dailyDocuments(
            from: [], calendar: calendar, providerId: Self.providerId, sourceId: Self.sourceId
        )
        XCTAssertTrue(docs.isEmpty)
    }
}
