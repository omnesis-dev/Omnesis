// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Regression coverage for the bug this type exists to fix: without an
/// accumulator, once `ActivitySegmentsCursor.lastConfirmedStart` advances
/// past a segment, a later sync rebuilding a day's document from only its
/// own newly-closed segments would silently drop everything an earlier
/// sync had already recorded for that day.
final class ActivitySegmentAccumulatorTests: XCTestCase {
    private var calendar: Calendar!
    private let base = Date(timeIntervalSinceReferenceDate: 800_000_000) // a Tuesday, well clear of any DST edge

    override func setUp() {
        super.setUp()
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        calendar = cal
    }

    private func at(_ seconds: Int) -> Date {
        base.addingTimeInterval(TimeInterval(seconds))
    }

    private func segment(_ type: MotionActivityType, _ startSeconds: Int, _ endSeconds: Int) -> ActivitySegment {
        ActivitySegment(type: type, start: at(startSeconds), end: at(endSeconds), confidence: .high)
    }

    func testFirstSyncWithNoPriorHistorySeedsTheAccumulator() {
        let segA = segment(.walking, 0, 600)
        let segB = segment(.stationary, 600, 1200)

        let outcome = ActivitySegmentAccumulator.apply(
            newlyClosed: [segA, segB], pending: [], previousWatermark: nil, calendar: calendar
        )

        XCTAssertEqual(outcome.forDocuments, [segA, segB])
        XCTAssertEqual(outcome.newWatermark, segB.start)
    }

    func testALaterSyncThatOnlyReDerivesTheLastSegmentStillIncludesEarlierHistory() {
        // sync 1: closes segA and segB, watermark advances to segB.start.
        let segA = segment(.walking, 0, 600)
        let segB = segment(.stationary, 600, 1200)
        let sync1 = ActivitySegmentAccumulator.apply(
            newlyClosed: [segA, segB], pending: [], previousWatermark: nil, calendar: calendar
        )
        XCTAssertEqual(sync1.newPending, [segA, segB])

        // sync 2: the query window now starts at segB.start (per
        // ActivitySegmentsSource), so segA's samples are never re-seen —
        // only segB (re-derived identically) and the newly-closed segC come back.
        let segBReDerived = segment(.stationary, 600, 1200)
        let segC = segment(.automotive, 1200, 1800)
        let sync2 = ActivitySegmentAccumulator.apply(
            newlyClosed: [segBReDerived, segC],
            pending: sync1.newPending,
            previousWatermark: sync1.newWatermark,
            calendar: calendar
        )

        // This is the regression this type exists to prevent: segA must
        // still be present even though it never appeared in sync2's own window.
        XCTAssertEqual(sync2.forDocuments, [segA, segBReDerived, segC])
        XCTAssertEqual(sync2.newWatermark, segC.start)
    }

    func testReDerivingAnAlreadyAccumulatedSegmentReplacesRatherThanDuplicates() {
        let segA = segment(.walking, 0, 600)
        let sync1 = ActivitySegmentAccumulator.apply(
            newlyClosed: [segA], pending: [], previousWatermark: nil, calendar: calendar
        )

        // Same type + start, slightly refined end (as if a later query
        // resolved the exact boundary a little differently).
        let segARefined = segment(.walking, 0, 610)
        let sync2 = ActivitySegmentAccumulator.apply(
            newlyClosed: [segARefined],
            pending: sync1.newPending,
            previousWatermark: sync1.newWatermark,
            calendar: calendar
        )

        XCTAssertEqual(sync2.forDocuments, [segARefined])
    }

    func testAJitteredReDerivationOfTheSameRunningActivityMergesRatherThanDuplicates() {
        // Real on-device behavior: CMMotionActivityManager revised a
        // continuous stationary stretch's boundary by a few seconds on
        // each successive read, even though it's the same real period —
        // an exact-start match would miss this and pile up near-duplicates.
        let segA = segment(.stationary, 0, 180)
        let sync1 = ActivitySegmentAccumulator.apply(
            newlyClosed: [segA], pending: [], previousWatermark: nil, calendar: calendar
        )

        let segAJittered = segment(.stationary, 3, 183)
        let sync2 = ActivitySegmentAccumulator.apply(
            newlyClosed: [segAJittered],
            pending: sync1.newPending,
            previousWatermark: sync1.newWatermark,
            calendar: calendar
        )

        XCTAssertEqual(
            sync2.forDocuments.count,
            1,
            "an overlapping re-derivation of the same activity must fold into one segment, not accumulate a second entry"
        )
        XCTAssertEqual(sync2.forDocuments, [segment(.stationary, 0, 183)])

        // A third read jitters again, still overlapping — still one segment.
        let segAJitteredAgain = segment(.stationary, 5, 190)
        let sync3 = ActivitySegmentAccumulator.apply(
            newlyClosed: [segAJitteredAgain],
            pending: sync2.newPending,
            previousWatermark: sync2.newWatermark,
            calendar: calendar
        )
        XCTAssertEqual(sync3.forDocuments, [segment(.stationary, 0, 190)])
    }

