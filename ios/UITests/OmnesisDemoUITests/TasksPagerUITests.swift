// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Swiping between the Tasks views, driven on the simulator against
/// `TasksDemoGateway` (`DEMO_MENU_REVEAL=tasks`) inside the same menu-reveal
/// container as the app, and judged by what the screen shows: which segment
/// is selected, which page's rows are on screen, and whether the menu came
/// out.
///
/// The gesture contract under test: a horizontal swipe across the list turns
/// to the next or previous view; a rightward drag from the screen's leading
/// edge reveals the menu instead, on the first view and on any later one; a
/// rightward swipe from mid-screen on the first view does nothing.
///
/// Each step saves a screenshot (`327-pager-…`) to `/tmp/omnesis-snapshots`,
/// so the run that drives the gestures also shows what they left on screen.
final class TasksPagerUITests: XCTestCase {
    /// Must match `MenuRevealDemoRoot.menuMarker`.
    private let menuMarker = "MENU-REVEAL-MENU-VISIBLE"

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["DEMO_MENU_REVEAL"] = "tasks"
        app.launch()
        XCTAssertTrue(chip("Today").waitForExistence(timeout: 15), "the Tasks screen did not load")
        XCTAssertTrue(text(Fixture.today).waitForExistence(timeout: 10), "today's tasks did not load")
        // Let the first layout and the read-ahead of Month settle, as a
        // finger arriving on a fresh screen would.
        RunLoop.current.run(until: Date().addingTimeInterval(1))
    }

    override func tearDownWithError() throws {
        if let run = testRun, run.failureCount > 0 { shot("failed") }
        app = nil
    }

    /// One row each view of `TasksFanDemoSurface` shows, and the empty
    /// states of the views it leaves empty.
    private enum Fixture {
        static let today = "Go over the marathon entry form with Maya Reeves"
        static let month = "Collect the framed prints from Studio Northstar"
        static let future = "Nothing planned further out"
        static let anytime = "No unscheduled tasks"
        /// Open, and on Today only.
        static let todayOnly = "Draft the Q4 budget review agenda"
        /// Done today: on Today and on Done.
        static let done = "Book the Q4 budget review room"
    }

    // MARK: - Swiping between views

    /// Left swipes turn Today → Month → Future, a right swipe from
    /// mid-screen turns back to Month, and the segment bar follows each
    /// turn. Only the page on screen is shown; the menu never comes out.
    func testSwipesTurnThroughTheViewsAndTheSegmentBarFollows() {
        assertOn("Today", showing: Fixture.today)

        swipeLeft()
        assertOn("Month", showing: Fixture.month, notShowing: Fixture.today)
        shot("month")

        swipeLeft()
        assertOn("Future", showing: Fixture.future, notShowing: Fixture.month)
        shot("future")

        swipeLeft()
        assertOn("Anytime", showing: Fixture.anytime, notShowing: Fixture.future)

        dragRight(fromX: 0.5)
        assertOn("Future", showing: Fixture.future, notShowing: Fixture.anytime)
        dragRight(fromX: 0.5)
        assertOn("Month", showing: Fixture.month, notShowing: Fixture.future)
        XCTAssertFalse(menuShown(), "a mid-screen right swipe revealed the menu")
        shot("back-to-month")
    }

    /// The task rows still work on a page reached by swiping: a vertical
    /// scroll moves the list, not the page.
    func testAVerticalScrollOnASwipedPageStaysOnThatPage() {
        swipeLeft()
        assertOn("Month", showing: Fixture.month)
        app.swipeUp(velocity: .slow)
        app.swipeDown(velocity: .slow)
        assertOn("Month", showing: Fixture.month)
    }

    /// A tap on a segment turns to its page, however far away, and back.
    func testTappingASegmentTurnsToItsPage() {
        tap("Done")
        assertOn("Done", showing: Fixture.done, notShowing: Fixture.todayOnly)
        shot("done")

        tap("Month")
        assertOn("Month", showing: Fixture.month)

        tap("Today")
        assertOn("Today", showing: Fixture.today, notShowing: Fixture.month)
    }

    /// The first view has nothing before it: a right swipe from mid-screen
    /// leaves it where it is and does not reveal the menu.
    func testARightSwipeOnTheFirstViewStaysPut() {
        dragRight(fromX: 0.5)
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        assertOn("Today", showing: Fixture.today)
        XCTAssertFalse(menuShown(), "a mid-screen right swipe on Today revealed the menu")
    }

    // MARK: - The leading edge is the menu's

    func testAnEdgeDragOnTheFirstViewRevealsTheMenu() {
        assertEdgeDragRevealsTheMenu(on: "Today", showing: Fixture.today)
    }

    /// On a later view the same drag would turn back a page from anywhere
    /// else; from the edge it reveals the menu, and the page stays put.
    func testAnEdgeDragOnALaterViewRevealsTheMenuWithoutTurningThePage() {
        swipeLeft()
        assertOn("Month", showing: Fixture.month)
        assertEdgeDragRevealsTheMenu(on: "Month", showing: Fixture.month)
    }

    // MARK: - Helpers

    /// Drags right from the very edge, checks the menu came out, closes it,
    /// and checks the view under it did not change. Two attempts, as in
    /// `MenuRevealGestureUITests`: the simulator occasionally drops a
    /// synthetic drag that starts at the edge. A regression fails both.
    private func assertEdgeDragRevealsTheMenu(on name: String, showing row: String) {
        var revealed = false
        for _ in 1 ... 2 {
            dragRight(fromPoints: 6)
            if wait(timeout: 4, { self.menuShown() }) {
                revealed = true
                break
            }
        }
        shot("edge-\(name.lowercased())")
        XCTAssertTrue(revealed, "an edge drag on \(name) did not reveal the menu")
        let close = app.buttons["Close menu"]
        XCTAssertTrue(close.waitForExistence(timeout: 3), "no way back from the menu")
        close.tap()
        XCTAssertTrue(wait { !self.menuShown() }, "the menu did not close")
        assertOn(name, showing: row)
    }

    private func assertOn(
        _ name: String,
        showing row: String,
        notShowing other: String? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertTrue(wait { self.chip(name).isSelected }, "\(name) is not the selected segment", file: file, line: line)
        XCTAssertTrue(wait { self.text(row).exists }, "\(name)'s page is not on screen", file: file, line: line)
        if let other {
            XCTAssertTrue(wait { !self.text(other).exists }, "the previous page is still shown", file: file, line: line)
        }
    }

    /// A left swipe across the middle of the list.
    private func swipeLeft() {
        drag(from: CGVector(dx: 0.85, dy: 0.55), to: CGVector(dx: 0.15, dy: 0.55))
    }

    /// A rightward drag across the list starting `x` (a fraction of the
    /// width) in.
    private func dragRight(fromX x: CGFloat) {
        drag(from: CGVector(dx: x, dy: 0.55), to: CGVector(dx: min(x + 0.45, 0.98), dy: 0.55))
    }

    /// A deliberate rightward drag from `points` in from the leading edge.
    private func dragRight(fromPoints points: CGFloat) {
        let width = app.windows.firstMatch.frame.width
        drag(from: CGVector(dx: points / width, dy: 0.55), to: CGVector(dx: 0.75, dy: 0.55), velocity: .slow)
    }

    private func drag(from start: CGVector, to end: CGVector, velocity: XCUIGestureVelocity = .fast) {
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: start).press(
            forDuration: 0.05,
            thenDragTo: window.coordinate(withNormalizedOffset: end),
            withVelocity: velocity,
            thenHoldForDuration: 0.05
        )
        // Let the page settle before anything is read from the screen.
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
    }

    /// The menu lies under the app and is always in the hierarchy; only
    /// hittability tells revealed from covered.
    private func menuShown() -> Bool {
        let marker = app.staticTexts[menuMarker]
        return marker.exists && marker.isHittable
    }

    private func chip(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    /// Taps a segment, sliding the bar along when its chip is off screen.
    private func tap(_ name: String) {
        let target = chip(name)
        XCTAssertTrue(target.waitForExistence(timeout: 5), "no \(name) chip")
        for _ in 0 ..< 4 where !onScreen(target) {
            let y = target.frame.midY
            let leftwards = target.frame.midX > app.frame.midX
            let window = app.windows.firstMatch
            let origin = window.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: leftwards ? 330 : 60, dy: y)).press(
                forDuration: 0.05,
                thenDragTo: origin.withOffset(CGVector(dx: leftwards ? 60 : 330, dy: y)),
                withVelocity: .slow,
                thenHoldForDuration: 0.3
            )
        }
        target.tap()
    }

    private func onScreen(_ element: XCUIElement) -> Bool {
        guard element.exists else { return false }
        let frame = element.frame
        return frame.minX >= app.frame.minX && frame.maxX <= app.frame.maxX
    }

    /// A row's title, or an empty state's title (which VoiceOver reads
    /// together with its detail, so it is matched by its start).
    private func text(_ value: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", value)).firstMatch
    }

    private func shot(_ step: String) {
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let test = name.replacingOccurrences(of: "[^A-Za-z]", with: "", options: .regularExpression)
        try? XCUIScreen.main.screenshot().pngRepresentation
            .write(to: directory.appendingPathComponent("327-pager-\(test)-\(step).png"))
    }

    private func wait(timeout: TimeInterval = 5, _ condition: @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return condition()
    }
}
