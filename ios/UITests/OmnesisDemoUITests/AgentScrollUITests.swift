// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Drives the real agent transcript on the simulator to prove the
/// scroll-to-bottom chevron actually reaches the bottom of a long,
/// height-variable conversation.
///
/// The app is launched straight into a seeded transcript via
/// `DEMO_AGENT_PREVIEW=scroll-stress` (see `PreviewMocks
/// .agentScrollStressTranscript`): short turns at the top, several very
/// tall answers, then a tiny marker turn at the very bottom. That shape is
/// what defeats `LazyVStack` height estimation — exactly the real-world
/// "open an old conversation, tap the arrow, it stops short" bug. A static
/// snapshot can't catch this; only driving the live scroll view can. The
/// test also guards two prerequisites that were silently broken: the
/// chevron's 44pt hit target, and the transcript opening at the bottom.
final class AgentScrollUITests: XCTestCase {
    private var app: XCUIApplication!

    /// Must match `PreviewMocks.agentScrollBottomMarker`.
    private let bottomMarker = "SCROLL-SENTINEL-BOTTOM-MARKER"

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    private func launch(mode: String) {
        app.launchEnvironment["DEMO_AGENT_PREVIEW"] = mode
        app.launch()
    }

    func testChevronScrollsAllTheWayToBottom() {
        launch(mode: "scroll-stress")
        let marker = app.staticTexts[bottomMarker]
        let composer = app.textFields["agentComposer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 15), "transcript did not load")

        // Scroll ALL THE WAY up to the first turn, so the bottom rows get
        // fully un-rendered by the LazyVStack. This is the case the user
        // hit: "scroll up a lot, then tap down → blank page". Scrolling up
        // only a little (bottom rows still materialised) does NOT reproduce
        // it — which is why the earlier version of this test passed against
        // the broken code.
        let firstTurn = app.staticTexts["Quick check 1: all good so far?"]
        let scroll = app.scrollViews.firstMatch
        var swipes = 0
        while !firstTurn.isHittable, swipes < 30 {
            scroll.swipeDown()
            swipes += 1
        }
        XCTAssertTrue(firstTurn.isHittable, "could not scroll to the top of the conversation")

        let chevron = app.buttons["Scroll to latest"]
        XCTAssertTrue(chevron.waitForExistence(timeout: 4), "chevron should show when scrolled far up")
        XCTAssertTrue(chevron.isHittable, "chevron is not hittable across its visible area")
        chevron.tap()

        // After the jump, the LAST message must actually be rendered and
        // resting just above the composer — not a blank page below the end.
        XCTAssertTrue(
            waitFor(timeout: 8) { marker.exists && marker.isHittable },
            "bottom marker never became visible — blank page below the conversation end"
        )
        let gap = composer.frame.minY - marker.frame.maxY
        XCTAssertLessThan(gap, 250, "blank space below the last message — jumped past the rendered content")
        XCTAssertTrue(
            waitFor(timeout: 4) { !chevron.exists },
            "the chevron is still showing — the transcript is not at the true bottom"
        )
    }

    /// Reproduces the cold-launch resume: the transcript is installed
    /// asynchronously after the view appears, so the ScrollView is created
    /// fresh with the full conversation. The bug is that opening this way
    /// overscrolls past the end, leaving a blank page below the last message.
    func testColdLaunchOpensAtBottomWithoutOverscroll() {
        launch(mode: "scroll-stress-delayed")

        let marker = app.staticTexts[bottomMarker]
        XCTAssertTrue(marker.waitForExistence(timeout: 15), "transcript never loaded")

        // Let any open-time scrolling settle.
        Thread.sleep(forTimeInterval: 2.0)

        let composer = app.textFields["agentComposer"]
        let gap = composer.frame.minY - marker.frame.maxY
        let diag = "marker.maxY=\(marker.frame.maxY) marker.hittable=\(marker.isHittable) "
            + "composer.minY=\(composer.frame.minY) gap=\(gap)\n"
        try? diag.write(toFile: "/tmp/omnesis-scrolltest/coldgap.log", atomically: true, encoding: .utf8)
        let shot = app.screenshot().pngRepresentation
        try? shot.write(to: URL(fileURLWithPath: "/tmp/omnesis-scrolltest/cold-open.png"))

        // The last message must rest just above the composer. A blank-page
        // overscroll pushes it far up (or off screen), making the gap huge.
        XCTAssertTrue(marker.isHittable, "last message is not visible after cold-launch open")
        XCTAssertLessThan(gap, 250, "blank space below the last message — overscrolled past the end")
    }

    private func waitFor(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.2)
        }
        return condition()
    }
}
