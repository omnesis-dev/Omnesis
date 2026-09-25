// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Uses a PINNED calendar/time zone (not `.current`) throughout so
/// bucketing/window math is deterministic regardless of the machine
/// running the test.
final class SleepNightBucketerTests: XCTestCase {
    private var calendar: Calendar!
    private var iso8601: ISO8601DateFormatter!

    override func setUp() {
        super.setUp()
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        calendar = cal
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(identifier: "America/New_York")
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        iso8601 = formatter
    }

    private func date(_ iso: String) -> Date {
        // swiftlint:disable:next force_unwrapping
        iso8601.date(from: iso)!
    }

    private func sample(id: String, stage: String, start: String, end: String) -> NormalizedSample {
        NormalizedSample(
            id: id,
            category: .sleep,
            metric: "HKCategoryTypeIdentifierSleepAnalysis",
            startTime: start,
            endTime: end,
            sleep: SleepAttributes(stage: stage)
        )
    }

    // MARK: - Bucketing

    func testEveningToEarlyMorningSamplesBucketTogether() {
        // 23:10 the night of the 18th and 06:45 the morning of the 19th
        // both belong to "the night of the 18th".
        let evening = nightBucket("2026-04-18T23:10:00.000-04:00")
        let morning = nightBucket("2026-04-19T06:45:00.000-04:00")
        XCTAssertEqual(evening, "2026-04-18")
        XCTAssertEqual(morning, "2026-04-18")
    }

    func testExactNoonBoundary() {
        // A sample starting exactly at noon belongs to THAT day's night
        // (the window is `[noon, next noon)` — closed at the start).
        // One nanosecond before noon still belongs to the PREVIOUS day.
        let atNoon = nightBucket("2026-04-18T12:00:00.000-04:00")
        let justBefore = nightBucket("2026-04-18T11:59:59.999-04:00")
        XCTAssertEqual(atNoon, "2026-04-18")
        XCTAssertEqual(justBefore, "2026-04-17")
    }

    func testWindowIsExactInverseOfBucket() {
        let bucket = "2026-04-18"
        guard let window = SleepNightBucketer.window(forBucket: bucket, calendar: calendar) else {
            return XCTFail("expected a window")
        }
        XCTAssertEqual(window.start, date("2026-04-18T12:00:00.000-04:00"))
        XCTAssertEqual(window.end, date("2026-04-19T12:00:00.000-04:00"))

        // Round-trip: every sample whose start falls in this exact
        // window must bucket back to the same key.
        XCTAssertEqual(SleepNightBucketer.nightBucket(forStart: window.start, calendar: calendar), bucket)
        let justBeforeEnd = window.end.addingTimeInterval(-1)
        XCTAssertEqual(SleepNightBucketer.nightBucket(forStart: justBeforeEnd, calendar: calendar), bucket)
    }

    func testMalformedBucketKeyReturnsNilWindow() {
        XCTAssertNil(SleepNightBucketer.window(forBucket: "not-a-date", calendar: calendar))
    }

    private func nightBucket(_ iso: String) -> String {
        SleepNightBucketer.nightBucket(forStart: date(iso), calendar: calendar)
    }

    // MARK: - Summarize: staged vs. coarse

    func testStagedNightRollsUpEachStageAndTotals() throws {
        let samples = [
            sample(id: "1", stage: "inBed", start: "2026-04-18T23:00:00.000-04:00", end: "2026-04-19T07:00:00.000-04:00"),
            sample(id: "2", stage: "asleepCore", start: "2026-04-18T23:05:00.000-04:00", end: "2026-04-19T01:05:00.000-04:00"),
            sample(id: "3", stage: "awake", start: "2026-04-19T01:05:00.000-04:00", end: "2026-04-19T01:15:00.000-04:00"),
            sample(id: "4", stage: "asleepDeep", start: "2026-04-19T01:15:00.000-04:00", end: "2026-04-19T02:15:00.000-04:00"),
            sample(id: "5", stage: "asleepREM", start: "2026-04-19T02:15:00.000-04:00", end: "2026-04-19T03:15:00.000-04:00"),
            sample(id: "6", stage: "asleepCore", start: "2026-04-19T03:15:00.000-04:00", end: "2026-04-19T06:15:00.000-04:00"),
        ]
        let summary = try XCTUnwrap(SleepNightBucketer.summarize(bucketDate: "2026-04-18", samples: samples))

        XCTAssertTrue(summary.isStaged)
        XCTAssertEqual(summary.coreSeconds, 5 * 3600, accuracy: 0.5) // 2h (block 1) + 3h (block 2)
        XCTAssertEqual(summary.deepSeconds, 3600, accuracy: 0.5)
        XCTAssertEqual(summary.remSeconds, 3600, accuracy: 0.5)
        XCTAssertEqual(summary.unspecifiedAsleepSeconds, 0)
        XCTAssertEqual(summary.awakeSeconds, 600, accuracy: 0.5) // 10 min gap
        XCTAssertEqual(summary.totalAsleepSeconds, 7 * 3600, accuracy: 0.5)
        // One awakening strictly between first asleep-onset (23:05) and
        // last asleep-offset (06:15).
        XCTAssertEqual(summary.awakeningsCount, 1)
        // Min/max span every sample regardless of stage — the widest is
        // the `inBed` marker itself (23:00 → 07:00 local = 03:00 → 11:00 UTC).
        XCTAssertEqual(summary.inBedStart, "2026-04-19T03:00:00.000Z")
        XCTAssertEqual(summary.inBedEnd, "2026-04-19T11:00:00.000Z")
    }

