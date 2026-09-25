// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class BriefsFeedStateTests: XCTestCase {
    private func brief(_ id: String, state: BriefReadState = .unread) -> BriefRecord {
        BriefRecord(
            id: id,
            kind: .info,
            state: state,
            title: "Title \(id)",
            description: "Description \(id)",
            body: nil,
            confidence: 0.5,
            urgency: 0.5,
            createdAt: "2026-07-02T10:00:00.000Z",
            eventAt: nil,
            relevantUntil: nil,
            citations: []
        )
    }

    // MARK: - Loading

    func testSilentRefreshCompletionClearsSupersededInitialLoadingIndicator() {
        var state = BriefsFeedLoadingState()
        state.begin(showIndicator: true)
        state.begin(showIndicator: false)

        state.finishOwnedRefresh()

        XCTAssertFalse(state.isLoading)
    }

    // MARK: - Lookup

    func testBriefWithIdFindsAndMissesReturnNil() {
        let state = BriefsFeedState(briefs: [brief("a"), brief("b")])
        XCTAssertEqual(state.brief(withId: "b")?.id, "b")
        XCTAssertNil(state.brief(withId: "missing"))
    }

    func testEmptyFeed() {
        var state = BriefsFeedState(briefs: [])
        XCTAssertTrue(state.isEmpty)
        XCTAssertNil(state.brief(withId: "a"))
        XCTAssertFalse(state.markViewed(id: "a"))
        state.remove(id: "a")
        XCTAssertTrue(state.isEmpty)
    }

    // MARK: - Pagination

    func testAppendPagePreservesOrderAndDeduplicatesExistingBriefs() {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b")])

        state.appendPage([brief("b", state: .read), brief("c"), brief("d")])

        XCTAssertEqual(state.briefs.map(\.id), ["a", "b", "c", "d"])
        XCTAssertTrue(state.isUnread(id: "b"), "a duplicate page row must not replace local state")
    }

    func testAppendPageSeedsReadStateForNewBriefs() {
        var state = BriefsFeedState(briefs: [brief("a")])

        state.appendPage([brief("b", state: .read), brief("c")])

        XCTAssertFalse(state.isUnread(id: "b"))
        XCTAssertFalse(state.markViewed(id: "b"))
        XCTAssertTrue(state.isUnread(id: "c"))
        XCTAssertTrue(state.markViewed(id: "c"))
    }

    func testDismissRollbackRemainsValidAfterAppendingAPage() throws {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b"), brief("c")])
        let removed = try XCTUnwrap(state.remove(id: "b"))
        state.appendPage([brief("d"), brief("e")])

        state.restore(removed)

        XCTAssertEqual(state.briefs.map(\.id), ["a", "b", "c", "d", "e"])
    }

    // MARK: - Read marking

    func testMarkViewedFiresOncePerUnreadBrief() {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b")])
        XCTAssertTrue(state.isUnread(id: "a"))

        // First open of an unread brief owes a POST — exactly once.
        XCTAssertTrue(state.markViewed(id: "a"))
        XCTAssertFalse(state.markViewed(id: "a"))
        XCTAssertFalse(state.isUnread(id: "a"))

        // The other brief is untouched.
        XCTAssertTrue(state.isUnread(id: "b"))
        XCTAssertTrue(state.markViewed(id: "b"))
    }

    func testBriefsArrivingReadAreNeverMarked() {
        var state = BriefsFeedState(briefs: [brief("a", state: .read), brief("b")])
        // "a" was counted on an earlier visit — nothing owed, not unread.
        XCTAssertFalse(state.isUnread(id: "a"))
        XCTAssertFalse(state.markViewed(id: "a"))
        XCTAssertTrue(state.markViewed(id: "b"))
    }

    func testMarkViewedUnknownIdOwesNothing() {
        var state = BriefsFeedState(briefs: [brief("a")])
        XCTAssertFalse(state.markViewed(id: "ghost"))
    }

    // MARK: - Dismissal

    func testRemoveDropsTheBriefAndKeepsTheRest() {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b"), brief("c")])
        let removed = state.remove(id: "b")
        XCTAssertEqual(removed?.brief.id, "b")
        XCTAssertEqual(removed?.index, 1)
        XCTAssertEqual(state.briefs.map(\.id), ["a", "c"])
        XCTAssertEqual(state.count, 2)
    }

    func testRemovingTheOnlyBriefEmptiesTheFeed() {
        var state = BriefsFeedState(briefs: [brief("a")])
        state.remove(id: "a")
        XCTAssertTrue(state.isEmpty)
    }

    func testRemoveUnknownIdIsANoOp() {
        var state = BriefsFeedState(briefs: [brief("a")])
        XCTAssertNil(state.remove(id: "ghost"))
        XCTAssertEqual(state.count, 1)
    }

    func testRestoreReinsertsRemovedBriefAtOriginalPosition() throws {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b"), brief("c")])
        let removed = state.remove(id: "b")

        try state.restore(XCTUnwrap(removed))

        XCTAssertEqual(state.briefs.map(\.id), ["a", "b", "c"])
    }

    func testRestoreClampsIndexAfterLaterFeedChanges() throws {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b"), brief("c")])
        let removed = state.remove(id: "c")
        _ = state.remove(id: "b")

        try state.restore(XCTUnwrap(removed))

        XCTAssertEqual(state.briefs.map(\.id), ["a", "c"])
    }

    func testRestoreUsesSurvivingNeighborAfterEarlierBriefRemoved() throws {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b"), brief("c")])
        let removed = state.remove(id: "b")
        _ = state.remove(id: "a")

        try state.restore(XCTUnwrap(removed))

        XCTAssertEqual(state.briefs.map(\.id), ["b", "c"])
    }

    func testRestoreOrdersAdjacentRemovalsByOriginalFeedOrder() throws {
        var restoreFirstRemovalFirst = BriefsFeedState(
            briefs: [brief("a"), brief("b"), brief("c"), brief("d")]
        )
        let firstB = restoreFirstRemovalFirst.remove(id: "b")
        let firstC = restoreFirstRemovalFirst.remove(id: "c")

        try restoreFirstRemovalFirst.restore(XCTUnwrap(firstB))
        try restoreFirstRemovalFirst.restore(XCTUnwrap(firstC))

        XCTAssertEqual(restoreFirstRemovalFirst.briefs.map(\.id), ["a", "b", "c", "d"])

        var restoreSecondRemovalFirst = BriefsFeedState(
            briefs: [brief("a"), brief("b"), brief("c"), brief("d")]
        )
        let secondB = restoreSecondRemovalFirst.remove(id: "b")
        let secondC = restoreSecondRemovalFirst.remove(id: "c")

        try restoreSecondRemovalFirst.restore(XCTUnwrap(secondC))
        try restoreSecondRemovalFirst.restore(XCTUnwrap(secondB))

        XCTAssertEqual(restoreSecondRemovalFirst.briefs.map(\.id), ["a", "b", "c", "d"])
    }

    func testRestoreFromPreviousFeedIsNoOp() throws {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b"), brief("c")])
        let removed = state.remove(id: "b")

        state = BriefsFeedState(briefs: [brief("a"), brief("c")])
        try state.restore(XCTUnwrap(removed))

        XCTAssertEqual(state.briefs.map(\.id), ["a", "c"])
    }

    func testRestorePreservesReadState() throws {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b")])
        XCTAssertTrue(state.markViewed(id: "b"))
        let removed = state.remove(id: "b")

        try state.restore(XCTUnwrap(removed))

        XCTAssertFalse(state.isUnread(id: "b"))
        XCTAssertFalse(state.markViewed(id: "b"))
    }

    func testRestoreSkipsBriefAlreadyPresent() throws {
        var state = BriefsFeedState(briefs: [brief("a"), brief("b")])
        let removed = state.remove(id: "b")

        let unwrapped = try XCTUnwrap(removed)
        state.restore(unwrapped)
        state.restore(unwrapped)

        XCTAssertEqual(state.briefs.map(\.id), ["a", "b"])
    }

    // MARK: - Row description plain-texting

    func testPlainDescriptionStripsEmphasisMarkers() {
        XCTAssertEqual(
            briefRowPlainDescription("The **marathon** entry closes __Friday__."),
            "The marathon entry closes Friday."
        )
        XCTAssertEqual(briefRowPlainDescription("No markdown here."), "No markdown here.")
    }

    // MARK: - Snooze choices

    private var utcCalendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }

    func testLaterTodayIsThreeHoursOut() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let resolved = BriefSnoozeChoice.laterToday.resolvedTime(now: now, calendar: utcCalendar)
        XCTAssertEqual(resolved, now.addingTimeInterval(3 * 3600))
    }

    func testTomorrowIsNineAmNextCalendarDay() throws {
        let cal = utcCalendar
        // 2026-07-02T22:30:00Z — late enough that "+3h" would cross midnight.
        let now = try XCTUnwrap(
            cal.date(from: DateComponents(year: 2026, month: 7, day: 2, hour: 22, minute: 30))
        )
        let resolved = try XCTUnwrap(
            BriefSnoozeChoice.tomorrow.resolvedTime(now: now, calendar: cal)
        )
        let parts = cal.dateComponents([.year, .month, .day, .hour, .minute], from: resolved)
        XCTAssertEqual(parts.year, 2026)
        XCTAssertEqual(parts.month, 7)
        XCTAssertEqual(parts.day, 3)
        XCTAssertEqual(parts.hour, 9)
        XCTAssertEqual(parts.minute, 0)
    }

    func testPickATimePassesThrough() {
        let picked = Date(timeIntervalSince1970: 1_795_000_000)
        XCTAssertEqual(
            BriefSnoozeChoice.pickATime(picked).resolvedTime(now: Date(), calendar: utcCalendar),
            picked
        )
    }

    func testAgentDecidesSendsNoTime() {
        XCTAssertNil(BriefSnoozeChoice.agentDecides.resolvedTime(now: Date(), calendar: utcCalendar))
    }
}
