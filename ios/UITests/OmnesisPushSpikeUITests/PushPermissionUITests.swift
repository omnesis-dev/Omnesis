// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Grants notification permission through the real system prompt before the
/// signed `simctl push` probe. No simulator-database mutation or private API.
final class PushPermissionUITests: XCTestCase {
    func testGrantNotificationPermission() throws {
        let pairingFileName = try XCTUnwrap(
            ProcessInfo.processInfo.environment["PUSH_SPIKE_PAIRING_FILE_NAME"]
        )
        let app = XCUIApplication()
        app.launchArguments = ["-pairingFileName", pairingFileName]
        app.launch()

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        if allow.waitForExistence(timeout: 15) {
            allow.tap()
        }

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
    }
}
