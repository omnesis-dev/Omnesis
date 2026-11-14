// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Real touch input against the paired app and the collector's folder catalogue.
final class SourceFilterFolderGestureUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["DEMO_PLAIN_GLASS"] = "1"
        app.launchEnvironment["DEMO_DISABLE_ANIMATIONS"] = "1"
        addUIInterruptionMonitor(withDescription: "System permission alert") { alert in
            for label in ["Allow", "Allow While Using App", "OK", "Continue"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
    }

    override func tearDownWithError() throws {
        app.terminate()
        app = nil
    }

    func testRealFolderSwipesRetainPageTwoAndSelectedReference() throws {
        let bootstrap = try JourneyGateway.fromEnvironment()
        let pairing = try bootstrap.automationPairingJSON(
            deviceName: "Folder gesture iPhone \(UUID().uuidString.prefix(8))"
        )
        let gateway = try bootstrap.ownerGateway(pairingJSON: pairing)
        let level = try gateway.prepareFolderScrollLevel()
        app.launchEnvironment["DEMO_PAIRING_JSON"] = pairing
        app.launch()
        tap(app.buttons["menu.toggle"])
        tap(button(startingWith: "Settings"))
        revealAndTap(app.buttons["Access"])
        revealAndTap(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", level.name)).firstMatch)
        tap(app.buttons["Change Direct data"])
        revealAndTap(button(startingWith: "Change direct filter for "))
        tap(button(startingWith: "Only matching content"))
        tap(app.buttons["Continue"])
        tap(app.buttons["Browse inside Journey folders"])

        let picker = app.scrollViews["scope-picker.results"]
        XCTAssertTrue(picker.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Select Journey folder 000"].waitForExistence(timeout: 20))
        attach("folder-first-page")
        reveal(app.buttons["Load more"], within: picker)
        tap(app.buttons["Load more"])
        let last = app.buttons["Select Journey folder 064"]
        reveal(last, within: picker)
        XCTAssertTrue(last.isHittable, "The actual swipe must expose the final row from the second API page")
        let before = last.frame
        attach("folder-second-page-before-selection")
        tap(last)
        tap(app.buttons["View selected"])
        XCTAssertTrue(app.staticTexts["Journey folder 064"].waitForExistence(timeout: 20))
        attach("folder-selection-retained")
        tap(app.buttons["Cancel"])
        let discard = app.alerts["Discard filter changes?"]
        XCTAssertTrue(discard.waitForExistence(timeout: 20))
        XCTAssertEqual(discard.buttons.count, 2, "The draft decision has only Keep and Discard actions")
        attach("folder-keep-editing-alert")
        tap(discard.buttons["Keep editing"])
        XCTAssertTrue(app.staticTexts["Journey folder 064"].waitForExistence(timeout: 20))
        attach("folder-keep-editing-retained")
        tap(app.buttons["Done"])
        XCTAssertTrue(last.waitForExistence(timeout: 20))
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: last)
        XCTAssertEqual(
            XCTWaiter.wait(for: [restored], timeout: 20),
            .completed,
            "Reopening must restore the second-page viewport without another swipe"
        )
        XCTAssertEqual(last.frame.minY, before.minY, accuracy: 80, "The same final row must return to the same visible region")
        attach("folder-second-page-restored")

        let search = app.textFields["Search matches"]
        for _ in 0 ..< 20 {
            if search.exists, search.isHittable { break }
            picker.swipeDown()
        }
        tap(search)
        let first = app.buttons["Select Journey folder 042"]
        XCTAssertFalse(first.isHittable, "The distinct query result must not already be visible before typing")
        search.typeText("Journey folder 042")
        let queryReset = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: first)
        XCTAssertEqual(
            XCTWaiter.wait(for: [queryReset], timeout: 20),
            .completed,
            "Typing a different query must reveal its first result without another scroll gesture"
        )
        let oldResultGone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: last)
        XCTAssertEqual(
            XCTWaiter.wait(for: [oldResultGone], timeout: 20),
            .completed,
            "The previous page-two result must not remain in the new query"
        )
        XCTAssertEqual(search.value as? String, "Journey folder 042")
        XCTAssertTrue(search.isHittable, "The new query must keep its search field visible")
        attach("folder-new-query-first-result")
        tap(app.buttons["Review filter"])
        tap(app.buttons["Apply filter"])
        tap(app.buttons["Done"])
        tap(app.buttons["Review changes"])
        tap(app.buttons["Save changes"])
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", level.name)).firstMatch
            .waitForExistence(timeout: 30))
        XCTAssertTrue(try gateway.hasSelectedFolder(
            levelId: level.id, sourceId: level.sourceId, folderId: "journey-folder-064"
        ), "The real saved policy must contain exactly the selected native reference")
        attach("folder-saved-level")
    }

    private func button(startingWith prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func tap(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 30), "Missing UI action: \(element)")
        let ready = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "hittable == true AND enabled == true"), object: element
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [ready], timeout: 30),
            .completed,
            "UI action did not become visible and enabled: \(element)"
        )
        element.tap()
    }

    private func revealAndTap(_ element: XCUIElement) {
        reveal(element, within: app)
        tap(element)
    }

    private func reveal(_ element: XCUIElement, within container: XCUIElement) {
        // Each iteration is a real navigation gesture, never a proxy or offset write.
        for _ in 0 ..< 20 {
            if element.exists, element.isHittable { return }
            container.swipeUp()
        }
        XCTFail("Actual swipes did not reveal \(element)")
    }

    private func attach(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
