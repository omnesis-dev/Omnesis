// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Real XCUI events over production views/models in a bounded, isolated Demo-only simulator scene.
final class CloudPairingInteractionUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        if let app, (testRun?.failureCount ?? 0) > 0 {
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "Cloud pairing failure"
            screenshot.lifetime = .keepAlways
            add(screenshot)
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "Cloud pairing accessibility hierarchy"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
        app?.terminate()
        app = nil
    }

    /// Launches the Demo scene for `scenario`. `cancellingTouches` lists the
    /// ordinals of the touches the app cancels, counting from 1, the way the
    /// system's gesture gate sometimes does (`DEMO_CANCEL_TOUCHES`).
    private func launch(_ scenario: String, cancellingTouches: String? = nil) {
        app?.terminate()
        app = XCUIApplication()
        app.launchEnvironment["DEMO_PLAIN_GLASS"] = "1"
        app.launchEnvironment["DEMO_RESET_PAIRING"] = "1"
        app.launchEnvironment["DEMO_CLOUD_PAIRING"] = scenario
        // Logs where each tap lands and how it ends; see `AutomationTouchLog`.
        app.launchEnvironment["DEMO_TOUCH_LOG"] = "1"
        if let cancellingTouches { app.launchEnvironment["DEMO_CANCEL_TOUCHES"] = cancellingTouches }
        app.launch()
        XCTAssertTrue(app.staticTexts["cloud.fixture.receipt"].waitForExistence(timeout: 15), "The isolated fixture did not load")
        if scenario.hasPrefix("account") { XCTAssertTrue(app.buttons["pairing.entry.cloudAccount"].waitForExistence(timeout: 15)) }
        XCTAssertFalse(app.staticTexts["cloud.fixture.unavailable"].exists)
    }

    /// Pairing opens on one list of the three ways to pair, in this order, under one line that
    /// fits all three; no way is set apart under a heading or as a button of its own.
    func testTheEntryListsTheThreeWaysToPairInOneMenu() {
        launch("account")
        let rows = ["pairing.entry.scan", "pairing.entry.manual", "pairing.entry.cloudAccount"].map { app.buttons[$0] }
        XCTAssertEqual(
            rows.map(\.label),
            ["Scan the gateway's QR code", "Enter code manually", "Sign in with cloud account"]
        )
        XCTAssertTrue(app.staticTexts["Choose how to connect this phone to your gateway."].exists)
        XCTAssertFalse(app.staticTexts["Pair directly"].exists)
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "No account needed")).firstMatch.exists)
        let frames = rows.map(\.frame)
        XCTAssertLessThan(frames[0].minY, frames[1].minY)
        XCTAssertLessThan(frames[1].minY, frames[2].minY)
        for frame in frames.dropFirst() {
            XCTAssertEqual(frame.minX, frames[0].minX, accuracy: 0.5, "Every way to pair is a row of the same list")
            XCTAssertEqual(frame.width, frames[0].width, accuracy: 0.5, "Every way to pair is a row of the same list")
        }
    }

    /// The cloud account row opens the choice of Google or a passkey, and Back returns to the list
    /// with nothing started.
    func testTheCloudAccountRowOpensTheSignInChoice() {
        launch("account")
        XCTAssertFalse(app.buttons["pairing.account.google"].exists)
        XCTAssertFalse(app.buttons["pairing.account.passkey"].exists)
        openSignInChoice()
        XCTAssertTrue(app.staticTexts["Choose how to sign in."].exists)
        XCTAssertFalse(app.buttons["pairing.entry.scan"].exists)
        XCTAssertFalse(app.buttons["pairing.entry.manual"].exists)
        app.navigationBars["Cloud account"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["pairing.entry.cloudAccount"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["pairing.entry.scan"].exists)
        XCTAssertTrue(app.buttons["pairing.entry.manual"].exists)
        XCTAssertFalse(app.buttons["pairing.account.google"].exists)
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "No operation")
    }

    func testGoogleSignInWaitsForTheCodesToBeConfirmedThenPairs() {
        launch("account")
        openSignInChoice()
        app.buttons["pairing.account.google"].tap()
        let confirm = app.buttons["pairing.account.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["pairing.account.google"].exists, "The sign-in's progress replaces the choice")
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "System browser started")
        confirm.tap()
        XCTAssertTrue(
            app.buttons["pairing.account.google"].waitForExistence(timeout: 15),
            "Only a freshly accepted AppStore pairing returns the model to idle"
        )
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Pair exchange completed")
    }

    func testPasskeySignInWaitsForTheCodesToBeConfirmedThenPairs() {
        launch("account")
        openSignInChoice()
        app.buttons["pairing.account.passkey"].tap()
        let confirm = app.buttons["pairing.account.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Passkey prompt shown")
        confirm.tap()
        XCTAssertTrue(app.buttons["pairing.account.passkey"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Pair exchange completed")
    }

    func testAFailedPairingReturnsToTheChoiceWithTheReasonAndCancelStopsTheBrowser() {
        launch("account-failure")
        openSignInChoice()
        app.buttons["pairing.account.google"].tap()
        XCTAssertTrue(app.buttons["pairing.account.confirm"].waitForExistence(timeout: 10))
        app.buttons["pairing.account.confirm"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["pairing.account.error"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["pairing.account.google"].exists)
        XCTAssertTrue(app.buttons["pairing.account.passkey"].exists)
        XCTAssertFalse(app.buttons["pairing.account.confirm"].exists)
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Pair exchange failed")

        launch("account-cancel")
        openSignInChoice()
        app.buttons["pairing.account.google"].tap()
        XCTAssertTrue(app.staticTexts["Complete sign-in in the system dialog."].waitForExistence(timeout: 5))
        app.navigationBars["Cloud account"].buttons["Cancel"].tap()
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "System browser canceled")
        XCTAssertTrue(app.buttons["pairing.account.google"].waitForExistence(timeout: 5))
    }

    /// The QR code row opens the scanner, whose Back returns to the list.
    func testTheScanRowOpensTheScanner() {
        launch("account")
        app.buttons["pairing.entry.scan"].tap()
        XCTAssertTrue(app.navigationBars["Scan the QR code"].waitForExistence(timeout: 5))
        dismissCameraAlert()
        XCTAssertFalse(app.buttons["pairing.entry.manual"].exists)
        app.navigationBars["Scan the QR code"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["pairing.entry.scan"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "No operation")
    }

    /// The manual row opens the code form, whose Cancel returns to the list.
    func testTheManualRowOpensTheCodeForm() {
        launch("account")
        app.buttons["pairing.entry.manual"].tap()
        let form = app.navigationBars["Manual entry"]
        XCTAssertTrue(form.waitForExistence(timeout: 5))
        XCTAssertTrue(form.buttons["Pair"].exists)
        XCTAssertFalse(form.buttons["Pair"].isEnabled, "Nothing is typed yet")
        form.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["pairing.entry.manual"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "No operation")
    }

    private func openSignInChoice() {
        app.buttons["pairing.entry.cloudAccount"].tap()
        XCTAssertTrue(app.navigationBars["Cloud account"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["pairing.account.google"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["pairing.account.passkey"].exists)
    }

    func testTrustedApprovalRequiresComparisonAndRejectionDoesNot() {
        launch("approval")
        let approve = app.buttons["pairingApproval.approve"]
        XCTAssertTrue(approve.waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "No operation")
        XCTAssertFalse(app.switches["pairingApproval.compare"].exists)
        XCTAssertTrue(approve.isEnabled)
        approve.tap()
        XCTAssertTrue(app.staticTexts["No devices are waiting for your OK."].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Device approved")
        launch("approval")
        XCTAssertTrue(app.buttons["pairingApproval.deny"].waitForExistence(timeout: 5))
        app.buttons["pairingApproval.deny"].tap()
        XCTAssertTrue(app.staticTexts["No devices are waiting for your OK."].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Device rejected")
    }

    func testApprovalRetryRefreshAndAdminOnlySheetNavigation() {
        launch("approval-retry")
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 5))
        app.buttons["Retry"].tap()
        XCTAssertTrue(app.buttons["pairingApproval.approve"].waitForExistence(timeout: 5))
        app.navigationBars["Waiting for your OK"].buttons["Refresh"].tap()
        XCTAssertTrue(app.buttons["pairingApproval.approve"].exists)
        launch("devices-read-only")
        XCTAssertFalse(app.buttons["devices.pairingRequests"].exists)
        launch("devices-admin")
        app.buttons["devices.pairingRequests"].tap()
        XCTAssertTrue(app.buttons["pairingApproval.approve"].waitForExistence(timeout: 5))
        app.navigationBars["Waiting for your OK"].buttons["Done"].tap()
        XCTAssertTrue(app.buttons["devices.pairingRequests"].waitForExistence(timeout: 5))
    }

    func testPullToRefreshReadsAgainWithoutSendingADecision() {
        launch("approval")
        waitForApprovalReads(1)
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.exists)
        let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
        waitForApprovalReads(2)
        XCTAssertTrue(app.buttons["pairingApproval.approve"].exists)
        XCTAssertTrue(app.buttons["pairingApproval.approve"].isEnabled)
        XCTAssertFalse(app.switches["pairingApproval.compare"].exists)
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "No operation")
    }

    func testExpiredAndAlreadyDecidedRequestsExposeNoDecisionControls() {
        // An expired request is still listed, marked so; one already decided is not listed at all.
        for (scenario, shown) in [
            ("approval-expired", "Expired"),
            ("approval-completed", "No devices are waiting for your OK."),
        ] {
            launch(scenario)
            XCTAssertTrue(app.staticTexts[shown].waitForExistence(timeout: 5))
            XCTAssertFalse(app.staticTexts["Approved"].exists)
            XCTAssertFalse(app.switches["pairingApproval.compare"].exists)
            XCTAssertFalse(app.buttons["pairingApproval.approve"].exists)
            XCTAssertFalse(app.buttons["pairingApproval.deny"].exists)
            XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "No operation")
        }
    }

    private func waitForApprovalReads(_ count: Int) {
        let read = app.staticTexts["cloud.fixture.reads"]
        let predicate = NSPredicate(format: "label == %@", "Approval reads: \(count)")
        let updated = XCTNSPredicateExpectation(predicate: predicate, object: read)
        XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 5), .completed)
    }

    func testConnectionStatusAndRevocationPrecedenceAreVisibleToThePerson() {
        launch("status")
        for path in ["Local", "Remote", "Reconnecting"] {
            XCTAssertTrue(app.staticTexts["Gateway connection: \(path)"].exists)
        }
        let revoked = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Revoked row")).firstMatch
        XCTAssertTrue(revoked.exists)
        XCTAssertTrue(revoked.label.contains("Revoked"))
        XCTAssertFalse(revoked.label.contains("Gateway connection:"))
        let unknown = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Unknown row")).firstMatch
        XCTAssertTrue(unknown.label.contains("Active now"))
        let missing = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Missing row")).firstMatch
        XCTAssertTrue(missing.label.contains("Active now"))
        launch("settings")
        showEachSettingsPath()
    }

    /// The Settings steps when the system takes the first tap on "Show
    /// reconnecting" away, as its gesture gate sometimes does on a simulator:
    /// the button shows its pressed state and the row still says Remote. The
    /// step notices and taps again.
    func testSettingsConnectionStatusSurvivesACancelledTap() {
        // Touch 1 is the tap on "Show relay" and touch 2 the first tap on
        // "Show reconnecting".
        launch("settings", cancellingTouches: "2")
        showEachSettingsPath()
    }

    /// Switches the settings scene from the local path to the relay, then to
    /// reconnecting, and checks that Settings names each one. A button only
    /// sets the scene's path, so tapping it again after a cancelled tap does
    /// nothing a single tap would not.
    private func showEachSettingsPath() {
        XCTAssertTrue(app.staticTexts["Gateway connection: Local"].waitForExistence(timeout: 5))
        for (button, path) in [("Show relay", "Remote"), ("Show reconnecting", "Reconnecting")] {
            retap(
                until: app.staticTexts["Gateway connection: \(path)"],
                has: "exists == true",
                or: "tapping \"\(button)\" never made Settings say \(path)"
            ) {
                app.buttons[button].tap()
            }
        }
    }

    private func dismissCameraAlert() {
        let alert = app.alerts["Scan error"]
        if alert.waitForExistence(timeout: 3) { alert.buttons["OK"].tap() }
    }
}
