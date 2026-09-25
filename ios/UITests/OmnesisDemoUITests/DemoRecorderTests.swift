// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import UIKit
import XCTest

/// Automated demo driver for screen-recording replay-agent conversations.
///
/// Each test method launches the app with a prompt and waits for the in-app
/// auto-pilot (driven by `DEMO_AUTO_SEND`) to complete the full sequence:
/// send prompt, wait for response, open citations drawer, write a marker
/// file. XCUITest never queries the UI — it's a thin launcher + timer.
///
/// Orchestrated by `scripts/record-demos.sh` which wraps each test
/// invocation with `xcrun simctl io booted recordVideo`.
final class DemoRecorderTests: XCTestCase {
    private var app: XCUIApplication!

    private static let pairingFilePath = "/tmp/omnesis-demo-pairing.json"
    private static let doneMarkerPath = "/tmp/demo-recording-done"
    private static let orientedMarkerPath = "/tmp/demo-oriented"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app = nil
    }

    /// Launch the app with auto-pilot enabled and wait for the done marker.
    private func runScenario(prompt: String) throws {
        app = XCUIApplication()
        app.launchArguments += ["-pairingFile", Self.pairingFilePath]
        app.launchEnvironment["DEMO_PROMPT"] = prompt
        app.launchEnvironment["DEMO_AUTO_SEND"] = "1"
        // Forward the appearance the recording script chose (light/dark)
        // so the app forces that colour scheme for the capture. Absent or
        // empty → the app keeps its default (dark). See `record-demos.sh`
        // --light and `AppearanceStore.forLaunchEnvironment()`.
        if let appearance = ProcessInfo.processInfo.environment["DEMO_APPEARANCE"],
           !appearance.isEmpty {
            app.launchEnvironment["DEMO_APPEARANCE"] = appearance
        }
        // Magnify the whole UI in the recordings so the smaller text
        // (agent output, citation metadata, titles) is readable in the
        // video. iPad gets a bit more headroom (1.3×) than the iPhone's
        // narrow single column (1.2×, gentler to limit wide-content
        // clipping). Tune or drop by changing these values.
        app.launchEnvironment["DEMO_UI_SCALE"] =
            UIDevice.current.userInterfaceIdiom == .pad ? "1.3" : "1.2"
        app.launch()

        // Record iPad demos in landscape — that's the only orientation
        // that exercises the side-panel split (the iPhone runs portrait,
        // its only supported orientation). Rotate AFTER launch (a
        // pre-launch orientation set doesn't stick) and settle briefly so
        // the app finishes rotating before the auto-pilot — which is
        // still waiting on the gateway session — produces any visible
        // content. Driving off the device idiom means `record-demos.sh`
        // just picks the simulator and the orientation follows.
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCUIDevice.shared.orientation = .landscapeLeft
            Thread.sleep(forTimeInterval: 1.5)
        }

        // Dismiss any system permission alert (notifications, etc.) that
        // iOS surfaces on a fresh install, BEFORE the recorder starts, so
        // it never sits over the capture. The demo build also suppresses
        // the push prompt under automation; this is the belt-and-braces
        // guard that doesn't depend on the build picking that up.
        dismissSystemAlerts()

        // Signal the recorder that the app is up and (on iPad) finished
        // rotating, so it can start screen capture now. The capture must
        // begin AFTER any rotation — simctl's recordVideo can't survive a
        // mid-stream framebuffer resolution change and would produce a
        // corrupt file. The auto-pilot still has the gateway-session wait
        // ahead of it, so there's ample time before the first visible
        // content.
        FileManager.default.createFile(atPath: Self.orientedMarkerPath, contents: nil)

        // Poll for the done marker written by the in-app auto-pilot.
        let deadline = Date().addingTimeInterval(120)
        while !FileManager.default.fileExists(atPath: Self.doneMarkerPath) {
            XCTAssertTrue(Date() < deadline, "Demo auto-pilot did not finish within 120s")
            Thread.sleep(forTimeInterval: 1)
        }

        // Keep the app alive so the recording script can stop the screen
        // capture while the app is still in the foreground. Without this
        // the test framework kills the app on tearDown and the video's
        // last frames show the home screen.
        Thread.sleep(forTimeInterval: 5)
    }

    /// Tap away any system permission alert presented on springboard
    /// (e.g. "… Would Like to Send You Notifications"). Polls briefly —
    /// the alert is async after launch — and taps the first known button
    /// it finds. Harmless no-op when no alert appears.
    private func dismissSystemAlerts() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let labels = ["Don't Allow", "Allow", "OK", "Continue", "Dismiss"]
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            for label in labels {
                let button = springboard.buttons[label]
                if button.exists {
                    button.tap()
                    return
                }
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
    }

    // MARK: - Scenario tests

    func test_find_maria() throws {
        try runScenario(prompt: "What emails did I get from Maria Smith?")
    }

    func test_birthday_gifts() throws {
        try runScenario(
            prompt: "Claire's birthday's coming up. Did she ever mention things she actually wants? "
                + "Don't want to get her something we already have."
        )
    }

    func test_property_alerts() throws {
        try runScenario(
            prompt: "Set up an alert so I never miss anything from my property manager Daniel — "
                + "whether he emails or messages me — and flag any email about the flat too."
        )
    }

    func test_marathon_prep() throws {
        try runScenario(prompt: "I just wrapped my peak week — am I actually on track for the marathon?")
    }

    func test_swim_progress() throws {
        try runScenario(prompt: "Have my swims actually been getting faster lately? And is my heart rate coming down?")
    }

    func test_vendor_eval() throws {
        try runScenario(
            prompt: "Where do things stand on the Globex vs Nimbus decision? Who's driving it and what's the holdup?"
        )
    }

    func test_url_lookup() throws {
        try runScenario(
            prompt: "A colleague just shared this with me — what's in it? "
                + "https://drive.google.com/file/d/1q7Kp3vR9mB2nF8xLZ4wYcJ6tH0sD5aGe/view"
        )
    }

    func test_trip_spending() throws {
        try runScenario(
            prompt: "How much did the Lisbon trip end up costing me, "
                + "and did Alex ever pay me back for his half?"
        )
    }

    func test_sleep_recovery() throws {
        try runScenario(
            prompt: "My sleep's been rubbish the last couple of weeks — "
                + "can you work out what's going on?"
        )
    }

    func test_tenancy_deposit() throws {
        try runScenario(
            prompt: "My flat's lease is ending in December — when exactly does it finish, "
                + "and what did Daniel say about getting my deposit back?"
        )
    }

    func test_person_catchup() throws {
        try runScenario(
            prompt: "I've got my 1:1 with Jane next week — "
                + "catch me up on everything that's still open between us."
        )
    }

    func test_citation_edge_cases() throws {
        try runScenario(prompt: "Can you ground this with citations?")
    }

    func test_mixed_decks() throws {
        try runScenario(prompt: "test mixed source decks")
    }

    func test_all_sticky_tabs() throws {
        try runScenario(prompt: "testing all sticky tabs")
    }
}
