// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Drives the push-tap deep-link chain end to end on the simulator: the
/// app launches into `PushTapDemoRoot` (see `DEMO_PUSH_TAP` there), which
/// feeds the real notification-center delegate the exact `omnesis`
/// payload of a gateway push, and the test asserts the app lands on the
/// target's detail — `handleNotificationTap` → `NotificationRouter` →
/// `HomeView` section flip → destination-view consumption → nav push.
///
/// A real APNs push cannot reach the simulator, and a
/// `UNNotificationResponse` cannot be constructed in tests, so the
/// harness enters the chain at the delegate's parse-and-dispatch seam —
/// everything downstream of the OS is the production path.
///
/// This suite is an on-demand journey lane (run it like the other
/// `OmnesisDemoUITests`, via `xcodebuild -scheme OmnesisDemoUITests`);
/// the CI-run unit lane covers the routing decision and the delegate
/// seam in `OmnesisTests/NotificationRouterTests`.
final class PushTapUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Warm app: `/status` already resolved as experimental, callbacks
    /// bound, then the watch-firing tap lands.
    func testTapNavigatesToWatchesWhenStatusResolved() throws {
        try runPushTap(mode: "warm", expectedNavBar: "Watches")
    }

    /// Cold tap-launch: the tap lands before the delegate callbacks are
    /// bound (pre-bind buffer) and `/status` never resolves. The tap
    /// must still navigate — the push's existence is proof the gateway
    /// runs the feature; the app's cached flag must not veto the link.
    func testTapNavigatesToWatchesBeforeStatusResolves() throws {
        try runPushTap(mode: "cold", expectedNavBar: "Watches")
    }

    /// A privacy-approval tap with `/status` unresolved must mount the
    /// Privacy section and land on the approval detail — the section
    /// renders unconditionally so the queued target is always consumed.
    func testPrivacyApprovalTapLandsBeforeStatusResolves() throws {
        try runPushTap(mode: "privacy-cold", expectedNavBar: "Privacy decision")
    }

    func testSettingsCanOpenMCPAuthorization() {
        let app = XCUIApplication()
        app.launchEnvironment["DEMO_SETTINGS_PREVIEW"] = "1"
        app.launch()

        let authorize = app.buttons["Authorize an MCP connection"]
        XCTAssertTrue(authorize.waitForExistence(timeout: 20))
        for _ in 0 ..< 6 where !authorize.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(authorize.isHittable)
        authorize.tap()

        XCTAssertTrue(app.navigationBars["Connect an agent"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["Authorization code"].exists)
    }

    func testAllowAllOnlyEnablesSourceRows() {
        let app = XCUIApplication()
        app.launchEnvironment["DEMO_ACCESS_AUTHORIZATION"] = "1"
        app.launch()

        let allowAll = app.buttons["Allow all shown"]
        XCTAssertTrue(allowAll.waitForExistence(timeout: 20))
        for _ in 0 ..< 6 where !allowAll.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(allowAll.isHittable)

        let firstSource = app.switches["access-source-github:maya-reeves"]
        XCTAssertTrue(firstSource.waitForExistence(timeout: 5))
        XCTAssertEqual(firstSource.value as? String, "0")

        allowAll.tap()

        let enabled = NSPredicate(format: "value == '1'")
        expectation(for: enabled, evaluatedWith: firstSource)
        waitForExpectations(timeout: 5)
    }

    private func runPushTap(mode: String, expectedNavBar: String) throws {
        let app = XCUIApplication()
        app.launchEnvironment["DEMO_PUSH_TAP"] = mode
        app.launch()
        XCTAssertTrue(
            app.navigationBars[expectedNavBar].waitForExistence(timeout: 20),
            "tap did not deep-link into \(expectedNavBar) (mode: \(mode))"
        )
    }
}