    func testANonOverlappingSameTypeSegmentLaterInTheDayIsKeptDistinct() {
        // Two genuinely separate stationary spells hours apart must NOT
        // be merged just because they share a type.
        let morning = segment(.stationary, 0, 600)
        let sync1 = ActivitySegmentAccumulator.apply(
            newlyClosed: [morning], pending: [], previousWatermark: nil, calendar: calendar
        )

        let afternoon = segment(.stationary, 20000, 20600)
        let sync2 = ActivitySegmentAccumulator.apply(
            newlyClosed: [afternoon],
            pending: sync1.newPending,
            previousWatermark: sync1.newWatermark,
            calendar: calendar
        )

        XCTAssertEqual(sync2.forDocuments, [morning, afternoon])
    }

    func testASegmentIsPrunedOnlyOnceItsWholeDayIsBehindTheNewWatermark() {
        // Two segments on the same day; watermark lands on that same day
        // after the first sync — nothing should be pruned yet.
        let segA = segment(.walking, 0, 600)
        let segB = segment(.stationary, 600, 1200)
        let sync1 = ActivitySegmentAccumulator.apply(
            newlyClosed: [segA, segB], pending: [], previousWatermark: nil, calendar: calendar
        )
        XCTAssertEqual(sync1.newPending, [segA, segB], "same-day segments must not be pruned while their day is still current")

        // A segment on the NEXT day closes — only then is the earlier
        // day's history safe to drop, since it can never be queried again.
        let oneDaySeconds = 86400
        let nextDay = segment(.running, 1200 + oneDaySeconds, 1800 + oneDaySeconds)
        let sync2 = ActivitySegmentAccumulator.apply(
            newlyClosed: [nextDay], pending: sync1.newPending, previousWatermark: sync1.newWatermark, calendar: calendar
        )

        XCTAssertEqual(sync2.newPending, [nextDay], "the prior day's segments should be pruned once the watermark moves to a later day")
        // But the document for the (now-finalized) prior day was still
        // built, in the same sync, from its complete history.
        XCTAssertEqual(sync2.forDocuments, [segA, segB, nextDay])
    }

    func testNothingClosedLeavesTheAccumulatorAndWatermarkUnchanged() {
        let segA = segment(.walking, 0, 600)
        let sync1 = ActivitySegmentAccumulator.apply(
            newlyClosed: [segA], pending: [], previousWatermark: nil, calendar: calendar
        )

        let sync2 = ActivitySegmentAccumulator.apply(
            newlyClosed: [], pending: sync1.newPending, previousWatermark: sync1.newWatermark, calendar: calendar
        )

        XCTAssertEqual(sync2.newWatermark, sync1.newWatermark)
        XCTAssertEqual(sync2.newPending, [segA])
        XCTAssertEqual(sync2.forDocuments, [segA])
    }

    func testOvernightHistorySurvivesLaterSyncsWithoutRewritingTheFinishedDay() throws {
        try assertOvernightHistory(day: DateComponents(year: 2026, month: 2, day: 12), expectedHours: 4)
    }

    func testOvernightHistorySurvivesTheSpringDSTBoundary() throws {
        try assertOvernightHistory(day: DateComponents(year: 2026, month: 3, day: 8), expectedHours: 3)
    }

    func testOvernightHistorySurvivesTheAutumnDSTBoundary() throws {
        try assertOvernightHistory(day: DateComponents(year: 2026, month: 11, day: 1), expectedHours: 5)
    }

