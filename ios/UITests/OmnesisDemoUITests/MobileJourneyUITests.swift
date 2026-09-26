// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// The app's main journeys, driven the way a person drives them — launch,
/// tap, type, read what appears — against a real synthetic gateway.
///
/// `scripts/run-mobile-journeys.sh ios` boots the gateway (the `default`
/// universe, with the replay agent standing in for a model) and runs this
/// class. Each journey is independent: pairing starts from an unpaired app;
/// the others start from an app the DEBUG launch seam has already paired, so
/// one broken journey does not cascade into the rest.
///
/// The data the journeys look for is invented and lives in
/// `evals/universes/default/`: the Granola note "Acme Q3 Planning" and the
/// replayed `temporal-recall` agent scenario.
final class MobileJourneyUITests: XCTestCase {
    private var gateway: JourneyGateway!
    private var app: XCUIApplication!

    private static let documentTitle = "Acme Q3 Planning"
    private static let documentLine = "Draft the migration plan by Friday"
    private static let agentQuestion = "Where was I on September 2?"
    private static let agentAnswer = "Studio Northstar"

    override func setUpWithError() throws {
        continueAfterFailure = false
        gateway = try JourneyGateway.fromEnvironment()
        app = XCUIApplication()
        // The app asks for notification, speech and microphone access as its
        // screens appear. Answer whichever system alert shows up whenever it
        // blocks the next interaction.
        addUIInterruptionMonitor(withDescription: "System permission alert") { alert in
            Self.answer(alert)
        }
    }

    override func tearDownWithError() throws {
        app = nil
        gateway = nil
    }

    // MARK: - Journeys

    /// Onboarding → pairing screen → paste the QR payload the gateway minted
    /// → confirm the host → the app lands on the "You're connected" page of
    /// phone setup, and the gateway lists the new iPhone.
    func testPairingWithTheGatewaysPayload() throws {
        let deviceName = "Journey iPhone \(UUID().uuidString.prefix(8))"
        let payload = try gateway.mintPairingPayload(deviceName: deviceName)

        app.launchEnvironment["DEMO_RESET_PAIRING"] = "1"
        app.launch()

        tap(app.buttons["onboarding.pair"], "the onboarding Pair button")

        // The simulator has no camera, so the scanner reports that first —
        // exactly what a person pairing a simulator sees.
        let scanError = app.alerts["Scan error"]
        if scanError.waitForExistence(timeout: 10) {
            scanError.buttons["OK"].tap()
        }

        tap(app.buttons["pairing.moreOptions"], "the pairing options menu")
        tap(app.buttons["Paste JSON"], "the Paste JSON option")
        let field = app.textViews["pairing.pasteJSON.field"]
        tap(field, "the pairing payload field")
        field.typeText(payload)
        tap(app.buttons["pairing.pasteJSON.submit"], "the paste sheet's Pair button")

        XCTAssertTrue(
            app.staticTexts[gateway.hostAndPort].waitForExistence(timeout: 10),
            "the confirmation sheet does not name the gateway \(gateway.hostAndPort)"
        )
        tap(app.buttons["pairing.confirm"], "the confirmation sheet's Pair button")

        XCTAssertTrue(
            app.staticTexts["Connection verified"].waitForExistence(timeout: 60),
            "pairing did not reach phone setup's connected page"
        )
        XCTAssertTrue(try gateway.hasDevice(named: deviceName, kind: "ios"), "the gateway does not list \(deviceName)")

        tap(app.buttons["phoneSetup.choose"], "Choose what to add")
        tap(app.buttons["phoneSetup.skip"], "Skip for now")
        XCTAssertTrue(
            app.textFields["agentComposer"].waitForExistence(timeout: 30),
            "skipping phone setup did not land on the Ask screen"
        )
    }

    /// Menu → Search → type a query → the matching document is listed.
    func testSearchListsAMatchingDocument() {
        launchPaired()
        search(for: Self.documentTitle)
        XCTAssertTrue(
            searchResult(titled: Self.documentTitle).waitForExistence(timeout: 30),
            "searching for \"\(Self.documentTitle)\" did not list the document"
        )
    }

    /// Search → tap a result → the document opens with its content.
    func testOpeningASearchResultShowsTheDocument() {
        launchPaired()
        search(for: Self.documentTitle)
        tap(searchResult(titled: Self.documentTitle), "the \"\(Self.documentTitle)\" result")
        XCTAssertTrue(
            element(containing: Self.documentLine).waitForExistence(timeout: 30),
            "the opened document does not show \"\(Self.documentLine)\""
        )
    }

    /// Ask screen → type a question → send → the agent's answer streams in.
    /// The gateway's replay backend answers from a recorded scenario, so no
    /// model runs.
    func testAskingTheAgentShowsItsAnswer() {
        launchPaired()
        let composer = app.textFields["agentComposer"]
        tap(composer, "the Ask composer")
        composer.typeText(Self.agentQuestion)
        tap(app.buttons["agentSendButton"], "the Send button")
        XCTAssertTrue(
            element(containing: Self.agentAnswer).waitForExistence(timeout: 60),
            "the agent's answer did not mention \"\(Self.agentAnswer)\""
        )
    }

    // MARK: - Steps

    private func launchPaired() {
        app.launchEnvironment["DEMO_PAIRING_JSON"] = gateway.automationPairingJSON
        app.launch()
    }

    private func search(for query: String) {
        tap(app.buttons["menu.toggle"], "the menu button")
        tap(app.buttons["menu.search"], "the Search menu row")
        let field = app.textFields["search.field"]
        tap(field, "the search field")
        field.typeText(query + "\n")
    }

    private func searchResult(titled title: String) -> XCUIElement {
        app.buttons
            .matching(NSPredicate(format: "identifier == 'search.result' AND label CONTAINS %@", title))
            .firstMatch
    }

    private func element(containing text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text))
            .firstMatch
    }

    /// Waits for `element`, then taps it. A system alert over the app is
    /// answered first by the interruption monitor, which XCTest runs when an
    /// interaction is blocked.
    private func tap(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 30) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(what) never appeared")
        element.tap()
    }

    private static func answer(_ alert: XCUIElement) -> Bool {
        for label in ["Allow", "Allow While Using App", "OK", "Continue"] {
            let button = alert.buttons[label]
            if button.exists {
                button.tap()
                return true
            }
        }
        return false
    }
}
