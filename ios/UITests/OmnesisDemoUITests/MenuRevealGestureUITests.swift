// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Drives the menu-reveal gesture against a real list on the simulator.
///
/// These are the failures a snapshot cannot reach. The reveal gesture spans
/// the whole app and sits over a `List` whose rows carry swipe actions, so the
/// two negotiate every touch between them: recognise too eagerly and the swipe
/// actions stop responding to taps, reserve too much and the reveal stops
/// working where a hand naturally starts it. Both shipped once.
///
/// The harness is `MenuRevealDemoRoot`, launched with
/// `DEMO_MENU_REVEAL=briefs` — a container over a fixture-seeded briefs list,
/// no gateway required.
final class MenuRevealGestureUITests: XCTestCase {
    /// Must match `MenuRevealDemoRoot.moreMarker` / `.menuMarker`.
    private let moreMarker = "MENU-REVEAL-MORE-TAPPED"
    private let menuMarker = "MENU-REVEAL-MENU-VISIBLE"
    private let detailMarker = "MENU-REVEAL-DETAIL-VISIBLE"
    private let menuBehindSheetMarker = "MENU-REVEAL-OPENED-UNDER-SHEET"

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["DEMO_MENU_REVEAL"] = "briefs"
        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    private func firstRow() -> XCUIElement {
        let row = app.cells.firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "briefs list did not load")
        return row
    }

    /// Reveal the trailing swipe actions on a row and return it.
    private func revealTrailingActions() -> XCUIElement {
        let row = firstRow()
        row.swipeLeft()
        return row
    }

    // MARK: - Swipe actions must still take taps

    /// The clear action removes the row outright, so its effect is visible
    /// without any presentation involved. If the container's drag gesture is
    /// cancelling touches for the list's UIKit-driven buttons, this is where
    /// it shows: the row simply stays.
    func testTrailingSwipeClearActionFires() {
        _ = firstRow()
        let before = app.cells.count
        XCTAssertGreaterThan(before, 0, "no rows to clear")
        app.cells.firstMatch.swipeLeft()

        // "Done" for a loop brief, "Got it" for an info one.
        let clear = app.buttons["Done"].exists ? app.buttons["Done"] : app.buttons["Got it"]
        XCTAssertTrue(clear.waitForExistence(timeout: 5), "trailing swipe revealed no clear action")
        clear.tap()

        // Row count, not the row's own label: a brief's accessibility label is
        // its whole card and blows past XCUITest's 128-character query limit.
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, app.cells.count == before {
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "tick")], timeout: 0.25)
        }
        XCTAssertLessThan(
            app.cells.count,
            before,
            "the clear action did not fire — the row is still there"
        )
    }

    /// The second trailing action. It writes a marker rather than presenting,
    /// so a failure here means the button never fired, not that a sheet failed
    /// to appear.
    func testTrailingSwipeMoreActionFires() {
        _ = revealTrailingActions()
        let more = app.buttons["More"]
        XCTAssertTrue(more.waitForExistence(timeout: 5), "trailing swipe revealed no More action")
        more.tap()

        XCTAssertTrue(
            app.staticTexts[moreMarker].waitForExistence(timeout: 5),
            "the More action did not fire"
        )
    }

    // MARK: - The reveal itself

    /// From the leading edge, where a hand reaches for this gesture first.
    /// Split by offset and given a test each, so every case starts from a
    /// fresh launch — a shared one carries menu state between probes and the
    /// results stop meaning anything.
    /// Only from 30pt in. The outermost ~20pt is contested by the system's own
    /// edge handling, and a synthetic drag started there is delivered too
    /// unreliably to assert on — it fails and passes across runs at the same
    /// offset. Real-device behaviour at the very edge is the authority, not
    /// this lane.
    func testRevealAt30ptFromEdge() {
        assertRevealWorks(atPoints: 30)
    }

    /// Started on a list row rather than empty space below it. `MenuReveal`
    /// yields while a row's swipe actions are showing, and that check reads
    /// the view hierarchy — so this is the guard that it does not also
    /// suppress an ordinary reveal begun anywhere over a list.
    func testRevealWorksWhenStartedOnAListRow() {
        // Two attempts, for the same reason as `assertRevealWorks`: the
        // synthetic drag is occasionally dropped, and which one varies run to
        // run. A genuine regression fails both, every time.
        for _ in 1 ... 2 {
            let row = firstRow()
            let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
            let end = row.coordinate(withNormalizedOffset: CGVector(dx: 3.0, dy: 0.5))
            start.press(
                forDuration: 0.1,
                thenDragTo: end,
                withVelocity: .slow,
                thenHoldForDuration: 0.2
            )
            if waitForHittable(app.staticTexts[menuMarker], timeout: 4) { return }
        }
        XCTFail("a drag begun on a list row did not reveal the menu in two attempts")
    }

    /// Two attempts, because the synthetic drag itself is not perfectly
    /// reliable: the simulator occasionally drops one, and which offset it
    /// drops varies run to run. The claim under test is that this gesture
    /// *can* reveal the menu from here, so one dropped synthetic swipe is
    /// noise. A genuine regression fails both attempts every time.
    private func assertRevealWorks(atPoints points: CGFloat, file: StaticString = #filePath, line: UInt = #line) {
        _ = firstRow()
        let width = app.windows.firstMatch.frame.width
        for attempt in 1 ... 2 {
            dragRight(fromRelativeX: points / width)
            if waitForHittable(app.staticTexts[menuMarker], timeout: 4) { return }
            print("REVEAL_RETRY \(Int(points))pt attempt \(attempt) did not take")
        }
        XCTFail(
            "dragging right from \(Int(points))pt did not reveal the menu in two attempts",
            file: file,
            line: line
        )
    }

    /// A leftward drag on a row belongs to that row's swipe actions and must
    /// never be taken as a reveal.
    func testLeftwardDragDoesNotRevealTheMenu() {
        let row = firstRow()
        row.swipeLeft()
        XCTAssertFalse(
            app.staticTexts[menuMarker].isHittable,
            "a trailing row swipe was mistaken for a menu reveal"
        )
    }

    /// A sheet is outside the reveal container's visual hierarchy but shares
    /// its window. Drags on the sheet must stay with the presented content;
    /// moving the app and menu underneath leaves two contradictory navigation
    /// states stacked on screen.
    func testRevealIsDisabledWhileBriefSheetIsPresented() {
        let row = firstRow()
        row.tap()

        let detail = app.staticTexts[detailMarker]
        XCTAssertTrue(detail.waitForExistence(timeout: 5), "the brief sheet did not present")

        dragRight(fromRelativeX: 0.2)

        XCTAssertTrue(detail.exists, "the brief sheet stopped being the active surface")
        XCTAssertFalse(
            app.staticTexts[menuBehindSheetMarker].waitForExistence(timeout: 1),
            "dragging the brief sheet revealed the menu underneath it"
        )

        dismissBriefSheet()
        var revealed = false
        for _ in 1 ... 2 {
            dragRight(fromRelativeX: 0.2)
            if waitForHittable(app.staticTexts[menuMarker], timeout: 4) {
                revealed = true
                break
            }
        }
        XCTAssertTrue(revealed, "the post-sheet drag positive control did not reveal the menu")
    }

    /// Closing is blocked by the same modal gate. The harness stages the
    /// otherwise-unreachable combination deliberately so the leftward path is
    /// covered independently of whether the opening path works.
    func testHideIsDisabledWhileBriefSheetIsPresented() {
        firstRow().tap()
        let stageOpenMenu = app.buttons["stageOpenMenu"]
        XCTAssertTrue(stageOpenMenu.waitForExistence(timeout: 5), "the brief sheet did not present")
        stageOpenMenu.tap()

        let openMarker = app.staticTexts[menuBehindSheetMarker]
        XCTAssertTrue(openMarker.waitForExistence(timeout: 5), "the harness did not stage an open menu")

        dragLeft(fromRelativeX: 0.8)

        waitForSettlingGesture()
        XCTAssertTrue(openMarker.exists, "dragging the brief sheet hid the menu underneath it")

        dismissBriefSheet()
        XCTAssertTrue(
            waitForHittable(app.staticTexts[menuMarker], timeout: 4),
            "the staged menu was not visible after dismissing the sheet"
        )
        dragLeft(fromRelativeX: 0.8)
        XCTAssertTrue(
            waitForNotHittable(app.staticTexts[menuMarker], timeout: 4),
            "the post-sheet drag positive control did not hide the menu"
        )
    }

    // MARK: - Sharing the leading edge with the back-swipe

    private func pushDetail() {
        _ = firstRow()
        let link = app.buttons["openDetail"]
        XCTAssertTrue(link.waitForExistence(timeout: 10), "no push link in the harness")
        link.tap()
        XCTAssertTrue(
            app.staticTexts[detailMarker].waitForExistence(timeout: 10),
            "the detail view did not push"
        )
    }

    /// Inside a pushed detail the edge belongs to the interactive back-swipe.
    /// Both recognisers are simultaneous, so without the reserve one drag pops
    /// the view *and* opens the menu — which is what a user hit.
    func testEdgeDragInsidePushedDetailGoesBackWithoutRevealingTheMenu() {
        pushDetail()
        dragRight(fromRelativeX: 0.01)

        XCTAssertTrue(
            waitForDisappearance(of: app.staticTexts[detailMarker], timeout: 5),
            "the edge drag did not go back"
        )
        XCTAssertFalse(
            app.staticTexts[menuMarker].isHittable,
            "the edge drag went back AND revealed the menu"
        )
    }

    /// The pop is not an edge gesture: a mid-screen rightward drag inside a
    /// pushed detail goes back too. So the reveal yields the whole direction
    /// there, rather than sharing it by position and losing every such drag to
    /// a fight.
    func testMidScreenDragInsidePushedDetailGoesBackWithoutRevealingTheMenu() {
        pushDetail()
        dragRight(fromRelativeX: 0.5)

        XCTAssertTrue(
            waitForDisappearance(of: app.staticTexts[detailMarker], timeout: 5),
            "the drag did not go back"
        )
        XCTAssertFalse(
            app.staticTexts[menuMarker].isHittable,
            "the drag went back AND revealed the menu"
        )
    }

    /// With a row's trailing actions open, swiping the row back to the right
    /// puts them away — and must not also bring the menu out from under the
    /// app. The reveal loses to the swipe-action recogniser by requiring it to
    /// fail first.
    func testDismissingSwipeActionsDoesNotRevealTheMenu() {
        _ = firstRow()
        app.cells.firstMatch.swipeLeft()
        let clear = app.buttons["Done"].exists ? app.buttons["Done"] : app.buttons["Got it"]
        XCTAssertTrue(clear.waitForExistence(timeout: 5), "trailing swipe revealed no actions")

        let row = app.cells.firstMatch
        let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.5))
        let end = row.coordinate(withNormalizedOffset: CGVector(dx: 2.5, dy: 0.5))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )

        XCTAssertFalse(
            app.staticTexts[menuMarker].isHittable,
            "putting the swipe actions away also revealed the menu"
        )
    }

    // MARK: - Helpers

    /// A deliberate drag rather than a flick. A fast synthetic swipe is
    /// unreliable here — it races the system's own edge handling and the
    /// result varies run to run — while a slow one is carried by the
    /// classifier's distance threshold and behaves the same every time.
    private func dragRight(fromRelativeX x: CGFloat) {
        let window = app.windows.firstMatch
        // Over the rows, not the empty space below them. A drag begun in a
        // short list's empty tail is delivered unreliably by the simulator and
        // is not what a user does anyway.
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.25))
        let end = window.coordinate(withNormalizedOffset: CGVector(dx: x + 0.7, dy: 0.25))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )
    }

    private func dragLeft(fromRelativeX x: CGFloat) {
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: 0.25))
        let end = window.coordinate(withNormalizedOffset: CGVector(dx: x - 0.7, dy: 0.25))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )
    }

    private func dismissBriefSheet() {
        let close = app.buttons["closeBriefSheet"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "the brief sheet had no close control")
        close.tap()
        XCTAssertTrue(
            waitForDisappearance(of: close, timeout: 5),
            "the brief sheet did not dismiss"
        )
    }

    private func waitForSettlingGesture() {
        _ = XCTWaiter.wait(
            for: [XCTestExpectation(description: "gesture settle")],
            timeout: 1
        )
    }

    /// The menu lives *underneath* the app and is always in the hierarchy, so
    /// `exists` is true even when it is completely covered. Only hittability
    /// distinguishes revealed from hidden.
    private func waitForHittable(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists, element.isHittable { return true }
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "tick")], timeout: 0.25)
        }
        return element.exists && element.isHittable
    }

    private func waitForNotHittable(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !element.isHittable { return true }
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "tick")], timeout: 0.25)
        }
        return !element.isHittable
    }

    private func waitForDisappearance(of element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !element.exists { return true }
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "tick")], timeout: 0.25)
        }
        return !element.exists
    }
}

