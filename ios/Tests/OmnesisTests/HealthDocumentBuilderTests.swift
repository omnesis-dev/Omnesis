// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
@testable import Omnesis
import XCTest

/// Covers the workout/mindful → `DocumentInput` normalizer (#640): the
/// summary document a searchable Apple Health workout becomes, bound 1:1
/// to its analytics row via `externalId == health_workouts.id`.
final class HealthDocumentBuilderTests: XCTestCase {
    private static let providerId = "apple-health:local"
    private static let sourceId = "apple-health:local"

    private func document(_ sample: NormalizedSample) -> DocumentInput? {
        HealthDocumentBuilder.document(
            from: sample,
            providerId: Self.providerId,
            sourceId: Self.sourceId
        )
    }

    // MARK: - Workout

    func testWorkoutDocumentHasRowBoundExternalIdAndSummary() throws {
        let sample = NormalizedSample(
            id: "workout-uuid-1",
            category: .workouts,
            metric: "HKWorkoutTypeIdentifier",
            startTime: "2026-04-18T07:00:00.000Z",
            endTime: "2026-04-18T07:48:00.000Z",
            sourceApp: "com.apple.Health",
            sourceDevice: "Apple Watch",
            workout: WorkoutAttributes(
                workoutType: "running",
                durationSeconds: 2880,
                totalDistanceMeters: 9200,
                totalEnergyKcal: 612
            )
        )

        let doc = try XCTUnwrap(document(sample))

        // Bound 1:1 to the row: same id the analytics record uses as PK.
        XCTAssertEqual(doc.externalId, "workout-uuid-1")
        XCTAssertEqual(doc.providerId, Self.providerId)
        XCTAssertEqual(doc.sourceId, Self.sourceId)

        // documentType + dates.
        XCTAssertEqual(doc.metadata.documentType, "activity")
        XCTAssertEqual(doc.sourceCreatedAt, "2026-04-18T07:00:00.000Z", "sourceCreatedAt is the workout start")
        XCTAssertEqual(doc.sourceUpdatedAt, "2026-04-18T07:48:00.000Z")

        // Title + searchable prose body with the key metrics.
        XCTAssertEqual(doc.title, "Morning Run")
        XCTAssertTrue(doc.content.contains("Morning Run"), "body: \(doc.content)")
        XCTAssertTrue(doc.content.contains("9.2 km"), "distance in km; body: \(doc.content)")
        XCTAssertTrue(doc.content.contains("612 kcal"), "energy; body: \(doc.content)")
        XCTAssertTrue(doc.content.contains("48 min"), "duration; body: \(doc.content)")

        // Structured extras travel in metadata.extra for the bound view.
        XCTAssertEqual(doc.metadata.extra?["workoutType"], .string("running"))
        XCTAssertEqual(doc.metadata.extra?["totalDistanceMeters"], .double(9200))
        XCTAssertEqual(doc.metadata.extra?["totalEnergyKcal"], .double(612))
        XCTAssertEqual(doc.metadata.tags, ["workout", "running"])
    }

