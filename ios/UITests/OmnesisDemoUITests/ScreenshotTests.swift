// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import UIKit
import XCTest

/// Automated still-screenshot driver for the landing page's "Manage from
/// anywhere" showcase. Unlike `DemoRecorderTests` (which screen-records
/// replay-agent conversations), this launches the demo app on a single
/// static screen, waits for it to populate from the demo gateway, and
/// captures one PNG.
///
/// The app pairs to the synthetic demo gateway (no personal data) and is
/// launched straight onto the requested tab via `DEMO_INITIAL_TAB`. The
/// forced colour scheme comes from `DEMO_APPEARANCE` (light/dark), so the
/// capture script runs this test once per appearance.
///
/// Orchestrated by `scripts/record-screenshots.sh`.
final class ScreenshotTests: XCTestCase {
    private var app: XCUIApplication!

    private static let pairingFilePath = "/tmp/omnesis-demo-pairing.json"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app = nil
    }

    /// Capture the Sources tab for the landing-page iPhone showcase.
    func test_sources_screenshot() throws {
        let appearance = ProcessInfo.processInfo.environment["DEMO_APPEARANCE"]
            .flatMap { $0.isEmpty ? nil : $0 } ?? "dark"

        app = XCUIApplication()
        app.launchArguments += ["-pairingFile", Self.pairingFilePath]
        // Boot straight onto the Sources tab (DEBUG-only hook, see HomeTab).
        app.launchEnvironment["DEMO_INITIAL_TAB"] = "sources"
        app.launchEnvironment["DEMO_APPEARANCE"] = appearance
        app.launch()

        // Dismiss any system permission alert (notifications, etc.) iOS
        // surfaces on a fresh install before it lands over the capture.
        dismissSystemAlerts()

        // Wait for the Sources list to render. The screen-capture script
        // has already polled the gateway until the synthetic sources are
        // synced + indexed, so the data is present; here we just wait for
        // the app to fetch and lay it out. A visible "SYNCED" badge means
        // at least one source row has populated.
        let title = app.navigationBars["Sources"]
        XCTAssertTrue(title.waitForExistence(timeout: 30), "Sources screen did not appear")
        _ = app.staticTexts["SYNCED"].firstMatch.waitForExistence(timeout: 30)

        // Let the list settle (badges, indexing percentages, header stats)
        // before grabbing the frame.
        Thread.sleep(forTimeInterval: 2)

        let screenshot = XCUIScreen.main.screenshot()
        let outPath = "/tmp/omnesis-screenshot-\(appearance).png"
        try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: outPath))
    }

    func test_store_01_agent() throws {
        app = XCUIApplication()
        app.launchEnvironment["DEMO_AGENT_PREVIEW"] = "store"
        app.launchEnvironment["DEMO_APPEARANCE"] = "dark"
        app.launch()
        dismissSystemAlerts()
        XCTAssertTrue(
            app.textFields["agentComposer"].waitForExistence(timeout: 30),
            "Seeded assistant conversation did not appear"
        )
        try captureStoreScreenshot(named: "01-agent")
    }

    func test_store_02_search() throws {
        launchPaired(tab: "search", environment: [
            "DEMO_SEARCH_QUERY": "Q3 planning",
            "DEMO_HIDE_SEARCH_DIAGNOSTICS": "1",
        ])
        XCTAssertTrue(
            app.staticTexts["Acme Q3 Planning"].waitForExistence(timeout: 30),
            "Synthetic search result did not appear"
        )
        try captureStoreScreenshot(named: "02-search")
    }

    func test_store_03_people() throws {
        launchPaired(tab: "people", environment: ["DEMO_PEOPLE_TOP_CONTACTS_ONLY": "1"])
        XCTAssertTrue(
            app.navigationBars["People"].waitForExistence(timeout: 30),
            "People screen did not appear"
        )
        XCTAssertTrue(
            app.staticTexts["Jane Doe"].waitForExistence(timeout: 30),
            "Synthetic people list did not populate"
        )
        try captureStoreScreenshot(named: "03-people")
    }

    func test_store_04_settings() throws {
        app = XCUIApplication()
        app.launchEnvironment["DEMO_SETTINGS_PREVIEW"] = "1"
        app.launchEnvironment["DEMO_APPEARANCE"] = "dark"
        app.launch()
        dismissSystemAlerts()
        XCTAssertTrue(
            app.navigationBars["Settings"].waitForExistence(timeout: 30),
            "Settings screen did not appear"
        )
        let privacyPolicy = app.staticTexts["Privacy Policy"]
        for _ in 0 ..< 8 where !privacyPolicy.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(privacyPolicy.isHittable, "Privacy Policy did not become visible")
        try captureStoreScreenshot(named: "04-privacy-settings")
    }

    func test_conversation_message_menus() throws {
        app = XCUIApplication()
        app.launchEnvironment["DEMO_AGENT_PREVIEW"] = "conversation-controls"
        app.launchEnvironment["DEMO_DISABLE_ANIMATIONS"] = "1"
        app.launchEnvironment["DEMO_APPEARANCE"] = "dark"
        app.launch()
        dismissSystemAlerts()
        let prompt = app.staticTexts["Compare my activity."]
        XCTAssertTrue(prompt.waitForExistence(timeout: 30))
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let answer = "I can compare your activity.\n\n```swift\nlet total = 42\n```"
        for (text, action, name, copiedText) in [
            ("Compare my activity.", "Edit and resend", "73a-user-message-menu", "Compare my activity."),
            (
                "Include a short summary.\n\nCompare the totals too.",
                "Send now",
                "73b-queued-message-menu",
                "Include a short summary.\n\nCompare the totals too."
            ),
            ("I can compare your activity.", "Copy", "73c-assistant-message-menu", answer),
            ("let total = 42", "Copy", "73d-assistant-code-menu", answer),
        ] {
            app.staticTexts[text].firstMatch.press(forDuration: 1.2)
            XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons[action].exists)
            try XCUIScreen.main.screenshot().pngRepresentation.write(to: directory.appendingPathComponent("\(name).png"))
            app.buttons["Copy"].tap()
            let composer = app.textFields["agentComposer"]
            composer.tap()
            composer.press(forDuration: 1.2)
            let paste = app.descendants(matching: .any).matching(identifier: "Paste").firstMatch
            XCTAssertTrue(paste.waitForExistence(timeout: 5))
            paste.tap()
            XCTAssertEqual(composer.value as? String, copiedText)
            composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: copiedText.count))
            app.terminate()
            app.launch()
            XCTAssertTrue(prompt.waitForExistence(timeout: 30))
        }
    }

    private func launchPaired(tab: String, environment: [String: String] = [:]) {
        app = XCUIApplication()
        if let pairingJSON = ProcessInfo.processInfo.environment["DEMO_PAIRING_JSON"] {
            app.launchEnvironment["DEMO_PAIRING_JSON"] = pairingJSON
        } else {
            app.launchArguments += ["-pairingFile", Self.pairingFilePath]
        }
        app.launchEnvironment["DEMO_INITIAL_TAB"] = tab
        app.launchEnvironment["DEMO_APPEARANCE"] = "dark"
        for (key, value) in environment {
            app.launchEnvironment[key] = value
        }
        app.launch()
        dismissSystemAlerts()
    }

    private func captureStoreScreenshot(named name: String) throws {
        Thread.sleep(forTimeInterval: 2)
        let root = ProcessInfo.processInfo.environment["STORE_SCREENSHOT_OUTPUT_DIR"]
            ?? "/tmp/omnesis-app-store-screenshots"
        let directory = URL(fileURLWithPath: root, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let screenshot = XCUIScreen.main.screenshot()
        try screenshot.pngRepresentation.write(
            to: directory.appendingPathComponent("\(name).png")
        )
    }

    /// Tap away any system permission alert presented on springboard.
    /// Polls briefly (the alert is async after launch) and taps the first
    /// known button it finds. Harmless no-op when no alert appears.
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
}
