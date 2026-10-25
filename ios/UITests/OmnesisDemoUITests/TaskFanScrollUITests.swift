// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Drives the Tasks action fan's long press on the simulator and checks the
/// list still scrolls once the fan is gone — the failure a phone showed: one
/// long press, released off every target, and the list never scrolled again.
/// A snapshot cannot see this; only a real touch sequence on the real scroll
/// view can.
///
/// The harness is `TasksFanDemoSurface`, launched with
/// `DEMO_MENU_REVEAL=tasks`: the Tasks screen inside the app's menu-reveal
/// container, over a long fixture list, with no gateway. Each test leaves a
/// screenshot in `/tmp/omnesis-snapshots` for review.
final class TaskFanScrollUITests: XCTestCase {
    private var app: XCUIApplication!

    /// Must match the first row of `TasksFanDemoSurface.tasks`.
    private let firstTitle = "Collect the framed prints from Studio Northstar"
    private let pressedTitle = "Plan the long run route with Maya Reeves"

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["DEMO_MENU_REVEAL"] = "tasks"
        app.launch()
        let month = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Month")).firstMatch
        XCTAssertTrue(month.waitForExistence(timeout: 15), "the Tasks screen did not load")
        month.tap()
        XCTAssertTrue(app.staticTexts[firstTitle].waitForExistence(timeout: 10), "fixture tasks did not load")
    }

    override func tearDownWithError() throws {
        app = nil
    }

    func testListScrollsAfterAFanIsReleasedOffItsTargets() throws {
        try assertListScrolls("before any fan")
        // Press a title towards the right, hold past the threshold, then drag
        // to the bottom-right corner — nowhere near a target — and lift.
        pressRow(thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.95)))
        assertFanClosed()
        screenshot("325-tasks-fan-released-off-target")
        try assertListScrolls("after a fan released off its targets")
        try assertListScrolls("after a second swipe")
    }

    func testListScrollsAfterAFanIsReleasedWhereItWasPressed() throws {
        pressRow(thenDragTo: nil)
        assertFanClosed()
        screenshot("325a-tasks-fan-released-in-place")
        try assertListScrolls("after a fan released where it was pressed")
    }

    func testListScrollsAfterSeveralFans() throws {
        for _ in 0 ..< 3 {
            pressRow(thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.95)))
            assertFanClosed()
        }
        try assertListScrolls("after three fans")
    }

    // MARK: - Helpers

    private func pressRow(thenDragTo target: XCUICoordinate?) {
        let row = app.staticTexts[pressedTitle]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "the row to press is not on screen")
        let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.5))
        if let target {
            start.press(forDuration: 1.0, thenDragTo: target)
        } else {
            start.press(forDuration: 1.0)
        }
    }

    private func assertFanClosed() {
        let closed = waitFor(timeout: 3) { !self.app.buttons["Cancel task"].exists }
        if !closed { screenshot("325x-tasks-fan-stuck") }
        XCTAssertTrue(closed, "the fan stayed on screen after the finger lifted")
    }

    /// Swipes the list up and back, asserting the first row really moved.
    private func assertListScrolls(_ context: String) throws {
        let first = app.staticTexts[firstTitle]
        XCTAssertTrue(first.waitForExistence(timeout: 5), "\(context): the list is not at its top")
        let before = first.frame.minY
        app.swipeUp(velocity: .slow)
        let scrolled = waitFor(timeout: 3) { !first.isHittable || first.frame.minY < before - 80 }
        if !scrolled { screenshot("325y-tasks-list-stuck") }
        XCTAssertTrue(scrolled, "\(context): the list did not scroll")
        for _ in 0 ..< 3 where !first.isHittable || first.frame.minY < before - 1 {
            app.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(
            waitFor(timeout: 3) { first.isHittable },
            "\(context): the list did not scroll back"
        )
    }

    private func waitFor(timeout: TimeInterval, _ condition: @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return condition()
    }

    private func screenshot(_ name: String) {
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