    func testWorkoutContentHashIsSha256OfContent() throws {
        let sample = NormalizedSample(
            id: "workout-uuid-2",
            category: .workouts,
            metric: "HKWorkoutTypeIdentifier",
            startTime: "2026-04-18T18:30:00.000Z",
            endTime: "2026-04-18T19:05:00.000Z",
            workout: WorkoutAttributes(
                workoutType: "cycling",
                durationSeconds: 2100,
                totalDistanceMeters: 18500,
                totalEnergyKcal: 410
            )
        )
        let doc = try XCTUnwrap(document(sample))

        // Independent SHA-256 of the exact content string, lowercase hex,
        // no prefix — must match `computeContentHash` (gateway parity).
        let expected = SHA256.hash(data: Data(doc.content.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        XCTAssertEqual(doc.contentHash, expected)
        XCTAssertEqual(doc.contentHash.count, 64)
        XCTAssertEqual(doc.title, "Evening Cycle")
    }

    func testWorkoutWithoutDistanceOrEnergyOmitsThoseStats() throws {
        let sample = NormalizedSample(
            id: "workout-uuid-3",
            category: .workouts,
            metric: "HKWorkoutTypeIdentifier",
            startTime: "2026-04-18T12:15:00.000Z",
            endTime: "2026-04-18T12:45:00.000Z",
            workout: WorkoutAttributes(
                workoutType: "yoga",
                durationSeconds: 1800,
                totalDistanceMeters: nil,
                totalEnergyKcal: nil
            )
        )
        let doc = try XCTUnwrap(document(sample))
        XCTAssertEqual(doc.title, "Afternoon Yoga")
        XCTAssertTrue(doc.content.contains("30 min"))
        XCTAssertFalse(doc.content.contains("km"))
        XCTAssertFalse(doc.content.contains("kcal"))
    }

    // MARK: - Mindful

    func testMindfulDocumentBoundToRowWithDuration() throws {
        let sample = NormalizedSample(
            id: "mindful-uuid-1",
            category: .mindful,
            metric: "HKCategoryTypeIdentifierMindfulSession",
            startTime: "2026-04-18T06:30:00.000Z",
            endTime: "2026-04-18T06:45:30.000Z"
        )
        let doc = try XCTUnwrap(document(sample))
        XCTAssertEqual(doc.externalId, "mindful-uuid-1")
        XCTAssertEqual(doc.metadata.documentType, "activity")
        XCTAssertEqual(doc.sourceCreatedAt, "2026-04-18T06:30:00.000Z")
        XCTAssertTrue(doc.content.contains("Mindful Session"), "body: \(doc.content)")
        // 15 min 30 s → 16 min (rounded).
        XCTAssertTrue(doc.content.contains("16 min"), "body: \(doc.content)")
        XCTAssertEqual(doc.metadata.tags, ["mindful"])
        XCTAssertEqual(doc.metadata.extra?["durationSeconds"], .int(930))
    }

    // MARK: - Mood (State of Mind)

    func testMoodDocumentWithLabelsAndAssociations() throws {
        let sample = NormalizedSample(
            id: "mood-uuid-1",
            category: .mood,
            metric: "HKStateOfMindTypeIdentifier",
            startTime: "2026-04-18T20:00:00.000Z",
            endTime: "2026-04-18T20:00:00.000Z",
            mood: MoodAttributes(
                kind: "momentaryEmotion",
                valence: 0.6,
                labels: ["happy", "grateful"],
                associations: ["friends", "currentEvents"]
            )
        )
        let doc = try XCTUnwrap(document(sample))

        XCTAssertEqual(doc.externalId, "mood-uuid-1")
        XCTAssertEqual(doc.metadata.documentType, "activity")
        XCTAssertEqual(doc.sourceCreatedAt, "2026-04-18T20:00:00.000Z")
        XCTAssertEqual(doc.sourceUpdatedAt, "2026-04-18T20:00:00.000Z")

        XCTAssertEqual(doc.title, "Feeling Happy, Grateful")
        XCTAssertEqual(doc.content, "Feeling Happy, Grateful — pleasant (valence 0.6), associated with friends, current events")

        XCTAssertEqual(doc.metadata.tags, ["mood", "happy", "grateful"])
        XCTAssertEqual(doc.metadata.extra?["kind"], .string("momentaryEmotion"))
        XCTAssertEqual(doc.metadata.extra?["valence"], .double(0.6))
        XCTAssertEqual(doc.metadata.extra?["labels"], .array([.string("happy"), .string("grateful")]))
        XCTAssertEqual(doc.metadata.extra?["associations"], .array([.string("friends"), .string("currentEvents")]))
    }

    func testMoodDocumentWithoutLabelsOrAssociationsUsesKindTitle() throws {
        let sample = NormalizedSample(
            id: "mood-uuid-2",
            category: .mood,
            metric: "HKStateOfMindTypeIdentifier",
            startTime: "2026-04-18T08:00:00.000Z",
            endTime: "2026-04-18T08:00:00.000Z",
            mood: MoodAttributes(kind: "dailyMood", valence: -0.7, labels: [], associations: [])
        )
        let doc = try XCTUnwrap(document(sample))

        XCTAssertEqual(doc.title, "Daily Mood")
        XCTAssertEqual(doc.content, "Daily Mood — very unpleasant (valence -0.7)")
        XCTAssertEqual(doc.metadata.tags, ["mood"])
        XCTAssertNil(doc.metadata.extra?["labels"], "empty labels are omitted from extra")
        XCTAssertNil(doc.metadata.extra?["associations"], "empty associations are omitted from extra")
    }

    func testMomentaryEmotionWithoutLabelsUsesKindTitle() throws {
        let sample = NormalizedSample(
            id: "mood-uuid-3",
            category: .mood,
            metric: "HKStateOfMindTypeIdentifier",
            startTime: "2026-04-18T14:00:00.000Z",
            endTime: "2026-04-18T14:00:00.000Z",
            mood: MoodAttributes(kind: "momentaryEmotion", valence: 0.0, labels: [], associations: [])
        )
        let doc = try XCTUnwrap(document(sample))
        XCTAssertEqual(doc.title, "Momentary Emotion")
        XCTAssertEqual(doc.content, "Momentary Emotion — neutral (valence 0)")
    }

    func testMoodContentHashIsSha256OfContent() throws {
        let sample = NormalizedSample(
            id: "mood-uuid-4",
            category: .mood,
            metric: "HKStateOfMindTypeIdentifier",
            startTime: "2026-04-18T09:00:00.000Z",
            endTime: "2026-04-18T09:00:00.000Z",
            mood: MoodAttributes(kind: "momentaryEmotion", valence: 0.3, labels: ["calm"], associations: [])
        )
        let doc = try XCTUnwrap(document(sample))
        let expected = SHA256.hash(data: Data(doc.content.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        XCTAssertEqual(doc.contentHash, expected)
        XCTAssertEqual(doc.contentHash.count, 64)
    }

    // MARK: - Sleep night rollup

    /// Same conversion `HealthDocumentBuilder.sleepNightDocument` uses
    /// internally (parse UTC ISO 8601, render `HH:mm` in the device's
    /// current time zone) — computed here rather than hardcoded so this
    /// test passes regardless of which time zone it runs in.
    private func expectedClockTime(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? Date()
        let clock = DateFormatter()
        clock.dateFormat = "HH:mm"
        return clock.string(from: date)
    }

    private func stagedSummary(
        awakeSeconds: TimeInterval = 600,
        awakeningsCount: Int = 1
    )
        -> SleepNightSummary {
        SleepNightSummary(
            bucketDate: "2026-04-18",
            inBedStart: "2026-04-19T03:00:00.000Z",
            inBedEnd: "2026-04-19T11:00:00.000Z",
            coreSeconds: 5 * 3600,
            deepSeconds: 3600,
            remSeconds: 3600,
            unspecifiedAsleepSeconds: 0,
            awakeSeconds: awakeSeconds,
            totalAsleepSeconds: 7 * 3600,
            awakeningsCount: awakeningsCount,
            isStaged: true
        )
    }

    func testStagedSleepNightDocumentSurfacesEveryPresentStage() {
        let summary = stagedSummary()
        let doc = HealthDocumentBuilder.sleepNightDocument(
            from: summary, providerId: Self.providerId, sourceId: Self.sourceId
        )

        XCTAssertEqual(doc.externalId, "sleep-night:2026-04-18")
        XCTAssertEqual(doc.title, "Night of April 18")
        XCTAssertEqual(doc.sourceCreatedAt, summary.inBedStart)
        XCTAssertEqual(doc.sourceUpdatedAt, summary.inBedEnd)
        XCTAssertEqual(doc.metadata.documentType, "activity")
        XCTAssertEqual(doc.metadata.tags, ["sleep"])
        XCTAssertEqual(doc.metadata.rollingAggregate, true)

        let clockRange = "\(expectedClockTime(summary.inBedStart)) → \(expectedClockTime(summary.inBedEnd))"
        let expected = "Night of April 18 — in bed \(clockRange), asleep 7h" +
            " · Deep 1h · REM 1h · Core 5h · Awake 10m · 1 awakening"
        XCTAssertEqual(doc.content, expected)
    }

    func testStagedSleepNightDocumentOmitsAwakeningsClauseWhenZero() {
        let summary = stagedSummary(awakeSeconds: 0, awakeningsCount: 0)
        let doc = HealthDocumentBuilder.sleepNightDocument(
            from: summary, providerId: Self.providerId, sourceId: Self.sourceId
        )
        XCTAssertFalse(doc.content.contains("awakening"), "zero awakenings must omit the clause entirely: \(doc.content)")
        XCTAssertFalse(doc.content.contains("Awake"), "zero awake seconds must omit the Awake segment: \(doc.content)")
    }

    func testStagedSleepNightDocumentPluralizesMultipleAwakenings() {
        let summary = stagedSummary(awakeningsCount: 3)
        let doc = HealthDocumentBuilder.sleepNightDocument(
            from: summary, providerId: Self.providerId, sourceId: Self.sourceId
        )
        XCTAssertTrue(doc.content.hasSuffix("3 awakenings"), doc.content)
    }

    func testStagedSleepNightDocumentOmitsAMissingStageSegment() {
        // No REM logged at all (deep + core only) — the REM segment
        // must be absent, not rendered as "REM 0m".
        let summary = SleepNightSummary(
            bucketDate: "2026-04-18",
            inBedStart: "2026-04-19T03:00:00.000Z",
            inBedEnd: "2026-04-19T11:00:00.000Z",
            coreSeconds: 5 * 3600,
            deepSeconds: 3600,
            remSeconds: 0,
            unspecifiedAsleepSeconds: 0,
            awakeSeconds: 0,
            totalAsleepSeconds: 6 * 3600,
            awakeningsCount: 0,
            isStaged: true
        )
        let doc = HealthDocumentBuilder.sleepNightDocument(
            from: summary, providerId: Self.providerId, sourceId: Self.sourceId
        )
        XCTAssertFalse(doc.content.contains("REM"), doc.content)
        XCTAssertTrue(doc.content.contains("Deep 1h"), doc.content)
        XCTAssertTrue(doc.content.contains("Core 5h"), doc.content)
    }

    func testCoarseSleepNightDocumentHasNoStageBreakdown() {
        let summary = SleepNightSummary(
            bucketDate: "2026-04-18",
            inBedStart: "2026-04-19T03:00:00.000Z",
            inBedEnd: "2026-04-19T11:00:00.000Z",
            coreSeconds: 0,
            deepSeconds: 0,
            remSeconds: 0,
            unspecifiedAsleepSeconds: 7 * 3600,
            awakeSeconds: 0,
            totalAsleepSeconds: 7 * 3600,
            awakeningsCount: 0,
            isStaged: false
        )
        let doc = HealthDocumentBuilder.sleepNightDocument(
            from: summary, providerId: Self.providerId, sourceId: Self.sourceId
        )
        let clockRange = "\(expectedClockTime(summary.inBedStart)) → \(expectedClockTime(summary.inBedEnd))"
        XCTAssertEqual(doc.content, "Night of April 18 — in bed \(clockRange), asleep 7h")
        XCTAssertFalse(doc.content.contains("·"), "coarse nights carry no per-stage segments")
    }

    func testSleepNightDocumentCarriesFullSummaryInExtra() {
        let summary = stagedSummary()
        let doc = HealthDocumentBuilder.sleepNightDocument(
            from: summary, providerId: Self.providerId, sourceId: Self.sourceId
        )
        XCTAssertEqual(doc.metadata.extra?["bucketDate"], .string("2026-04-18"))
        XCTAssertEqual(doc.metadata.extra?["coreSeconds"], .int(5 * 3600))
        XCTAssertEqual(doc.metadata.extra?["deepSeconds"], .int(3600))
        XCTAssertEqual(doc.metadata.extra?["remSeconds"], .int(3600))
        XCTAssertEqual(doc.metadata.extra?["totalAsleepSeconds"], .int(7 * 3600))
        XCTAssertEqual(doc.metadata.extra?["awakeningsCount"], .int(1))
        XCTAssertEqual(doc.metadata.extra?["isStaged"], .bool(true))
    }

    // MARK: - Non-episodic tables emit no document

    func testTallSampleCategoriesProduceNoDocument() {
        for category in [HealthCategory.body, .activity, .vitals, .sleep, .nutrition, .environment] {
            let sample = NormalizedSample(
                id: "sample-\(category.rawValue)",
                category: category,
                metric: "HKQuantityTypeIdentifierStepCount",
                value: 42,
                unit: "count",
                startTime: "2026-04-18T00:00:00.000Z",
                endTime: "2026-04-18T00:00:00.000Z",
                sleep: category == .sleep ? SleepAttributes(stage: "asleepCore") : nil
            )
            XCTAssertNil(document(sample), "\(category) must not mint a document")
        }
    }

    // MARK: - Wire shape

    func testDocumentEncodesCamelCaseKeysAndOmitsNilMetadata() throws {
        let sample = NormalizedSample(
            id: "workout-uuid-4",
            category: .workouts,
            metric: "HKWorkoutTypeIdentifier",
            startTime: "2026-04-18T07:00:00.000Z",
            endTime: "2026-04-18T07:30:00.000Z",
            workout: WorkoutAttributes(
                workoutType: "running",
                durationSeconds: 1800,
                totalDistanceMeters: 5000,
                totalEnergyKcal: 300
            )
        )
        let doc = try XCTUnwrap(document(sample))
        let data = try JSONEncoder().encode(doc)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        // The gateway's `documentInputShape` validator reads these exact
        // camelCase keys.
        XCTAssertEqual(json["providerId"] as? String, Self.providerId)
        XCTAssertEqual(json["sourceId"] as? String, Self.sourceId)
        XCTAssertEqual(json["externalId"] as? String, "workout-uuid-4")
        XCTAssertNotNil(json["contentHash"])
        XCTAssertNotNil(json["sourceCreatedAt"])
        XCTAssertNotNil(json["sourceUpdatedAt"])
        let metadata = try XCTUnwrap(json["metadata"] as? [String: Any])
        XCTAssertEqual(metadata["documentType"] as? String, "activity")
        // nil metadata fields (people/sourceUrl/appUrl) are omitted.
        XCTAssertNil(metadata["people"])
        XCTAssertNil(metadata["sourceUrl"])
        XCTAssertNil(metadata["appUrl"])
    }
}
