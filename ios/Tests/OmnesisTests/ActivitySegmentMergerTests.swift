// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Uses a PINNED calendar/time zone (not `.current`) for the
/// day-boundary-clipping tests, mirroring `SleepNightBucketerTests`.
final class ActivitySegmentMergerTests: XCTestCase {
    private var calendar: Calendar!

    override func setUp() {
        super.setUp()
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        calendar = cal
    }

    private func date(_ offsetMinutes: Int, from base: Date) -> Date {
        base.addingTimeInterval(TimeInterval(offsetMinutes * 60))
    }

    private func dateOffset(seconds: Int) -> Date {
        base.addingTimeInterval(TimeInterval(seconds))
    }

    private func sampleAt(
        seconds: Int,
        type: MotionActivityType,
        confidence: MotionActivityConfidence = .high
    )
        -> MotionActivitySample {
        MotionActivitySample(
            startDate: dateOffset(seconds: seconds),
            stationary: type == .stationary,
            walking: type == .walking,
            running: type == .running,
            automotive: type == .automotive,
            cycling: type == .cycling,
            confidence: confidence
        )
    }

    private let base = Date(timeIntervalSinceReferenceDate: 800_000_000)

    private func sample(
        _ minutes: Int,
        type: MotionActivityType,
        confidence: MotionActivityConfidence = .high
    )
        -> MotionActivitySample {
        MotionActivitySample(
            startDate: date(minutes, from: base),
            stationary: type == .stationary,
            walking: type == .walking,
            running: type == .running,
            automotive: type == .automotive,
            cycling: type == .cycling,
            confidence: confidence
        )
    }

    // MARK: - Contiguous-type merge

    func testConsecutiveSameTypeSamplesMergeIntoOneSegment() {
        let now = date(90, from: base)
        let samples = [
            sample(0, type: .automotive),
            sample(20, type: .automotive),
            sample(40, type: .automotive),
            sample(60, type: .walking), // closes the automotive run, opens the tail
        ]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)

