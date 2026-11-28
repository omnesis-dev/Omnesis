// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

final class DesktopOnboardingUITests: XCTestCase {
    func testMenuBarReusesTheMainWindowAndReopensItAfterClosing() {
        let app = XCUIApplication()
        app.launch()
        let main = app.windows.matching(identifier: "Omnesis")
        let status = app.statusItems["Omnesis"]
        guard status.waitForExistence(timeout: 10) else {
            recordOwnedMenuCandidates(in: app)
            return XCTFail("The owned Omnesis menu-bar item must exist")
        }
        XCTAssertEqual(status.label, "Omnesis", "The menu item must name the application, not its image asset")
        let frame = status.frame
        XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
        XCTAssertGreaterThan(frame.width, 0)
        XCTAssertGreaterThan(frame.height, 0)
        XCTAssertTrue(status.isHittable, "The owned menu item must be visible and usable")
        for _ in 0 ..< 3 {
            status.click()
            let open = app.menuItems["Open Omnesis"]
            guard open.waitForExistence(timeout: 5) else {
                recordOwnedMenuCandidates(in: app)
                return XCTFail("The owned status item must open its native menu")
            }
            XCTAssertEqual(open.label, "Open Omnesis")
            XCTAssertTrue(open.isEnabled)
            XCTAssertTrue(open.isHittable)
            XCTAssertGreaterThan(open.frame.width, 0)
            XCTAssertGreaterThan(open.frame.height, 0)
            open.click()
            let unique = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 1"), object: main)
            XCTAssertEqual(XCTWaiter.wait(for: [unique], timeout: 5), .completed)
        }
        app.typeKey("w", modifierFlags: .command)
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 0"), object: main)
        XCTAssertEqual(
            XCTWaiter.wait(for: [closed], timeout: 5),
            .completed,
            "The library window must actually close before testing reopen"
        )
        XCTAssertNotEqual(app.state, .notRunning, "Closing the library window must keep the menu-bar app available")
        status.click()
        let open = app.menuItems["Open Omnesis"]
        guard open.waitForExistence(timeout: 5) else {
            recordOwnedMenuCandidates(in: app)
            return XCTFail("The menu must remain available after closing the library window")
        }
        XCTAssertEqual(open.label, "Open Omnesis")
        XCTAssertTrue(open.isEnabled)
        XCTAssertTrue(open.isHittable)
        open.click()
        XCTAssertTrue(main.firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(main.count, 1)
    }

    func testMenuBarSettingsRemainsReachableAfterClosingTheLibrary() {
        let app = XCUIApplication()
        app.launch()
        defer {
            if (testRun?.failureCount ?? 0) > 0 {
                recordOwnedMenuCandidates(in: app)
                let attachment = XCTAttachment(screenshot: app.screenshot())
                attachment.name = "owned-menu-settings-route-failure"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
        let main = app.windows.matching(identifier: "Omnesis")
        guard main.firstMatch.waitForExistence(timeout: 10) else { return XCTFail("The library window must appear before closing it") }
        app.typeKey("w", modifierFlags: .command)
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 0"), object: main)
        guard XCTWaiter.wait(for: [closed], timeout: 5) == .completed else { return XCTFail("The library window must actually close") }
        XCTAssertNotEqual(app.state, .notRunning)
        let status = app.statusItems["Omnesis"]
        guard status.waitForExistence(timeout: 10) else { return XCTFail("The owned status item must remain after closing the library") }
        XCTAssertEqual(status.label, "Omnesis")
        XCTAssertTrue(status.isHittable)
        let settings = app.windows.containing(.any, identifier: "settings-prerequisite-startup")
        for _ in 0 ..< 2 {
            status.click()
            let actions = status.menuItems.matching(identifier: "Settings…")
            let uniqueAction = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 1"), object: actions)
            guard XCTWaiter.wait(for: [uniqueAction], timeout: 5) == .completed else {
                return XCTFail("The owned status menu must offer exactly one Settings action")
            }
            let action = actions.element
            XCTAssertEqual(action.label, "Settings…")
            XCTAssertTrue(action.isEnabled)
            XCTAssertTrue(action.isHittable)
            action.click()
            let unique = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 1"), object: settings)
            let result = XCTWaiter.wait(for: [unique], timeout: 5)
            XCTAssertEqual(result, .completed, "The real scene action must open exactly one Settings window")
            guard result == .completed else { return }
            XCTAssertEqual(main.count, 0, "Opening Settings must not recreate the library window")
            app.typeKey("w", modifierFlags: .command)
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 0"), object: settings)
            let dismissal = XCTWaiter.wait(for: [dismissed], timeout: 5)
            XCTAssertEqual(dismissal, .completed)
            guard dismissal == .completed else { return }
            XCTAssertNotEqual(app.state, .notRunning)
        }
    }

    func testIncompleteBundleRefusesToStartDataCollection() {
        let app = XCUIApplication()
        app.launch()
        let expected = "This copy of Omnesis is missing its background service. Install the complete Omnesis app to continue."
        assertVisibleCopy(expected, identifier: "runtime-error", in: app)
        XCTAssertFalse(app.buttons["use-this-mac"].exists)
        XCTAssertFalse(app.textFields["chat-input"].exists)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "incomplete-bundle-refusal"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func assertVisibleCopy(_ expected: String, identifier: String, in app: XCUIApplication, timeout: TimeInterval = 15) {
        let banner = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        let exactCopy = NSPredicate(format: "label == %@ OR value == %@", expected, expected)
        let permittedText = [banner, banner.staticTexts.matching(exactCopy).firstMatch, banner.textViews.matching(exactCopy).firstMatch]
        let main = app.windows["Omnesis"]
        let visibleRefusal = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard main.exists else { return false }
            return permittedText.contains { text in
                guard text.exists, [.staticText, .textView].contains(text.elementType),
                      text.label == expected || text.value as? String == expected else { return false }
                let frame = text.frame
                return frame.width > 0 && frame.height > 0 && !frame.isInfinite && !frame.isNull && main.frame.contains(frame)
            }
        }, object: nil)
        let result = XCTWaiter.wait(for: [visibleRefusal], timeout: timeout)
        if result != .completed {
            let elements = [banner, banner.staticTexts.firstMatch, banner.textViews.firstMatch]
            let facts: [[String: Any]] = elements.map { element in
                guard element.exists else { return ["exists": false] }
                let value = element.value as? String ?? ""
                let normalize: (String) -> String = { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
                return [
                    "exists": true, "role": String(describing: element.elementType),
                    "labelCharacters": element.label.count, "valueCharacters": value.count,
                    "exactLabel": element.label == expected, "exactValue": value == expected,
                    "normalizedLabel": normalize(element.label) == normalize(expected),
                    "normalizedValue": normalize(value) == normalize(expected),
                    "positiveFrame": element.frame.width > 0 && element.frame.height > 0,
                    "insideOwnedWindow": main.exists && main.frame.contains(element.frame),
                ]
            }
            if let json = try? JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys]),
               let text = String(data: json, encoding: .utf8) {
                let attachment = XCTAttachment(string: text)
                attachment.name = identifier + "-copy-semantics"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
        XCTAssertEqual(result, .completed, "The complete \(identifier) copy must be visible in the owned window")
    }

    private func recordOwnedMenuCandidates(in app: XCUIApplication) {
        let expectedName = NSPredicate(format: "label == %@ OR identifier == %@", "Omnesis", "Omnesis")
        let queries: [(String, XCUIElementQuery)] = [
            ("statusItem", app.descendants(matching: .statusItem)),
            ("menuBarItem", app.descendants(matching: .menuBarItem).matching(expectedName)),
            ("button", app.descendants(matching: .button).matching(expectedName)),
            ("menuItem", app.descendants(matching: .menuItem)),
        ]
        var facts: [[String: Any]] = []
        for (role, query) in queries {
            let count = query.count
            var candidates: [[String: Any]] = []
            for index in 0 ..< min(count, 8) {
                let item = query.element(boundBy: index)
                let frame = item.frame
                let components = [frame.minX, frame.minY, frame.width, frame.height].map { Double($0) }
                let finite = components.allSatisfy(\.isFinite)
                candidates.append([
                    "labelMatches": item.label == "Omnesis", "identifierMatches": item.identifier == "Omnesis",
                    "hittable": item.isHittable, "enabled": item.isEnabled, "finiteFrame": finite,
                    "openActionMatches": item.label == "Open Omnesis",
                    "frame": finite ? components : [],
                ])
            }
            facts.append(["role": role, "count": count, "truncated": count > 8, "candidates": candidates])
        }
        guard let json = try? JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys]),
              let text = String(data: json, encoding: .utf8) else { return }
        let attachment = XCTAttachment(string: text)
        attachment.name = "owned-menu-candidate-geometry"
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
        let warning = "A desktop Mac you leave powered on, such as a Mac mini, is a good home for your library. This Mac must stay awake and start Omnesis when you sign in. Setup will guide and verify those required settings. Your other devices use this Mac to search and ask questions. Moving your library to another computer is not available yet."
        assertVisibleCopy(warning, identifier: "home-location-warning", in: app, timeout: 5)
        app.checkBoxes["confirm-first-library"].click()
        XCTAssertTrue(useThisMac.isEnabled)
    }
}
