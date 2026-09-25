// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class NormalizerTests: XCTestCase {
    private func record(_ sample: NormalizedSample) -> [String: JSONValue] {
        HealthRecordBuilder.record(from: sample, accountId: "ios-test")
    }

    // MARK: - Row-per-sample (body / activity / vitals / nutrition / environment)

    func testBodyMassRecordShape() {
        let sample = NormalizedSample(
            id: "uuid-body",
            category: .body,
            metric: "HKQuantityTypeIdentifierBodyMass",
            value: 74.8,
            unit: "kg",
            startTime: "2026-04-18T07:00:00Z",
            endTime: "2026-04-18T07:00:00Z",
            sourceApp: "com.humehealth.app",
            sourceDevice: "Hume Body Pod"
        )
        let r = record(sample)
        XCTAssertEqual(r["id"], .string("uuid-body"))
        XCTAssertEqual(r["account_id"], .string("ios-test"))
        XCTAssertEqual(r["metric"], .string("HKQuantityTypeIdentifierBodyMass"))
        XCTAssertEqual(r["metric_slug"], .string("body_mass"))
        XCTAssertEqual(r["value"], .double(74.8))
        XCTAssertEqual(r["unit"], .string("kg"))
        XCTAssertEqual(r["start_time"], .string("2026-04-18T07:00:00Z"))
        XCTAssertEqual(r["source_app"], .string("com.humehealth.app"))
        XCTAssertEqual(r["source_device"], .string("Hume Body Pod"))
    }

    func testNilValueSerializesAsNull() {
        let sample = NormalizedSample(
            id: "uuid-x",
            category: .activity,
            metric: "HKQuantityTypeIdentifierStepCount",
            value: nil,
            unit: "count",
            startTime: "2026-04-18T00:00:00Z",
            endTime: "2026-04-18T00:00:00Z"
        )
        let r = record(sample)
        XCTAssertEqual(r["value"], .null)
    }

    func testUnknownMetricFallsBackToIdentifierAsSlug() {
        let sample = NormalizedSample(
            id: "uuid-x",
            category: .vitals,
            metric: "HKQuantityTypeIdentifierMysteryMetric",
            value: 42,
            unit: "unit",
            startTime: "2026-04-18T00:00:00Z",
            endTime: "2026-04-18T00:00:00Z"
        )
        let r = record(sample)
        XCTAssertEqual(r["metric_slug"], .string("HKQuantityTypeIdentifierMysteryMetric"))
    }

    // MARK: - Sleep

    func testSleepRecordShape() {
        let sample = NormalizedSample(
            id: "uuid-sleep",
            category: .sleep,
            metric: "HKCategoryTypeIdentifierSleepAnalysis",
            value: nil,
            unit: nil,
            startTime: "2026-04-17T23:10:00Z",
            endTime: "2026-04-18T07:05:00Z",
            sourceApp: "com.apple.Health",
            sourceDevice: "Apple Watch",
            sleep: SleepAttributes(stage: "asleepDeep")
        )
        let r = record(sample)
        XCTAssertEqual(r["id"], .string("uuid-sleep"))
        XCTAssertEqual(r["stage"], .string("asleepDeep"))
        XCTAssertEqual(r["start_time"], .string("2026-04-17T23:10:00Z"))
        XCTAssertEqual(r["end_time"], .string("2026-04-18T07:05:00Z"))
        XCTAssertNil(r["value"])
    }

    // MARK: - Workout

    func testWorkoutRecordShape() {
        let sample = NormalizedSample(
            id: "uuid-workout",
            category: .workouts,
            metric: "HKWorkoutTypeIdentifier",
            value: nil,
            unit: nil,
            startTime: "2026-04-18T07:00:00Z",
            endTime: "2026-04-18T07:50:00Z",
            sourceApp: "com.strava.stravaride",
            sourceDevice: "iPhone",
            workout: WorkoutAttributes(
                workoutType: "running",
                durationSeconds: 3000,
                totalDistanceMeters: 8234.5,
                totalEnergyKcal: 612
            )
        )
        let r = record(sample)
        XCTAssertEqual(r["workout_type"], .string("running"))
        XCTAssertEqual(r["duration_seconds"], .int(3000))
        XCTAssertEqual(r["total_distance_m"], .double(8234.5))
        XCTAssertEqual(r["total_energy_kcal"], .double(612))
    }

    // MARK: - Mindful

    func testMindfulDurationDerivedFromInterval() {
        let sample = NormalizedSample(
            id: "uuid-mindful",
            category: .mindful,
            metric: "HKCategoryTypeIdentifierMindfulSession",
            value: nil,
            unit: nil,
            startTime: "2026-04-18T06:30:00.000Z",
            endTime: "2026-04-18T06:45:30.000Z"
        )
        let r = record(sample)
        // 15 min 30 s = 930 s.
        XCTAssertEqual(r["duration_seconds"], .int(930))
    }

    // MARK: - Mood (State of Mind)

    func testMoodRecordShape() {
        let sample = NormalizedSample(
            id: "uuid-mood",
            category: .mood,
            metric: "HKStateOfMindTypeIdentifier",
            value: nil,
            unit: nil,
            startTime: "2026-04-18T20:00:00Z",
            endTime: "2026-04-18T20:00:00Z",
            sourceApp: "com.apple.Health",
            mood: MoodAttributes(
                kind: "momentaryEmotion",
                valence: 0.6,
                labels: ["happy", "grateful"],
                associations: ["friends"]
            )
        )
        let r = record(sample)
        XCTAssertEqual(r["id"], .string("uuid-mood"))
        XCTAssertEqual(r["kind"], .string("momentaryEmotion"))
        XCTAssertEqual(r["valence"], .double(0.6))
        XCTAssertEqual(r["labels"], .array([.string("happy"), .string("grateful")]))
        XCTAssertEqual(r["associations"], .array([.string("friends")]))
        XCTAssertEqual(r["start_time"], .string("2026-04-18T20:00:00Z"))
        XCTAssertEqual(r["end_time"], .string("2026-04-18T20:00:00Z"))
        XCTAssertEqual(r["source_app"], .string("com.apple.Health"))
    }

    func testMoodRecordWithoutLabelsOrAssociationsSerializesEmptyArrays() {
        let sample = NormalizedSample(
            id: "uuid-mood-2",
            category: .mood,
            metric: "HKStateOfMindTypeIdentifier",
            value: nil,
            unit: nil,
            startTime: "2026-04-18T08:00:00Z",
            endTime: "2026-04-18T08:00:00Z",
            mood: MoodAttributes(kind: "dailyMood", valence: -0.4, labels: [], associations: [])
        )
        let r = record(sample)
        XCTAssertEqual(r["kind"], .string("dailyMood"))
        XCTAssertEqual(r["labels"], .array([]))
        XCTAssertEqual(r["associations"], .array([]))
        XCTAssertEqual(r["source_app"], .null)
    }
}