    func testCoarseNightHasNoStagedSecondsAndFallsBackToUnspecified() throws {
        let samples = [
            sample(id: "1", stage: "inBed", start: "2026-04-18T23:00:00.000-04:00", end: "2026-04-19T07:00:00.000-04:00"),
            sample(id: "2", stage: "asleepUnspecified", start: "2026-04-18T23:05:00.000-04:00", end: "2026-04-19T06:55:00.000-04:00"),
        ]
        let summary = try XCTUnwrap(SleepNightBucketer.summarize(bucketDate: "2026-04-18", samples: samples))

        XCTAssertFalse(summary.isStaged)
        XCTAssertEqual(summary.coreSeconds, 0)
        XCTAssertEqual(summary.deepSeconds, 0)
        XCTAssertEqual(summary.remSeconds, 0)
        XCTAssertGreaterThan(summary.unspecifiedAsleepSeconds, 0)
        XCTAssertEqual(summary.awakeningsCount, 0, "no awake stage logged at all")
    }

    func testZeroAwakeningsWhenNoMidNightWakeLogged() {
        let samples = [
            sample(id: "1", stage: "asleepCore", start: "2026-04-18T23:00:00.000-04:00", end: "2026-04-19T07:00:00.000-04:00"),
        ]
        let summary = SleepNightBucketer.summarize(bucketDate: "2026-04-18", samples: samples)
        XCTAssertEqual(summary?.awakeningsCount, 0)
    }

    func testMissingStagesAreOmittedFromTheSummaryNotFabricated() {
        // Only Core + REM logged (no Deep, no in-between Awake) — Deep
        // must stay exactly zero, not interpolated.
        let samples = [
            sample(id: "1", stage: "asleepCore", start: "2026-04-18T23:00:00.000-04:00", end: "2026-04-19T02:00:00.000-04:00"),
            sample(id: "2", stage: "asleepREM", start: "2026-04-19T02:00:00.000-04:00", end: "2026-04-19T07:00:00.000-04:00"),
        ]
        let summary = SleepNightBucketer.summarize(bucketDate: "2026-04-18", samples: samples)
        XCTAssertEqual(summary?.deepSeconds, 0)
        XCTAssertGreaterThan(summary?.coreSeconds ?? 0, 0)
        XCTAssertGreaterThan(summary?.remSeconds ?? 0, 0)
    }

    // MARK: - Sub-threshold nap filtering

    func testSubThresholdNapReturnsNil() {
        let samples = [
            sample(id: "1", stage: "asleepCore", start: "2026-04-18T14:00:00.000-04:00", end: "2026-04-18T14:20:00.000-04:00"),
        ]
        let summary = SleepNightBucketer.summarize(
            bucketDate: "2026-04-18", samples: samples, minimumAsleepSeconds: 3600
        )
        XCTAssertNil(summary, "a 20-minute nap must not mint a night document")
    }

    func testEmptySamplesReturnsNil() {
        XCTAssertNil(SleepNightBucketer.summarize(bucketDate: "2026-04-18", samples: []))
    }

    func testQualifyingDurationFallsBackToInBedSpanWhenNoStageIsAsleep() {
        // Only `inBed`/`awake` logged, zero total asleep seconds — the
        // qualifying-duration check must fall back to the in-bed span
        // rather than treating this as an instant nap.
        let samples = [
            sample(id: "1", stage: "inBed", start: "2026-04-18T23:00:00.000-04:00", end: "2026-04-19T07:00:00.000-04:00"),
        ]
        let summary = SleepNightBucketer.summarize(bucketDate: "2026-04-18", samples: samples)
        XCTAssertNotNil(summary, "an 8-hour in-bed span qualifies even with zero staged asleep seconds")
    }
}
