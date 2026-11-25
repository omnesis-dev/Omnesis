// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

final class DesktopOnboardingUITests: XCTestCase {
    func testIncompleteBundleRefusesToStartDataCollection() {
        let app = XCUIApplication()
        app.launch()
        let missingRuntime = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "missing its background service")).firstMatch
        XCTAssertTrue(missingRuntime.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["use-this-mac"].exists)
        XCTAssertFalse(app.textFields["chat-input"].exists)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "incomplete-bundle-refusal"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testWelcomeRequiresDiscoveryBeforeCreatingAnotherHome() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["find-library"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["use-this-mac"].exists)
    }

    func testNewLibraryIsAnExplicitChoiceWithAHomeWarning() {
        let app = XCUIApplication()
        app.launch()
        let create = app.buttons["create-library"]
        XCTAssertTrue(create.waitForExistence(timeout: 15))
        create.click()
        let useThisMac = app.buttons["use-this-mac"]
        XCTAssertTrue(useThisMac.waitForExistence(timeout: 5))
        XCTAssertFalse(useThisMac.isEnabled)
        let warning = app.staticTexts["home-location-warning"]
        XCTAssertTrue(warning.waitForExistence(timeout: 5))
        XCTAssertTrue(warning.label.contains("Moving your library to another Mac is not available yet"))
        app.checkBoxes["confirm-first-library"].click()
        XCTAssertTrue(useThisMac.isEnabled)
    }
}
