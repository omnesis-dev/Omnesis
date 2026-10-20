// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// The Tasks screen's interactions, driven on the simulator against
/// `TasksDemoGateway` (`DEMO_MENU_REVEAL=tasks`), each judged by what the
/// screen shows afterwards — the circle, the tab a task sits in, the counts
/// on the tabs, the receipt and its Undo — never only by the call made.
///
/// The fan's targets are found the way the screen lays them out
/// (`TaskFanSession`): a column up and to the left of the press, Done (or a
/// suggestion's Accept) nearest, each 50 points further away. Each test presses a row with room
/// above it, so the column is never moved to fit.
final class TasksInteractionUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["DEMO_MENU_REVEAL"] = "tasks"
        app.launch()
        XCTAssertTrue(chip("Today").waitForExistence(timeout: 15), "the Tasks screen did not load")
        XCTAssertTrue(text(Fixture.marathon).waitForExistence(timeout: 10), "today's tasks did not load")
    }

    override func tearDownWithError() throws {
        // What the screen showed when a check failed, for review.
        if let run = testRun, run.failureCount > 0 {
            keepScreenshot("326-" + name.replacingOccurrences(of: "[^A-Za-z]", with: "", options: .regularExpression))
        }
        app = nil
    }

    /// Titles from the fixture `TasksFanDemoSurface` serves.
    private enum Fixture {
        static let marathon = "Go over the marathon entry form with Maya Reeves"
        static let agenda = "Draft the Q4 budget review agenda"
        static let insurance = "Renew the car insurance"
        static let suggestion = "Reply to Jamie Lopez about the venue deposit"
        static let passport = "Renew the passport before the Lisbon trip"
        /// The lowest suggestion, with room above it for its fan.
        static let tent = "Return the borrowed camping tent"
        static let suggestedCount = 7
    }

    // MARK: - 1. The circle

    func testCircleCompletesThenReopens() {
        let title = Fixture.marathon
        XCTAssertTrue(chipLabel("Today").hasPrefix("Today (5)"), chipLabel("Today"))
        circle(complete: title).tap()
        XCTAssertTrue(wait { self.isListed(self.circle(reopen: title)) }, "the row did not turn done")
        XCTAssertTrue(wait { self.text("Done: \(title)").exists }, "no receipt")
        XCTAssertTrue(wait { self.chipLabel("Today").hasPrefix("Today (4)") }, chipLabel("Today"))
        XCTAssertTrue(reveal(circle(reopen: title)))
        circle(reopen: title).tap()
        XCTAssertTrue(wait { self.isListed(self.circle(complete: title)) }, "the row did not reopen")
        XCTAssertTrue(wait { self.chipLabel("Today").hasPrefix("Today (5)") }, chipLabel("Today"))
    }

    func testUndoAfterTheCircle() {
        let title = Fixture.marathon
        circle(complete: title).tap()
        XCTAssertTrue(wait { self.isListed(self.circle(reopen: title)) })
        undo()
        XCTAssertTrue(wait { self.circle(complete: title).exists }, "Undo did not restore the open row")
        XCTAssertTrue(wait { self.chipLabel("Today").hasPrefix("Today (5)") }, chipLabel("Today"))
    }

    // MARK: - 2. Done, Done + note

    func testFanDoneCompletesTheRow() throws {
        let title = Fixture.marathon
        try fan(on: title, choose: 0)
        XCTAssertTrue(wait { self.text("Done: \(title)").exists }, "no receipt")
        XCTAssertTrue(wait { self.isListed(self.circle(reopen: title)) }, "the receipt says done but the row is still open")
        XCTAssertTrue(wait { self.chipLabel("Today").hasPrefix("Today (4)") }, chipLabel("Today"))
        undo()
        XCTAssertTrue(wait { self.circle(complete: title).exists }, "Undo did not restore the open row")
    }

    func testFanDoneWithNoteCompletesWithTheNote() throws {
        let title = Fixture.marathon
        try fan(on: title, choose: 1)
        XCTAssertTrue(app.staticTexts["Done with a note"].waitForExistence(timeout: 5), "the composer did not open")
        let field = app.textFields["captureTranscript"].exists ? app.textFields["captureTranscript"] : app.textViews["captureTranscript"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.tap()
        field.typeText("Signed at the club")
        app.buttons["captureDoneButton"].tap()
        XCTAssertTrue(wait { !self.app.staticTexts["Done with a note"].exists }, "the composer stayed open")
        XCTAssertTrue(wait { self.isListed(self.circle(reopen: title)) }, "the row did not turn done")
        XCTAssertTrue(wait { self.isListed(self.text("Signed at the club")) }, "the note is not shown on the row")
    }

    func testDismissingTheNoteComposerChangesNothing() throws {
        let title = Fixture.marathon
        try fan(on: title, choose: 1)
        XCTAssertTrue(app.staticTexts["Done with a note"].waitForExistence(timeout: 5))
        app.buttons["Cancel capture"].tap()
        XCTAssertTrue(wait { !self.app.staticTexts["Done with a note"].exists })
        XCTAssertTrue(circle(complete: title).exists, "dismissing changed the task")
        XCTAssertTrue(chipLabel("Today").hasPrefix("Today (5)"), chipLabel("Today"))
    }

    // MARK: - 3. Moving

    func testFanTomorrowMovesTheRowToMonth() throws {
        let title = Fixture.agenda
        try fan(on: title, choose: 2)
        XCTAssertTrue(wait { !self.text(title).exists }, "the row is still on Today")
        XCTAssertTrue(wait { self.chipLabel("Today").hasPrefix("Today (4)") }, chipLabel("Today"))
        open("Month")
        XCTAssertTrue(text(title).waitForExistence(timeout: 5), "the row is not in Month")
        XCTAssertTrue(text("Tomorrow").exists, "no Tomorrow plan label")
        open("Today")
        XCTAssertTrue(wait { self.text(Fixture.marathon).exists })
        XCTAssertFalse(text(title).exists, "Today shows the moved row again")
    }

    func testFanNextMonthMovesTheRowToFuture() throws {
        let title = Fixture.agenda
        try fan(on: title, choose: 3)
        XCTAssertTrue(wait { !self.text(title).exists }, "the row is still on Today")
        XCTAssertTrue(wait { self.chipLabel("Today").hasPrefix("Today (4)") }, chipLabel("Today"))
        open("Future")
        XCTAssertTrue(text(title).waitForExistence(timeout: 5), "the row is not in Future")
        XCTAssertTrue(text("November").exists, "no November plan label")
    }

    /// Undo straight after a move puts the task back on Today and takes it
    /// out of the view it went to.
    func testUndoAfterAMove() throws {
        let title = Fixture.agenda
        try fan(on: title, choose: 2)
        XCTAssertTrue(wait { !self.text(title).exists }, "the row is still on Today")
        undo()
        XCTAssertTrue(wait { self.isListed(self.text(title)) }, "Undo did not bring the row back to Today")
        XCTAssertTrue(wait { self.chipLabel("Today").hasPrefix("Today (5)") }, chipLabel("Today"))
        open("Month")
        XCTAssertTrue(text("Collect the framed prints from Studio Northstar").waitForExistence(timeout: 5))
        XCTAssertFalse(isListed(text(title)), "Month still lists the task Undo moved back")
    }

    func testFanOtherMonthPicksAMonth() throws {
        let title = Fixture.agenda
        let anchor = try pressPoint(on: title, needing: 8)
        // Rest on Other month…, then — still pressed — move off the spot
        // the month fan opened under and onto Jan 2027.
        var touch = TouchPath(pressAt: anchor)
        touch.hold(0.7)
        touch.slide(to: target(from: anchor, index: 4, of: 6))
        touch.hold(0.9)
        touch.slide(to: target(from: anchor, index: 2, of: 8))
        touch.hold(0.2)
        try touch.perform()
        XCTAssertTrue(wait { !self.text(title).exists }, "the row is still on Today")
        open("Future")
        XCTAssertTrue(text(title).waitForExistence(timeout: 5), "the row is not in Future")
        XCTAssertTrue(text("January 2027").exists, "no January 2027 plan label")
    }

    // MARK: - 4. Cancel task

    func testFanCancelTaskStrikesIt() throws {
        let title = Fixture.agenda
        try fan(on: title, choose: 5)
        XCTAssertTrue(wait { self.text("Struck: \(title)").exists }, "no receipt")
        // Undo restores it; strike it again to follow it into Done.
        undo()
        XCTAssertTrue(wait { self.isListed(self.circle(complete: title)) }, "Undo did not restore the struck task")
        try fan(on: title, choose: 5)
        XCTAssertTrue(wait { self.isListed(self.circle(reopen: title)) }, "the row is not struck")
        XCTAssertTrue(wait { self.chipLabel("Today").hasPrefix("Today (4)") }, chipLabel("Today"))
        open("Done")
        XCTAssertTrue(text(title).waitForExistence(timeout: 5), "the struck task is not in Done")
        open("Today")
        XCTAssertTrue(reveal(circle(reopen: title)))
        circle(reopen: title).tap()
        XCTAssertTrue(wait { self.isListed(self.circle(complete: title)) }, "reopening a struck task failed")
    }

    // MARK: - 6. Suggestions

    /// The banner that leads to the suggestions opens Today, above the
    /// day's tasks, so a long day never pushes it out of sight.
    func testTheReviewBannerSitsAboveTodaysTasks() {
        let banner = app.buttons["Omnesis has created \(Fixture.suggestedCount) tasks for your review"]
        XCTAssertTrue(banner.waitForExistence(timeout: 5), "no review banner")
        XCTAssertLessThan(banner.frame.maxY, circle(complete: Fixture.marathon).frame.minY, "the banner is below a task")
        XCTAssertLessThan(banner.frame.minY, chip("Today").frame.maxY + 40, "the banner is not at the top")
        banner.tap()
        XCTAssertTrue(text(Fixture.suggestion).waitForExistence(timeout: 5), "the banner did not open Suggested")
    }

    /// The circle on a suggestion marks it already done: it leaves the
    /// suggestions for Done, and Undo makes it a suggestion again.
    func testASuggestionsCircleMarksItDone() {
        openSuggested()
        let title = Fixture.suggestion
        circle(complete: title).tap()
        XCTAssertTrue(wait { self.text("Done: \(title)").exists }, "no receipt")
        XCTAssertTrue(wait { !self.circle(complete: title).exists && !self.circle(reopen: title).exists }, "the suggestion is still listed")
        XCTAssertTrue(wait { self.suggestedCount() == Fixture.suggestedCount - 1 }, chip("Suggested").label)
        undo()
        XCTAssertTrue(wait { self.circle(complete: title).exists }, "Undo did not bring the suggestion back")
        XCTAssertTrue(wait { self.suggestedCount() == Fixture.suggestedCount }, chip("Suggested").label)
        circle(complete: title).tap()
        XCTAssertTrue(wait { !self.circle(complete: title).exists })
        open("Done")
        XCTAssertTrue(text(title).waitForExistence(timeout: 5), "the suggestion marked done is not in Done")
    }

    func testFanAcceptMovesTheSuggestionIntoTheTasks() throws {
        openSuggested()
        let title = Fixture.tent
        try fan(on: title, choose: 0, of: 5)
        XCTAssertTrue(wait { self.text("Added to your tasks: \(title)").exists }, "no receipt")
        XCTAssertTrue(wait { !self.text(title).exists }, "the accepted suggestion is still in Suggested")
        XCTAssertTrue(wait { self.suggestedCount() == Fixture.suggestedCount - 1 }, chip("Suggested").label)
        open("Anytime")
        XCTAssertTrue(circle(complete: title).waitForExistence(timeout: 5), "the accepted task is not in Anytime")
        open("Suggested")
        XCTAssertTrue(text(Fixture.passport).waitForExistence(timeout: 5))
        XCTAssertFalse(text(title).exists, "Suggested shows the accepted task again")
    }

    func testFanAcceptWithNoteAcceptsWithTheNote() throws {
        openSuggested()
        let title = Fixture.tent
        try fan(on: title, choose: 1, of: 5)
        XCTAssertTrue(app.staticTexts["Accept with a note"].waitForExistence(timeout: 5), "the composer did not open")
        XCTAssertTrue(text(title).exists, "the composer does not name the task")
        let field = app.textFields["captureTranscript"].exists ? app.textFields["captureTranscript"] : app.textViews["captureTranscript"]
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.tap()
        field.typeText("Maya needs it back by Saturday")
        app.buttons["captureDoneButton"].tap()
        XCTAssertTrue(wait { !self.app.staticTexts["Accept with a note"].exists }, "the composer stayed open")
        XCTAssertTrue(wait { self.text("Added to your tasks: \(title)").exists }, "no receipt")
        XCTAssertTrue(wait { !self.text(title).exists }, "the accepted suggestion is still in Suggested")
        open("Anytime")
        XCTAssertTrue(circle(complete: title).waitForExistence(timeout: 5), "the accepted task is not in Anytime")
    }

    func testCancellingTheAcceptNoteChangesNothing() throws {
        openSuggested()
        let title = Fixture.tent
        try fan(on: title, choose: 1, of: 5)
        XCTAssertTrue(app.staticTexts["Accept with a note"].waitForExistence(timeout: 5))
        app.buttons["Cancel capture"].tap()
        XCTAssertTrue(wait { !self.app.staticTexts["Accept with a note"].exists })
        XCTAssertTrue(isListed(circle(complete: title)), "cancelling changed the suggestion")
        XCTAssertEqual(suggestedCount(), Fixture.suggestedCount)
    }

    /// Accept for… opens the times; Tomorrow accepts it planned for tomorrow.
    func testFanAcceptForTomorrowPlansIt() throws {
        openSuggested()
        let title = Fixture.tent
        let anchor = try pressPoint(on: title, needing: 7)
        var touch = TouchPath(pressAt: anchor)
        touch.hold(0.7)
        touch.slide(to: target(from: anchor, index: 2, of: 5))
        touch.hold(0.9)
        // Tomorrow opens under the finger, which must move deliberately
        // before anything is chosen: across Today, then back up onto it.
        touch.slide(to: target(from: anchor, index: 1, of: 7))
        touch.slide(to: target(from: anchor, index: 2, of: 7))
        touch.hold(0.2)
        try touch.perform()
        XCTAssertTrue(wait { self.text("Added to your tasks: \(title)").exists }, "no receipt")
        XCTAssertTrue(wait { !self.text(title).exists }, "the accepted suggestion is still in Suggested")
        open("Month")
        XCTAssertTrue(isListed(circle(complete: title)), "the task accepted for tomorrow is not in Month")
        XCTAssertTrue(text("Tomorrow").exists, "no Tomorrow plan label")
    }

    /// Accept for… then Someday: the task goes to Future, planned someday.
    func testFanAcceptForSomedayPlansIt() throws {
        openSuggested()
        let title = Fixture.tent
        let anchor = try pressPoint(on: title, needing: 7)
        var touch = TouchPath(pressAt: anchor)
        touch.hold(0.7)
        touch.slide(to: target(from: anchor, index: 2, of: 5))
        touch.hold(0.9)
        touch.slide(to: target(from: anchor, index: 6, of: 7))
        touch.hold(0.2)
        try touch.perform()
        XCTAssertTrue(wait { !self.text(title).exists }, "the accepted suggestion is still in Suggested")
        open("Future")
        XCTAssertTrue(circle(complete: title).waitForExistence(timeout: 5), "the task accepted for someday is not in Future")
    }

    func testFanMarkAsDoneResolvesTheSuggestion() throws {
        openSuggested()
        let title = Fixture.tent
        try fan(on: title, choose: 3, of: 5)
        XCTAssertTrue(wait { self.text("Done: \(title)").exists }, "no receipt")
        XCTAssertTrue(wait { !self.circle(complete: title).exists }, "the suggestion marked done is still open")
        undo()
        XCTAssertTrue(wait { self.isListed(self.circle(complete: title)) }, "Undo did not bring the suggestion back")
        try fan(on: title, choose: 3, of: 5)
        XCTAssertTrue(wait { !self.circle(complete: title).exists })
        open("Done")
        XCTAssertTrue(text(title).waitForExistence(timeout: 5), "the suggestion marked done is not in Done")
    }

    /// Ignore takes the suggestion out of every Tasks view and the count;
    /// Undo makes it a suggestion again.
    func testFanIgnoreHidesTheSuggestionAndUndoRestoresIt() throws {
        openSuggested()
        let title = Fixture.tent
        try fan(on: title, choose: 4, of: 5)
        XCTAssertTrue(wait { self.text("Ignored: \(title)").exists }, "no receipt")
        XCTAssertTrue(wait { !self.text(title).exists }, "the ignored suggestion is still shown")
        XCTAssertTrue(wait { self.suggestedCount() == Fixture.suggestedCount - 1 }, chip("Suggested").label)
        undo()
        XCTAssertTrue(wait { self.isListed(self.circle(complete: title)) }, "Undo did not bring the suggestion back")
        XCTAssertTrue(wait { self.suggestedCount() == Fixture.suggestedCount }, chip("Suggested").label)
        try fan(on: title, choose: 4, of: 5)
        XCTAssertTrue(wait { !self.text(title).exists })
        for name in ["Today", "Anytime", "Done", "Suggested"] {
            open(name)
            XCTAssertFalse(text(title).waitForExistence(timeout: 1), "\(name) shows the ignored suggestion")
        }
    }

    // MARK: - 7, 8. A press that does nothing, details

    func testALongPressReleasedOffTheTargetsChangesNothing() throws {
        let title = Fixture.marathon
        let anchor = try pressPoint(on: title, needing: 6)
        var touch = TouchPath(pressAt: anchor)
        touch.hold(0.7)
        touch.slide(to: CGPoint(x: app.frame.maxX - 12, y: app.frame.maxY - 40))
        try touch.perform()
        XCTAssertTrue(wait { !self.app.buttons["Cancel task"].exists }, "the fan stayed open")
        XCTAssertTrue(circle(complete: title).exists, "the task changed")
        XCTAssertFalse(app.navigationBars["Task"].exists, "a long press opened the details")
        XCTAssertTrue(chipLabel("Today").hasPrefix("Today (5)"), chipLabel("Today"))
    }

    func testTappingTheTextOpensDetails() {
        text(Fixture.marathon).tap()
        XCTAssertTrue(app.navigationBars["Task"].waitForExistence(timeout: 5), "the details did not open")
        XCTAssertTrue(app.staticTexts["DOCUMENTS"].exists || app.buttons["Marathon entry form.pdf"].exists, "no documents in the details")
        app.navigationBars["Task"].buttons["Cancel"].tap()
        XCTAssertTrue(circle(complete: Fixture.marathon).waitForExistence(timeout: 5), "opening details changed the task")
    }

    /// The details sheet is flat on the page background and lists each
    /// document as a row that opens it; the deadline toggle, History and
    /// Cancel still do what they say, and nothing about the task changes.
    func testTheDetailsListDocumentsAndKeepTheirControls() {
        text(Fixture.marathon).tap()
        XCTAssertTrue(app.navigationBars["Task"].waitForExistence(timeout: 5), "the details did not open")
        XCTAssertTrue(
            app.otherElements["tasks.editor"].exists || app.scrollViews["tasks.editor"].exists,
            "the details are not the flat sheet"
        )
        XCTAssertTrue(app.staticTexts["DOCUMENTS"].exists, "no Documents section")
        let documents = app.buttons.matching(identifier: "tasks.editor.document")
        XCTAssertEqual(documents.count, 5, "the details do not list the task's five documents")

        let deadline = app.switches["Has a deadline"]
        XCTAssertTrue(deadline.exists, "no deadline toggle")
        deadline.switches.firstMatch.tap()
        XCTAssertTrue(
            wait { (self.app.switches["Has a deadline"].value as? String) == "1" },
            "the deadline toggle did not turn on"
        )
        XCTAssertTrue(app.staticTexts["Kind"].exists, "turning the deadline on showed no kind")

        let form = documents.element(boundBy: 0)
        XCTAssertTrue(form.label.contains("Marathon entry form.pdf"), "the first document row is \(form.label)")
        XCTAssertTrue(reveal(form), "the first document is not on screen")
        form.tap()
        XCTAssertTrue(app.navigationBars.buttons["Task"].waitForExistence(timeout: 5), "the document did not open over the details")
        app.navigationBars.buttons["Task"].tap()
        XCTAssertTrue(app.navigationBars["Task"].waitForExistence(timeout: 5), "going back did not return to the details")

        let history = app.buttons["History"]
        XCTAssertTrue(reveal(history), "History is not on screen")
        history.tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 5), "History did not open")
        app.navigationBars["History"].buttons["Task"].tap()
        XCTAssertTrue(app.navigationBars["Task"].waitForExistence(timeout: 5), "going back did not return to the details")

        app.navigationBars["Task"].buttons["Cancel"].tap()
        XCTAssertTrue(circle(complete: Fixture.marathon).waitForExistence(timeout: 5), "cancelling the details changed the task")
    }

    // MARK: - 9. Tell Omnesis

    /// The bar's microphone-and-plus button, top right, opens the Tell
    /// Omnesis capture; Cancel brings Tasks back unchanged. Leaves the screen
    /// before and after the tap in `/tmp/omnesis-snapshots` for review.
    func testTheBarsTellOmnesisButtonOpensCapture() {
        let button = app.buttons["tasks.tellOmnesis"]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "no Tell Omnesis button in the bar")
        XCTAssertEqual(button.label, "Tell Omnesis")
        let bar = app.navigationBars["Tasks"]
        XCTAssertTrue(bar.exists, "no Tasks bar")
        XCTAssertGreaterThan(button.frame.midX, bar.frame.midX, "the button is not on the bar's trailing side")
        keepScreenshot("326-tell-omnesis-button")

        button.tap()
        let cancel = app.buttons["Cancel capture"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), "Tell Omnesis did not open")
        XCTAssertTrue(app.staticTexts["Tell Omnesis"].exists, "the capture is not headed Tell Omnesis")
        XCTAssertTrue(app.buttons["captureDoneButton"].exists, "the capture has no Done button")
        keepScreenshot("326-tell-omnesis-capture")

        cancel.tap()
        XCTAssertTrue(wait { !self.app.buttons["Cancel capture"].exists }, "the capture stayed open")
        XCTAssertTrue(circle(complete: Fixture.marathon).waitForExistence(timeout: 5), "Tasks did not come back")
        XCTAssertTrue(chipLabel("Today").hasPrefix("Today (5)"), chipLabel("Today"))
    }

    // MARK: - Helpers

    /// The screen as it is now, in `/tmp/omnesis-snapshots`, for review.
    private func keepScreenshot(_ name: String) {
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? XCUIScreen.main.screenshot().pngRepresentation
            .write(to: directory.appendingPathComponent("\(name).png"))
    }

    /// Opens Suggested and lets its first layout settle: a press synthesized
    /// in the same instant the rows appear lands before the list has
    /// reported where its rows are, as no finger ever could.
    private func openSuggested() {
        open("Suggested")
        XCTAssertTrue(text(Fixture.suggestion).waitForExistence(timeout: 5), "the suggestions did not load")
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    }

    /// The Suggested chip's badge, read from its "Suggested, 7 waiting" label.
    private func suggestedCount() -> Int {
        let parts = chip("Suggested").label.components(separatedBy: ", ")
        guard parts.count > 1, let count = parts[1].split(separator: " ").first else { return 0 }
        return Int(count) ?? 0
    }

    private func chip(_ name: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
    }

    /// Taps a view's chip, sliding the chip bar along when it is off screen.
    private func open(_ name: String) {
        let target = chip(name)
        XCTAssertTrue(target.waitForExistence(timeout: 5), "no \(name) chip")
        for _ in 0 ..< 4 where !onScreen(target) {
            let y = chip("Today").exists ? chip("Today").frame.midY : target.frame.midY
            let leftwards = target.frame.midX > app.frame.midX
            drag(from: CGPoint(x: leftwards ? 330 : 60, y: y), to: CGPoint(x: leftwards ? 60 : 330, y: y))
        }
        XCTAssertTrue(onScreen(target), "the \(name) chip cannot be brought on screen")
        target.tap()
    }

    private func onScreen(_ element: XCUIElement) -> Bool {
        guard element.exists else { return false }
        let frame = element.frame
        return frame.minX >= app.frame.minX && frame.maxX <= app.frame.maxX
            && frame.minY >= app.frame.minY && frame.maxY <= app.frame.maxY
    }

    /// A quick drag that scrolls, too short a press to open a fan.
    private func drag(from start: CGPoint, to end: CGPoint) {
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: start.x, dy: start.y))
            .press(
                forDuration: 0.05,
                thenDragTo: origin.withOffset(CGVector(dx: end.x, dy: end.y)),
                withVelocity: .slow,
                thenHoldForDuration: 0.3
            )
        // Let any glide finish, so frames read next are where things stay.
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
    }

    /// Scrolls until `element` is on screen and can be tapped.
    private func reveal(_ element: XCUIElement) -> Bool {
        for _ in 0 ..< 5 where !(element.exists && element.isHittable) {
            app.swipeUp(velocity: .slow)
        }
        return element.exists && element.isHittable
    }

    /// Whether `element` is anywhere down the list: the list is lazy, so a
    /// row below the fold exists only once scrolled to. Scrolls back up.
    private func isListed(_ element: XCUIElement) -> Bool {
        if element.exists { return true }
        var swipes = 0
        while !element.exists, swipes < 4 {
            app.swipeUp(velocity: .fast)
            swipes += 1
        }
        let found = element.exists
        for _ in 0 ..< swipes + 1 {
            app.swipeDown(velocity: .fast)
        }
        return found
    }

    /// The chip's text as shown, "Today (5)" — its accessibility label
    /// reads "Today, 5 open", so the count is rebuilt from it.
    private func chipLabel(_ name: String) -> String {
        let label = chip(name).label
        let parts = label.components(separatedBy: ", ")
        guard parts.count > 1, let count = parts[1].split(separator: " ").first else { return name }
        return "\(name) (\(count))"
    }

    private func text(_ value: String) -> XCUIElement {
        app.staticTexts[value]
    }

    private func circle(complete title: String) -> XCUIElement {
        app.buttons["Complete \(title)"]
    }

    private func circle(reopen title: String) -> XCUIElement {
        app.buttons["Reopen \(title)"]
    }

    private func undo() {
        let button = app.buttons["Undo"]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "no Undo on the receipt")
        button.tap()
    }

    /// Where to press a row: on its title towards the right, as a right
    /// thumb would — checked to leave room above for `targets` targets.
    private func pressPoint(on title: String, needing targets: Int) throws -> CGPoint {
        // The circle is a plain button with a fixed label, so its frame is
        // the row's first line wherever the row is.
        let circle = circle(complete: title)
        let listTop = chip("Today").frame.maxY + 8
        let lowest = listTop + 8 + CGFloat(targets) * 50 + 8
        // Scroll the row to where a fan of `targets` fits above it and the
        // press is clear of the bottom edge.
        for _ in 0 ..< 12 {
            if circle.exists, onScreen(circle), circle.frame.midY >= lowest, circle.frame.midY <= app.frame.maxY - 120 {
                break
            }
            let below = !circle.exists || circle.frame.midY > app.frame.maxY - 120
            drag(
                from: CGPoint(x: 200, y: below ? 650 : 450),
                to: CGPoint(x: 200, y: below ? 550 : 550)
            )
        }
        XCTAssertTrue(circle.exists && onScreen(circle), "\(title) is not on screen")
        let point = CGPoint(x: min(app.frame.maxX - 90, 300), y: circle.frame.midY)
        guard point.y >= lowest, point.y <= app.frame.maxY - 120 else {
            throw XCTSkip("\(title) cannot be placed with room for \(targets) targets")
        }
        return point
    }

    /// The centre of target `index` of `count`, as `TaskFanSession` lays an
    /// upward column out at the default text size.
    private func target(from anchor: CGPoint, index: Int, of count: Int) -> CGPoint {
        let progress = count > 1 ? CGFloat(index) / CGFloat(count - 1) : 0
        let offset = 26 + 88 + 10 * sin(.pi * progress) + 24 * progress
        return CGPoint(x: anchor.x - offset, y: anchor.y - (CGFloat(index) + 0.5) * 50)
    }

    /// Long-press `title`, slide onto main-fan target `index` of `count`
    /// (a task's fan holds six, a suggestion's five) and lift.
    private func fan(on title: String, choose index: Int, of count: Int = 6) throws {
        let anchor = try pressPoint(on: title, needing: count)
        var touch = TouchPath(pressAt: anchor)
        touch.hold(0.7)
        touch.slide(to: target(from: anchor, index: index, of: count))
        touch.hold(0.2)
        try touch.perform()
    }

    private func wait(timeout: TimeInterval = 5, _ condition: @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return condition()
    }
}
