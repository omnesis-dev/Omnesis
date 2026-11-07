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
        app?.terminate()
        app = nil
    }

    private func launch(_ scenario: String) {
        app?.terminate()
        app = XCUIApplication()
        app.launchEnvironment["DEMO_PLAIN_GLASS"] = "1"
        app.launchEnvironment["DEMO_RESET_PAIRING"] = "1"
        app.launchEnvironment["DEMO_CLOUD_PAIRING"] = scenario
        app.launch()
        XCTAssertTrue(app.staticTexts["cloud.fixture.receipt"].waitForExistence(timeout: 15), "The isolated fixture did not load")
        if scenario.hasPrefix("google") { XCTAssertTrue(app.buttons["Sign in with Google"].waitForExistence(timeout: 15)) }
        XCTAssertFalse(app.staticTexts["cloud.fixture.unavailable"].exists)
    }

    func testGoogleRequiresLocalComparisonAndActualAppStoreCompletion() {
        launch("google")
        app.buttons["Sign in with Google"].tap()
        let compare = app.buttons["pairing.google.confirmCode"]
        XCTAssertTrue(compare.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["pairing.google.pair"].exists, "Remote approval cannot replace local code comparison")
        compare.tap()
        let pair = app.buttons["pairing.google.pair"]
        XCTAssertTrue(pair.waitForExistence(timeout: 5))
        pair.tap()
        XCTAssertTrue(
            app.buttons["Sign in with Google"].waitForExistence(timeout: 15),
            "Only a freshly accepted AppStore pairing returns the model to idle"
        )
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Pair exchange completed")
    }

    func testGooglePairFailureRemainsRecoverableAndCancelStopsTheBrowser() {
        launch("google-failure")
        app.buttons["Sign in with Google"].tap()
        XCTAssertTrue(app.buttons["pairing.google.confirmCode"].waitForExistence(timeout: 10))
        app.buttons["pairing.google.confirmCode"].tap()
        XCTAssertTrue(app.buttons["pairing.google.pair"].waitForExistence(timeout: 5))
        app.buttons["pairing.google.pair"].tap()
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Pair exchange failed")
        XCTAssertFalse(app.buttons["pairing.google.pair"].exists)
        app.buttons["Retry"].tap()
        XCTAssertTrue(app.buttons["pairing.google.confirmCode"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["pairing.google.pair"].exists, "Retry requires a fresh local comparison")
        launch("google-cancel")
        app.buttons["Sign in with Google"].tap()
        XCTAssertTrue(app.staticTexts["Complete sign-in in the system browser."].waitForExistence(timeout: 5))
        app.navigationBars["Find your gateway"].buttons["Cancel"].tap()
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "System browser canceled")
    }

    func testTrustedApprovalRequiresComparisonAndRejectionDoesNot() {
        launch("approval")
        let approve = app.buttons["pairingApproval.approve"]
        XCTAssertTrue(approve.waitForExistence(timeout: 5))
        XCTAssertFalse(approve.isEnabled)
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "No operation")
        let comparison = app.switches["pairingApproval.compare"]
        XCTAssertEqual(comparison.value as? String, "0")
        // SwiftUI exposes the whole long-label row as the Switch; target its visible trailing lever.
        comparison.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        let compared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '1'"), object: comparison)
        XCTAssertEqual(XCTWaiter.wait(for: [compared], timeout: 5), .completed)
        XCTAssertEqual(
            app.staticTexts["cloud.fixture.receipt"].label,
            "No operation",
            "Comparison alone must never approve or reject a request"
        )
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: approve)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 5), .completed)
        XCTAssertTrue(approve.isEnabled)
        approve.tap()
        XCTAssertTrue(app.staticTexts["No pending pairing requests."].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Device approved")
        launch("approval")
        XCTAssertTrue(app.buttons["Reject request"].waitForExistence(timeout: 5))
        app.buttons["Reject request"].tap()
        XCTAssertTrue(app.staticTexts["No pending pairing requests."].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "Device rejected")
    }

    func testApprovalRetryRefreshAndAdminOnlySheetNavigation() {
        launch("approval-retry")
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 5))
        app.buttons["Retry"].tap()
        XCTAssertTrue(app.buttons["pairingApproval.approve"].waitForExistence(timeout: 5))
        app.navigationBars["Pairing requests"].buttons["Refresh"].tap()
        XCTAssertTrue(app.buttons["pairingApproval.approve"].exists)
        launch("devices-read-only")
        XCTAssertFalse(app.buttons["devices.pairingRequests"].exists)
        launch("devices-admin")
        app.buttons["devices.pairingRequests"].tap()
        XCTAssertTrue(app.buttons["pairingApproval.approve"].waitForExistence(timeout: 5))
        app.navigationBars["Pairing requests"].buttons["Done"].tap()
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
        XCTAssertFalse(app.buttons["pairingApproval.approve"].isEnabled)
        XCTAssertEqual(app.staticTexts["cloud.fixture.receipt"].label, "No operation")
    }

    func testExpiredAndAlreadyDecidedRequestsExposeNoDecisionControls() {
        for (scenario, status) in [("approval-expired", "Expired"), ("approval-completed", "Approved")] {
            launch(scenario)
            XCTAssertTrue(app.staticTexts[status].waitForExistence(timeout: 5))
            XCTAssertFalse(app.switches["pairingApproval.compare"].exists)
            XCTAssertFalse(app.buttons["pairingApproval.approve"].exists)
            XCTAssertFalse(app.buttons["Reject request"].exists)
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
        for path in ["Local", "Relay", "Reconnecting"] {
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
        XCTAssertTrue(app.staticTexts["Gateway connection: Local"].waitForExistence(timeout: 5))
        app.buttons["Show relay"].tap()
        XCTAssertTrue(app.staticTexts["Gateway connection: Relay"].waitForExistence(timeout: 5))
        app.buttons["Show reconnecting"].tap()
        XCTAssertTrue(app.staticTexts["Gateway connection: Reconnecting"].waitForExistence(timeout: 5))
    }

    func testOptionalGoogleOverlayAndMenuActionsPresentTheSameSheet() {
        launch("qr")
        dismissCameraAlert()
        app.buttons["pairing.google.open"].tap()
        XCTAssertTrue(app.navigationBars["Find your gateway"].waitForExistence(timeout: 5))
        app.navigationBars["Find your gateway"].buttons["Cancel"].tap()
        app.buttons["pairing.moreOptions"].tap()
        app.buttons["pairing.google.menuSignIn"].tap()
        XCTAssertTrue(app.navigationBars["Find your gateway"].waitForExistence(timeout: 5))
        launch("qr-disabled")
        dismissCameraAlert()
        XCTAssertFalse(app.buttons["pairing.google.open"].exists)
        app.buttons["pairing.moreOptions"].tap()
        XCTAssertFalse(app.buttons["pairing.google.menuSignIn"].exists)
        XCTAssertTrue(app.buttons["Enter code manually"].exists)
    }

    private func dismissCameraAlert() {
        let alert = app.alerts["Scan error"]
        if alert.waitForExistence(timeout: 3) { alert.buttons["OK"].tap() }
    }
}
