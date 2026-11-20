// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Apple Health sync against the simulator's real HealthKit store.
///
/// Launches the app into `HealthKitSimulatorProbe`, grants Health access
/// through the real system sheet (no simulator-database edits), and fails
/// with the probe's report unless every check passed. Run with an ad-hoc
/// signed build so the HealthKit entitlement applies:
///
///     OMNESIS_IOS_SNAPSHOT_SIGNING=adhoc OMNESIS_IOS_SNAPSHOT_SCHEME=OmnesisHealthKitUITests \
///       scripts/ios-snapshot.sh --logic --only OmnesisHealthKitUITests
///
/// Background delivery itself (iOS waking a suspended app) does not happen
/// on the simulator; that part stays a device check.
final class HealthKitSyncUITests: XCTestCase {
    func testAppleHealthSyncAgainstRealHealthKit() throws {
        let app = XCUIApplication()
        app.launchEnvironment["DEMO_HEALTHKIT_PROBE"] = "1"
        app.launch()

        grantHealthAccess(in: app)

        let result = app.staticTexts["healthkit-probe-result"]
        XCTAssertTrue(result.waitForExistence(timeout: 30), "the probe screen did not appear")
        let finished = NSPredicate(format: "NOT (label BEGINSWITH 'RUNNING')")
        let outcome = XCTWaiter().wait(for: [expectation(for: finished, evaluatedWith: result)], timeout: 240)
        XCTAssertEqual(outcome, .completed, "the probe did not finish: \(result.label)")

        let report = result.label
        let attachment = XCTAttachment(string: report)
        attachment.name = "healthkit-probe-report"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("[healthkit-probe]\n\(report)")
        XCTAssertTrue(report.hasPrefix("PASS"), report)
    }

    /// Tap through HealthKit's access sheet: turn every listed type on, then
    /// allow. The sheet is a remote view that XCUITest reaches through the
    /// app; springboard is the fallback.
    private func grantHealthAccess(in app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let turnOnAll = NSPredicate(format: "label BEGINSWITH 'Turn On All'")
        let deadline = Date().addingTimeInterval(45)
        var turnedOn = false
        while Date() < deadline {
            for root in [app, springboard] {
                let toggle = root.descendants(matching: .any).matching(turnOnAll).firstMatch
                if !turnedOn, toggle.exists, toggle.isHittable {
                    toggle.tap()
                    turnedOn = true
                }
                let allow = root.buttons["Allow"]
                if turnedOn, allow.exists, allow.isEnabled, allow.isHittable {
                    allow.tap()
                    return
                }
            }
            if app.staticTexts["healthkit-probe-result"].exists, !turnedOn {
                // Access was already granted on this simulator; no sheet.
                let label = app.staticTexts["healthkit-probe-result"].label
                if !label.hasPrefix("RUNNING") { return }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTFail("HealthKit's access sheet never offered Turn On All / Allow:\n\(app.debugDescription)")
    }
}