    private func assertOvernightHistory(day: DateComponents, expectedHours: Double) throws {
        let midnight = try XCTUnwrap(calendar.date(from: day))
        let end = try XCTUnwrap(calendar.date(bySettingHour: 4, minute: 0, second: 0, of: midnight))
        let earlier = ActivitySegment(
            type: .walking,
            start: midnight.addingTimeInterval(-7200),
            end: midnight.addingTimeInterval(-3600),
            confidence: .high
        )
        let overnight = ActivitySegment(
            type: .stationary, start: earlier.end, end: end, confidence: .high
        )
        let morning = ActivitySegment(
            type: .running, start: end, end: end.addingTimeInterval(600), confidence: .high
        )
        let first = ActivitySegmentAccumulator.apply(
            newlyClosed: [earlier, overnight], pending: [], previousWatermark: nil, calendar: calendar
        )
        let second = ActivitySegmentAccumulator.apply(
            newlyClosed: [overnight, morning],
            pending: first.newPending,
            previousWatermark: first.newWatermark,
            calendar: calendar
        )
        XCTAssertEqual(second.forDocuments, [earlier, overnight, morning])
        let retained = ActivitySegment(
            type: .stationary, start: midnight, end: end, confidence: .high
        )
        XCTAssertEqual(second.newPending, [retained, morning])
        XCTAssertEqual(retained.durationSeconds, expectedHours * 3600)

        // Even a no-new-activity sync must retain the overnight portion of
        // today's document, without emitting a partial rewrite of yesterday.
        let third = ActivitySegmentAccumulator.apply(
            newlyClosed: [],
            pending: second.newPending,
            previousWatermark: second.newWatermark,
            calendar: calendar
        )
        XCTAssertEqual(third.forDocuments, [retained, morning])
        let days = ActivitySegmentMerger.splitByDay(third.forDocuments, calendar: calendar)
        XCTAssertEqual(days.count, 1)
        XCTAssertEqual(days.first?.day, midnight)
        XCTAssertEqual(days.first?.segments, [retained, morning])
        let docs = ActivitySegmentDocumentBuilder.dailyDocuments(
            from: third.forDocuments,
            calendar: calendar,
            providerId: "activity-segments:local",
            sourceId: "activity-segments:local"
        )
        XCTAssertEqual(docs.count, 1)
        XCTAssertTrue(try XCTUnwrap(docs.first).content.contains("Stationary"))

        // The native query can return the original overnight interval even
        // though the document accumulator has already finalized yesterday.
        let replay = ActivitySegmentAccumulator.apply(
            newlyClosed: [overnight],
            pending: third.newPending,
            previousWatermark: third.newWatermark,
            calendar: calendar
        )
        XCTAssertEqual(replay.forDocuments, [retained, morning])
        XCTAssertEqual(replay.newWatermark, third.newWatermark)
        XCTAssertEqual(ActivitySegmentMerger.splitByDay(replay.forDocuments, calendar: calendar).map(\.day), [midnight])
    }

    func testAnIntervalEndingExactlyAtMidnightIsNotCarriedIntoTheNextDay() throws {
        let midnight = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 2, day: 12)))
        let previousDay = ActivitySegment(
            type: .stationary, start: midnight.addingTimeInterval(-3600), end: midnight, confidence: .high
        )
        let nextDay = ActivitySegment(
            type: .walking, start: midnight, end: midnight.addingTimeInterval(600), confidence: .high
        )
        let outcome = ActivitySegmentAccumulator.apply(
            newlyClosed: [nextDay], pending: [previousDay], previousWatermark: previousDay.start, calendar: calendar
        )
        XCTAssertEqual(outcome.forDocuments, [previousDay, nextDay])
        XCTAssertEqual(outcome.newPending, [nextDay])
    }

    func testMidnightBoundaryJitterCannotReopenAFinalizedDayOnLaterSyncs() throws {
        let midnight = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 2, day: 12)))
        let retained = ActivitySegment(
            type: .stationary, start: midnight, end: midnight.addingTimeInterval(600), confidence: .high
        )
        let revised = ActivitySegment(
            type: .stationary, start: midnight.addingTimeInterval(-3), end: retained.end, confidence: .high
        )
        let first = ActivitySegmentAccumulator.apply(
            newlyClosed: [revised], pending: [retained], previousWatermark: midnight, calendar: calendar
        )
        XCTAssertEqual(first.forDocuments, [retained])
        XCTAssertEqual(first.newWatermark, midnight)
        let second = ActivitySegmentAccumulator.apply(
            newlyClosed: [revised],
            pending: first.newPending,
            previousWatermark: first.newWatermark,
            calendar: calendar
        )
        XCTAssertEqual(second.forDocuments, [retained])
        XCTAssertEqual(second.newWatermark, midnight)
    }
}
