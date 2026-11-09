// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// The app's main journeys, driven the way a person drives them — launch,
/// tap, type, read what appears — against a real synthetic gateway.
///
/// `scripts/run-mobile-journeys.sh ios` boots the gateway (the `e2e-minimal`
/// universe, with the replay agent standing in for a model) and runs this
/// class. Each journey is independent: pairing starts from an unpaired app;
/// the others start from an app the DEBUG launch seam has already paired, so
/// one broken journey does not cascade into the rest.
///
/// The data the journeys look for is invented: the Granola note "Acme Q3
/// Planning" in `evals/universes/e2e-minimal/` and the replayed
/// `temporal-recall` scenario in `evals/universes/default/agent-demos/`.
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
        // Glass chrome never reports idle to XCTest; see `AutomationGlass`.
        app.launchEnvironment["DEMO_PLAIN_GLASS"] = "1"
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
            element(containing: gateway.hostAndPort).waitForExistence(timeout: 10),
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
    func testSearchListsAMatchingDocument() throws {
        try launchPaired()
        search(for: Self.documentTitle)
        XCTAssertTrue(
            searchResult(titled: Self.documentTitle).waitForExistence(timeout: 30),
            "searching for \"\(Self.documentTitle)\" did not list the document"
        )
    }

    /// Search → tap a result → the document opens with its content.
    func testOpeningASearchResultShowsTheDocument() throws {
        try launchPaired()
        search(for: Self.documentTitle)
        let result = searchResult(titled: Self.documentTitle)
        tap(result, "the \"\(Self.documentTitle)\" result")
        // The result row's snippet quotes the same line, so the line alone
        // proves nothing until the results list has given way to the document.
        XCTAssertTrue(
            result.waitForNonExistence(timeout: 30),
            "tapping the \"\(Self.documentTitle)\" result did not open the document"
        )
        XCTAssertTrue(
            element(containing: Self.documentLine).waitForExistence(timeout: 30),
            "the opened document does not show \"\(Self.documentLine)\""
        )
    }

    /// Ask screen → type a question → send → the agent's answer streams in.
    /// The gateway's replay backend answers from a recorded scenario, so no
    /// model runs.
    func testAskingTheAgentShowsItsAnswer() throws {
        try launchPaired()
        let composer = app.textFields["agentComposer"]
        tap(composer, "the Ask composer")
        composer.typeText(Self.agentQuestion)
        tap(app.buttons["agentSendButton"], "the Send button")
        XCTAssertTrue(
            element(containing: Self.agentAnswer).waitForExistence(timeout: 60),
            "the agent's answer did not mention \"\(Self.agentAnswer)\""
        )
    }

    /// Settings → the gateway goes away → the row says it is retrying, without
    /// asking to pair again → the gateway returns and the user comes back to the
    /// app → connected on the same pairing. The forwarder stands in for the
    /// network, because a simulator shares its host's and cannot lose it.
    func testGatewayOutageRecoversWithoutPairingAgain() throws {
        let host = try XCTUnwrap(gateway.url.host)
        let forwarder = LoopbackForwarder(targetHost: host, targetPort: UInt16(gateway.url.port ?? 443))
        defer { forwarder.stop() }
        let port = try runAsync { try await forwarder.start() }
        try launchPaired(pairedUrl: XCTUnwrap(URL(string: "https://127.0.0.1:\(port)")))

        openSettings()
        let connected = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Connected"))
            .firstMatch
        // The Form only builds the rows on screen, and the health sections above
        // the gateway's can push this one below the fold.
        if !connected.waitForExistence(timeout: 30) { app.swipeUp() }
        XCTAssertTrue(
            connected.waitForExistence(timeout: 60),
            "Settings never showed the live connection"
        )

        forwarder.stop()
        XCTAssertTrue(
            element(containing: "Reconnecting to gateway").waitForExistence(timeout: 60),
            "the outage did not read as a temporary state"
        )
        XCTAssertFalse(element(containing: "Authentication failed").exists)
        XCTAssertFalse(element(containing: "Couldn't verify gateway certificate").exists)
        XCTAssertTrue(
            element(containing: "Could not connect to the server").waitForExistence(timeout: 60),
            "the row dropped the transport's diagnostic"
        )
        XCTAssertFalse(
            element(containing: "re-pair using").exists,
            "a brief outage must not suggest pairing again"
        )

        _ = try runAsync { try await forwarder.start(port: port) }
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(
            connected.waitForExistence(timeout: 60),
            "the app did not reconnect on the same pairing"
        )
    }

    // MARK: - Steps

    private func launchPaired(pairedUrl: URL? = nil) throws {
        let deviceName = "Journey iPhone \(UUID().uuidString.prefix(8))"
        app.launchEnvironment["DEMO_PAIRING_JSON"] = try gateway.automationPairingJSON(
            deviceName: deviceName,
            pairedUrl: pairedUrl
        )
        app.launch()
    }

    /// Runs async setup from a synchronous test, which XCUITest's main-thread
    /// tapping needs to stay.
    private func runAsync(_ work: @escaping @Sendable () async throws -> UInt16) throws -> UInt16 {
        let done = expectation(description: "async step")
        final class Box: @unchecked Sendable { var result: Result<UInt16, Error>? }
        let box = Box()
        Task {
            do {
                box.result = try await .success(work())
            } catch {
                box.result = .failure(error)
            }
            done.fulfill()
        }
        wait(for: [done], timeout: 30)
        return try XCTUnwrap(box.result).get()
    }

    /// Opens Settings through the drawer. A row stays in the tree, disabled,
    /// while the drawer is closed, so its existence proves nothing; and the menu
    /// button can go unanswered over a just-resumed conversation, so the drawer's
    /// arrival is what ends the wait. The gear is tapped directly because the
    /// row's button reports the whole action bar as its frame, whose centre is
    /// the empty space between the gear and Ask.
    private func openSettings() {
        let settings = app.buttons["menu.settings"]
        let arrived = NSPredicate(format: "exists == true AND enabled == true")
        for _ in 0 ..< 3 {
            tap(app.buttons["menu.toggle"], "the menu button")
            let opened = XCTNSPredicateExpectation(predicate: arrived, object: settings)
            if XCTWaiter.wait(for: [opened], timeout: 15) == .completed { break }
        }
        XCTAssertTrue(settings.isEnabled, "the menu did not open")
        tap(settings.images["gearshape"], "the Settings gear")
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