        XCTAssertEqual(outcome.closedSegments.count, 1)
        let segment = outcome.closedSegments[0]
        XCTAssertEqual(segment.type, .automotive)
        XCTAssertEqual(segment.start, date(0, from: base))
        XCTAssertEqual(segment.end, date(60, from: base))
        XCTAssertEqual(segment.durationSeconds, 60 * 60, accuracy: 0.5)
        // openTailStart is the walking run that's still open at `now`.
        XCTAssertEqual(outcome.openTailStart, date(60, from: base))
    }

    func testDifferentTypesProduceSeparateSegments() {
        let now = date(90, from: base)
        let samples = [
            sample(0, type: .walking),
            sample(30, type: .running),
            sample(60, type: .stationary),
        ]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)
        // Walking and running both close (each ≥ minimumSegmentSeconds);
        // stationary is the still-open tail.
        XCTAssertEqual(outcome.closedSegments.map(\.type), [.walking, .running])
        XCTAssertEqual(outcome.openTailStart, date(60, from: base))
    }

    // MARK: - Sub-floor drop (confidence + duration)

    func testLowConfidenceSamplesAreDroppedBeforeMerging() {
        let now = date(90, from: base)
        let samples = [
            sample(0, type: .automotive),
            sample(20, type: .walking, confidence: .low), // dropped — doesn't split the run
            sample(40, type: .automotive),
            sample(60, type: .stationary),
        ]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)
        XCTAssertEqual(outcome.closedSegments.count, 1)
        XCTAssertEqual(outcome.closedSegments[0].type, .automotive)
        XCTAssertEqual(outcome.closedSegments[0].end, date(60, from: base))
    }

    func testSegmentShorterThanFloorIsDroppedAsNoise() {
        let now = dateOffset(seconds: 100)
        let samples = [
            sampleAt(seconds: 0, type: .walking),
            sampleAt(seconds: 30, type: .stationary), // walking only lasted 30s — below the 60s floor
        ]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)
        XCTAssertTrue(outcome.closedSegments.isEmpty, "a 30s run must not survive the minimum-duration floor")
        XCTAssertEqual(outcome.openTailStart, dateOffset(seconds: 30))
    }

    // MARK: - Type-flicker coalescing

    func testASubFloorInterruptingRunOfADifferentTypeDoesNotSplitTheSurroundingSameTypeSegment() {
        // Real on-device behavior: a brief (sub-floor) reclassification
        // between two stretches of the same real activity splits
        // `mergedRuns` into two runs of that type with a small gap
        // between them (the interrupting run's own span) — not an
        // overlap, since consecutive runs from one merge() call are
        // exactly adjacent by construction. Without coalescing, this
        // surfaced as the SAME displayed activity appearing as two (or,
        // over repeated flicker, many) separate closed segments.
        let now = dateOffset(seconds: 500)
        let samples = [
            sampleAt(seconds: 0, type: .automotive),
            sampleAt(seconds: 170, type: .walking), // only lasts 30s — below the floor
            sampleAt(seconds: 200, type: .automotive),
            sampleAt(seconds: 400, type: .stationary), // closes the second automotive run, opens the tail
        ]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)

        XCTAssertEqual(outcome.closedSegments.count, 1, "the two automotive runs must coalesce into one, not surface as separate segments")
        let segment = outcome.closedSegments[0]
        XCTAssertEqual(segment.type, .automotive)
        XCTAssertEqual(segment.start, dateOffset(seconds: 0))
        XCTAssertEqual(segment.end, dateOffset(seconds: 400))
    }

    func testAnInterruptingRunThatClearsTheFloorKeepsItsNeighborsDistinct() {
        // The interrupting run here is real (100s, clears the 60s floor),
        // not noise — its neighbors on either side must stay separate
        // segments rather than being bridged across it.
        let now = dateOffset(seconds: 900)
        let samples = [
            sampleAt(seconds: 0, type: .stationary),
            sampleAt(seconds: 600, type: .walking),
            sampleAt(seconds: 700, type: .stationary),
            sampleAt(seconds: 800, type: .walking), // opens the tail
        ]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)

        XCTAssertEqual(outcome.closedSegments.map(\.type), [.stationary, .walking, .stationary])
        XCTAssertEqual(outcome.closedSegments[0].end, dateOffset(seconds: 600))
        XCTAssertEqual(outcome.closedSegments[2].start, dateOffset(seconds: 700))
        XCTAssertEqual(outcome.closedSegments[2].end, dateOffset(seconds: 800))
    }

    func testSegmentAtExactlyTheFloorIsKept() {
        let now = date(Int(ActivitySegmentMerger.minimumSegmentSeconds / 60) + 10, from: base)
        let samples = [
            sample(0, type: .walking),
            sample(Int(ActivitySegmentMerger.minimumSegmentSeconds / 60), type: .running),
        ]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)
        XCTAssertEqual(outcome.closedSegments.count, 1)
        XCTAssertEqual(outcome.closedSegments[0].durationSeconds, ActivitySegmentMerger.minimumSegmentSeconds, accuracy: 0.5)
    }

    // MARK: - Open-tail held back

    func testSingleSampleIsEntirelyTheOpenTail() {
        let now = date(45, from: base)
        let samples = [sample(0, type: .walking)]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)
        XCTAssertTrue(outcome.closedSegments.isEmpty)
        XCTAssertEqual(outcome.openTailStart, date(0, from: base))
    }

    func testEmptySamplesProduceNoOutcome() {
        let outcome = ActivitySegmentMerger.merge(samples: [], now: date(0, from: base))
        XCTAssertTrue(outcome.closedSegments.isEmpty)
        XCTAssertNil(outcome.openTailStart)
    }

    func testAllSamplesBelowConfidenceFloorLeavesNoOpenTailEither() {
        let now = date(90, from: base)
        let samples = [sample(0, type: .walking, confidence: .low)]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)
        XCTAssertTrue(outcome.closedSegments.isEmpty)
        XCTAssertNil(outcome.openTailStart)
    }

    // MARK: - Confidence tiering

    func testDominantTypePicksAutomotiveOverWalkingAmbiguity() {
        let sample = MotionActivitySample(startDate: base, walking: true, automotive: true, confidence: .high)
        XCTAssertEqual(sample.dominantType, .automotive, "the train scenario: automotive wins over an ambiguous walking flag")
    }

    func testDominantTypeFallsBackToUnknownWhenNoFlagIsSet() {
        let sample = MotionActivitySample(startDate: base, confidence: .medium)
        XCTAssertEqual(sample.dominantType, .unknown)
    }

    func testDominantTypeUnknownFlagWinsOverEverythingElse() {
        let sample = MotionActivitySample(startDate: base, unknown: true, walking: true, confidence: .low)
        XCTAssertEqual(sample.dominantType, .unknown)
    }

    func testMergedRunConfidenceIsTheLowestAmongItsSamples() {
        let now = date(60, from: base)
        let samples = [
            sample(0, type: .walking, confidence: .high),
            sample(20, type: .walking, confidence: .medium),
            sample(40, type: .stationary),
        ]
        let outcome = ActivitySegmentMerger.merge(samples: samples, now: now)
        XCTAssertEqual(outcome.closedSegments[0].confidence, .medium)
    }

    // MARK: - Day-boundary clipping (splitByDay)

    func testSplitByDayClipsASegmentSpanningMidnightIntoTwoPieces() throws {
        // 23:00 on the 18th through 01:00 on the 19th, America/New_York.
        let formatter = DateFormatter()
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZZZZZ"
        // swiftlint:disable:next force_unwrapping
        let start = try XCTUnwrap(formatter.date(from: "2026-04-18T23:00:00-04:00"))
        // swiftlint:disable:next force_unwrapping
        let end = try XCTUnwrap(formatter.date(from: "2026-04-19T01:00:00-04:00"))
        let segment = ActivitySegment(type: .stationary, start: start, end: end, confidence: .high)

        let byDay = ActivitySegmentMerger.splitByDay([segment], calendar: calendar)

        XCTAssertEqual(byDay.count, 2)
        let firstPiece = byDay[0].segments[0]
        let secondPiece = byDay[1].segments[0]
        XCTAssertEqual(firstPiece.start, start)
        XCTAssertEqual(secondPiece.end, end)
        // The pieces are contiguous — the split point is exactly midnight.
        XCTAssertEqual(firstPiece.end, secondPiece.start)
        XCTAssertEqual(firstPiece.type, .stationary)
        XCTAssertEqual(secondPiece.type, .stationary)
    }

    func testSplitByDaySegmentWithinOneDayIsNotSplit() {
        let start = date(0, from: base)
        let end = date(30, from: base)
        let segment = ActivitySegment(type: .walking, start: start, end: end, confidence: .high)
        let byDay = ActivitySegmentMerger.splitByDay([segment], calendar: calendar)
        XCTAssertEqual(byDay.count, 1)
        XCTAssertEqual(byDay[0].segments, [segment])
    }
}
