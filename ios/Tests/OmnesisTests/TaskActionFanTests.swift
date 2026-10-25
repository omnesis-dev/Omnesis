// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
@testable import Omnesis
import XCTest

final class TaskActionFanTests: XCTestCase {
    private let schedule: TaskSchedule = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London")!
        return TaskSchedule(calendar: calendar, locale: Locale(identifier: "en_GB"))
    }()

    /// A phone-sized list, pressed on a title towards the right — where a
    /// right thumb lands.
    private let bounds = CGRect(x: 0, y: 0, width: 393, height: 700)
    private let press = CGPoint(x: 290, y: 420)
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func session(
        at anchor: CGPoint? = nil,
        today: String = "2026-10-14",
        kind: TaskFanSession.Kind = .task,
        mode: TaskFanSession.Mode = .main,
        tracking: Bool = true
    )
        -> TaskFanSession {
        TaskFanSession(
            anchor: anchor ?? press,
            bounds: bounds,
            today: today,
            kind: kind,
            schedule: schedule,
            mode: mode,
            tracking: tracking
        )
    }

    private func center(_ fan: TaskFanSession, _ action: TaskFanAction) throws -> CGPoint {
        try XCTUnwrap(fan.targets.first { $0.action == action }).center
    }

    // MARK: - Layout

    func testMainFanKeepsItsOrderAndLabels() {
        let fan = session()
        XCTAssertEqual(fan.targets.map(\.action), [.done, .doneWithNote, .tomorrow, .nextMonth, .otherMonth, .cancelTask])
        XCTAssertEqual(
            fan.targets.map(\.label),
            ["Done", "Done + note", "Tomorrow", "Next month", "Other month…", "Cancel task"]
        )
    }

    /// A suggestion's fan offers to take it on, not to plan or cancel it.
    func testSuggestionFanOffersAcceptMarkDoneAndIgnore() {
        let fan = session(kind: .suggestion)
        XCTAssertEqual(fan.targets.map(\.action), [.accept, .acceptWithNote, .acceptFor, .done, .ignore])
        XCTAssertEqual(
            fan.targets.map(\.label),
            ["Accept", "Accept with note", "Accept for…", "Mark as done", "Ignore"]
        )
    }

    /// Resting on Accept for… opens the times to accept it for; its Other
    /// month… leads to the months, whose Back returns to the times.
    func testAcceptForOpensTheTimesAndTheirMonths() throws {
        var fan = session(kind: .suggestion)
        try fan.move(to: center(fan, .acceptFor), at: t0)
        XCTAssertEqual(fan.tick(at: t0.addingTimeInterval(1)), [.modeChanged(.when)])
        XCTAssertEqual(
            fan.targets.map(\.label),
            ["Back", "Today", "Tomorrow", "This month", "Next month", "Other month…", "Someday"]
        )
        var months = session(kind: .suggestion, mode: .when, tracking: false)
        XCTAssertEqual(months.tap(.otherMonth), .stayOpen)
        XCTAssertEqual(months.mode, .months(page: 0))
        XCTAssertEqual(months.tap(.back), .stayOpen)
        XCTAssertEqual(months.mode, .when, "a suggestion's months go back to its times")
        XCTAssertEqual(months.tap(.back), .stayOpen)
        XCTAssertEqual(months.mode, .main)
        XCTAssertEqual(months.tap(.ignore), .perform(.ignore))
        XCTAssertTrue(TaskFanAction.acceptFor.isNavigation)
        XCTAssertFalse(TaskFanAction.ignore.isNavigation)
    }

    /// Up and to the left of a right thumb: every label clears the touch to
    /// its left, Done is nearest, and the column leans further left as it
    /// rises.
    func testFanRisesUpAndLeftOfTheThumbWithDoneNearest() throws {
        let fan = session()
        XCTAssertTrue(fan.upwards)
        let ys = fan.targets.map(\.center.y)
        XCTAssertEqual(ys, ys.sorted(by: >), "each target sits further from the thumb than the one before")
        XCTAssertLessThan(ys[0], press.y, "Done sits above the thumb")
        for target in fan.targets {
            XCTAssertLessThan(target.frame.maxX, press.x - fan.metrics.originRadius + 4, "\(target.label) clears the thumb")
            XCTAssertTrue(bounds.contains(target.frame))
        }
        let near = try XCTUnwrap(fan.targets.first)
        let far = try XCTUnwrap(fan.targets.last)
        XCTAssertLessThan(far.frame.maxX, near.frame.maxX, "the far end leans further left")
        for (lower, upper) in zip(fan.targets, fan.targets.dropFirst()) {
            XCTAssertFalse(lower.frame.intersects(upper.frame))
        }
    }

    func testFanNearTheTopFlipsDownInTheSameOrder() {
        let fan = session(at: CGPoint(x: 290, y: 60))
        XCTAssertFalse(fan.upwards)
        let ys = fan.targets.map(\.center.y)
        XCTAssertEqual(ys, ys.sorted(), "mirrored: still nearest-first, now downwards")
        XCTAssertEqual(fan.targets.first?.action, .done)
        for target in fan.targets {
            XCTAssertTrue(bounds.contains(target.frame))
            XCTAssertLessThan(target.frame.maxX, 290, "still left of the thumb")
        }
    }

    func testFanNearTheBottomStaysInsideTheBounds() {
        let fan = session(at: CGPoint(x: 290, y: 690))
        XCTAssertTrue(fan.upwards)
        for target in fan.targets {
            XCTAssertTrue(bounds.insetBy(dx: 7, dy: 7).contains(target.frame), "\(target.label) off screen")
        }
    }

    /// A press near the left edge slides the column right to stay on
    /// screen; it never reorders or moves to the other side.
    func testPressNearTheLeftEdgeSlidesTheColumnRight() {
        let fan = session(at: CGPoint(x: 70, y: 420))
        XCTAssertEqual(fan.targets.first?.action, .done)
        for target in fan.targets {
            XCTAssertGreaterThanOrEqual(target.frame.minX, bounds.minX + fan.metrics.edgeMargin - 0.5)
        }
        let ys = fan.targets.map(\.center.y)
        XCTAssertEqual(ys, ys.sorted(by: >))
    }

    func testTallMonthFanOnAShortListSlidesIntoTheBounds() {
        let short = CGRect(x: 0, y: 0, width: 393, height: 360)
        let fan = TaskFanSession(
            anchor: CGPoint(x: 290, y: 180),
            bounds: short,
            today: "2026-10-14",
            schedule: schedule,
            mode: .months(page: 1)
        )
        let ys = fan.targets.map(\.center.y)
        XCTAssertTrue(ys == ys.sorted() || ys == ys.sorted(by: >), "order survives the slide")
        for target in fan.targets {
            XCTAssertGreaterThanOrEqual(target.frame.minY, short.minY)
        }
    }

    // MARK: - Hit testing

    func testTheTouchPointItselfSelectsNothing() throws {
        let fan = session()
        XCTAssertNil(fan.target(at: press))
        XCTAssertEqual(try fan.target(at: center(fan, .tomorrow))?.action, .tomorrow)
        XCTAssertNil(fan.target(at: CGPoint(x: 380, y: 680)), "outside every target")
    }

    // MARK: - Hold, slide, lift

    func testSlideAndLiftPerformsWithOneTickPerTarget() throws {
        var fan = session()
        let tomorrow = try center(fan, .tomorrow)
        XCTAssertEqual(fan.move(to: tomorrow, at: t0), [.selectionChanged(.tomorrow)])
        XCTAssertEqual(fan.move(to: CGPoint(x: tomorrow.x + 4, y: tomorrow.y + 2), at: t0), [], "same target, no tick")
        XCTAssertEqual(fan.highlighted, .tomorrow)
        XCTAssertEqual(fan.release(at: tomorrow, at: t0), .perform(.tomorrow))
    }

    /// The fan lives only while the finger is down: lifting where it
    /// pressed closes it with nothing changed.
    func testLiftingWithoutSlidingChangesNothing() {
        var fan = session()
        XCTAssertEqual(fan.release(at: CGPoint(x: press.x + 3, y: press.y), at: t0), .dismiss)
        XCTAssertFalse(fan.tracking)
    }

    func testReturningToTheTouchPointClearsAndLiftingThereChangesNothing() throws {
        var fan = session()
        try fan.move(to: center(fan, .done), at: t0)
        XCTAssertEqual(fan.highlighted, .done)
        fan.move(to: press, at: t0)
        XCTAssertNil(fan.highlighted)
        XCTAssertEqual(fan.release(at: press, at: t0), .dismiss)
    }

    func testLeavingTheFanAndLiftingChangesNothing() throws {
        var fan = session()
        try fan.move(to: center(fan, .nextMonth), at: t0)
        XCTAssertEqual(fan.release(at: CGPoint(x: 380, y: 690), at: t0), .dismiss)
    }

    /// Lifting on Other month… before it opened is not an action either.
    func testLiftingOnANavigationTargetChangesNothing() throws {
        var fan = session()
        let other = try center(fan, .otherMonth)
        fan.move(to: other, at: t0)
        XCTAssertEqual(fan.release(at: other, at: t0.addingTimeInterval(0.1)), .dismiss)
    }

    func testMovesAfterLiftingAreIgnored() {
        var fan = session(tracking: false)
        XCTAssertEqual(fan.move(to: CGPoint(x: 100, y: 200), at: t0), [])
        XCTAssertNil(fan.highlighted)
    }

    /// VoiceOver opens the fan without a finger and taps its targets; a
    /// navigation target changes the fan and keeps it open.
    func testAFanOpenedForVoiceOverTakesTaps() {
        var fan = session(mode: .months(page: 0), tracking: false)
        XCTAssertEqual(fan.tap(.laterMonths), .stayOpen)
        XCTAssertEqual(fan.mode, .months(page: 1))
        XCTAssertEqual(fan.tap(.back), .stayOpen)
        XCTAssertEqual(fan.mode, .main)
        XCTAssertEqual(fan.tap(.cancelTask), .perform(.cancelTask))
    }

    // MARK: - Month fan

    func testRestingOnOtherMonthOpensTheMonthFan() throws {
        var fan = session()
        let other = try center(fan, .otherMonth)
        fan.move(to: other, at: t0)
        XCTAssertEqual(fan.dwellDeadline, t0.addingTimeInterval(fan.metrics.dwell))
        XCTAssertEqual(fan.tick(at: t0.addingTimeInterval(0.2)), [], "not yet")
        XCTAssertEqual(fan.tick(at: t0.addingTimeInterval(0.5)), [.modeChanged(.months(page: 0))])
        XCTAssertEqual(fan.targets.first?.action, .back, "Back nearest the thumb")
        XCTAssertEqual(fan.targets.last?.action, .laterMonths)
        XCTAssertTrue(fan.tracking)
    }

    func testTheMonthUnderTheFingerNeedsDeliberateMovement() throws {
        var fan = session()
        let other = try center(fan, .otherMonth)
        fan.move(to: other, at: t0)
        fan.tick(at: t0.addingTimeInterval(1))
        // Whatever now sits under the finger is not chosen by a twitch.
        let twitch = CGPoint(x: other.x + 5, y: other.y + 5)
        XCTAssertEqual(fan.move(to: twitch, at: t0.addingTimeInterval(1.1)), [])
        XCTAssertNil(fan.highlighted)
        var lifted = fan
        XCTAssertEqual(lifted.release(at: twitch, at: t0.addingTimeInterval(1.2)), .dismiss)
        // A deliberate move onto a month selects it, and lifting moves the
        // task to that month — never to a day.
        let february = try center(fan, .month("2027-02"))
        XCTAssertEqual(fan.move(to: february, at: t0.addingTimeInterval(1.3)), [.selectionChanged(.month("2027-02"))])
        XCTAssertEqual(fan.release(at: february, at: t0.addingTimeInterval(1.4)), .perform(.month("2027-02")))
    }

    func testBackReturnsToTheMainFanWithoutLifting() throws {
        var fan = session(mode: .months(page: 0))
        let back = try center(fan, .back)
        fan.move(to: back, at: t0)
        XCTAssertEqual(fan.tick(at: t0.addingTimeInterval(1)), [.modeChanged(.main)])
        XCTAssertEqual(fan.targets.first?.action, .done)
        XCTAssertTrue(fan.tracking)
    }

    func testLaterAndEarlierPageThroughTheMonthsOnARest() throws {
        var fan = session(mode: .months(page: 0))
        try fan.move(to: center(fan, .laterMonths), at: t0)
        fan.tick(at: t0.addingTimeInterval(1))
        XCTAssertEqual(fan.mode, .months(page: 1))
        XCTAssertTrue(fan.targets.contains { $0.action == .earlierMonths })
        try fan.move(to: center(fan, .earlierMonths), at: t0.addingTimeInterval(1.1))
        fan.tick(at: t0.addingTimeInterval(2))
        XCTAssertEqual(fan.mode, .months(page: 0))
    }

    func testMonthsRunAcrossYearsWithTheYearAlwaysShown() {
        let first = TaskFanSession.months(page: 0, today: "2026-11-30", schedule: schedule, perPage: 6)
        XCTAssertEqual(first.map(\.value), ["2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06"])
        XCTAssertEqual(first.first?.label, "Jan 2027")
        let later = TaskFanSession.months(page: 2, today: "2026-11-30", schedule: schedule, perPage: 6)
        XCTAssertEqual(later.first?.value, "2028-01")
        XCTAssertEqual(later.first?.label, "Jan 2028")
        let december = TaskFanSession.months(page: 0, today: "2026-10-14", schedule: schedule, perPage: 6)
        XCTAssertEqual(december.first?.value, "2026-12", "next month has its own target")
        XCTAssertEqual(december.first?.label, "Dec 2026")
        XCTAssertTrue(TaskFanSession.months(page: 0, today: "not a day", schedule: schedule, perPage: 6).isEmpty)
    }

    func testNavigationTargetsAreTheOnlyDwellTargets() throws {
        var fan = session()
        try fan.move(to: center(fan, .done), at: t0)
        XCTAssertNil(fan.dwellDeadline)
        XCTAssertEqual(fan.tick(at: t0.addingTimeInterval(5)), [])
        XCTAssertTrue(TaskFanAction.otherMonth.isNavigation)
        XCTAssertFalse(TaskFanAction.month("2027-01").isNavigation)
    }
}