/// The reveal gesture over quick capture.
///
/// Capture carries a swipe-down-to-discard drag of its own, and it is rendered
/// inside the reveal container rather than as a full-screen cover — a cover
/// sits outside the container, where the reveal cannot reach it at all. Both
/// halves of that are invisible to a snapshot: this is the only check that the
/// two gestures share a touch correctly.
///
/// The harness is `MenuRevealDemoRoot` launched with `DEMO_MENU_REVEAL=capture`
/// — a container over the capture surface, no gateway required.
final class MenuRevealCaptureGestureUITests: XCTestCase {
    /// Must match `MenuRevealDemoRoot.menuMarker`.
    private let menuMarker = "MENU-REVEAL-MENU-VISIBLE"

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["DEMO_MENU_REVEAL"] = "capture"
        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    func testRevealWorksOverTheCaptureSurface() {
        // The title, not the transcript field: a vertical-axis TextField is
        // exposed under different element types across OS versions, and the
        // header is unambiguous.
        let title = app.staticTexts["Tell Omnesis"]
        XCTAssertTrue(title.waitForExistence(timeout: 15), "capture surface did not load")

        let menu = app.staticTexts[menuMarker]
        // The menu is underneath and always in the hierarchy, so only
        // hittability tells revealed from hidden.
        XCTAssertFalse(menu.isHittable, "the menu was already revealed before any drag")

        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.35))
        let end = window.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.35))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.2
        )

        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, !menu.isHittable {
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "tick")], timeout: 0.25)
        }
        XCTAssertTrue(
            menu.isHittable,
            "dragging right across capture did not reveal the menu"
        )
    }
}
