// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// The Morning brief conversation's interactions, driven on the simulator
/// against `DailyBriefDemoGateway` (`DEMO_MENU_REVEAL=briefs`), each judged by
/// what the screen shows afterwards: days folding and opening, the "Based on"
/// list, the Retry line, a source chip opening its document and a task chip
/// opening Tasks on that task.
///
/// The fixture holds three briefs — Monday 12, Tuesday 13 ("Yesterday") and
/// Wednesday 14 October ("Today") — and Monday's items fail on the first read.
final class DailyBriefInteractionUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["DEMO_MENU_REVEAL"] = "briefs"
        app.launch()
        XCTAssertTrue(footer(Fixture.today).waitForExistence(timeout: 20), "today's brief did not load")
    }

    override func tearDownWithError() throws {
        // What the screen showed when a check failed, for review.
        if let run = testRun, run.failureCount > 0 {
            let name = "337-" + name.replacingOccurrences(of: "[^A-Za-z]", with: "", options: .regularExpression)
            let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? XCUIScreen.main.screenshot().pngRepresentation
                .write(to: directory.appendingPathComponent("\(name).png"))
        }
        app = nil
    }

    private enum Fixture {
        static let today = "2026-10-14"
        static let yesterday = "2026-10-13"
        static let monday = "2026-10-12"
        static let loanSource = "doc_loan_offer"
        static let loanTitle = "Loan offer letter"
        static let boilerTask = "loop_brief_boiler"
        static let boilerTitle = "Book the boiler engineer"
        static let yesterdayReply = "Is there a cheaper option in the quote?"
        static let mondayReply = "What does the budget review need from me?"
    }

    // MARK: - 1. As it opens

    /// Today is open with what it was based on showing; earlier days are one
    /// line each, their replies out of the transcript.
    func testTodayOpensWithItsSourcesAndEarlierDaysFolded() {
        XCTAssertEqual(footer(Fixture.today).value as? String, "Expanded")
        XCTAssertEqual(footer(Fixture.today).label, "Based on 3 things")
        XCTAssertTrue(source(Fixture.loanSource).exists, "today's source chip is not shown")
        XCTAssertTrue(task(Fixture.boilerTask).exists, "today's task chip is not shown")
        XCTAssertTrue(app.staticTexts["Today"].exists || separator(Fixture.today).exists)
        XCTAssertTrue(folded(Fixture.yesterday).exists, "yesterday is not folded")
        XCTAssertTrue(folded(Fixture.monday).exists, "Monday is not folded")
        XCTAssertEqual(folded(Fixture.yesterday).label, "Morning brief · 2 replies")
        XCTAssertFalse(app.staticTexts[Fixture.yesterdayReply].exists, "a folded day still shows its replies")
        XCTAssertFalse(app.staticTexts[Fixture.mondayReply].exists, "a folded day still shows its replies")
    }

    /// The conversation opens at its newest content: today's list is on
    /// screen without scrolling, once its items have arrived.
    func testOpensAtTheLatestBrief() {
        XCTAssertTrue(source(Fixture.loanSource).waitForExistence(timeout: 5))
        XCTAssertTrue(wait { self.task(Fixture.boilerTask).isHittable }, "the transcript did not open at today's list")
        XCTAssertFalse(folded(Fixture.monday).isHittable, "the transcript opened at its start, not its latest brief")
    }

    func testComposerInvitesAReplyAboutToday() {
        let composer = app.textViews["agentComposer"].exists ? app.textViews["agentComposer"] : app.textFields["agentComposer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "no composer")
        XCTAssertEqual(composer.placeholderValue, "Reply about today's brief…")
    }

    // MARK: - 2. Folding and opening

    func testEarlierDayOpensAndFoldsAgain() {
        XCTAssertTrue(bringIntoView(folded(Fixture.yesterday)))
        folded(Fixture.yesterday).tap()
        let reply = app.staticTexts[Fixture.yesterdayReply]
        XCTAssertTrue(reply.waitForExistence(timeout: 5), "the opened day shows no replies")
        XCTAssertFalse(folded(Fixture.yesterday).exists, "the folded line stayed")
        XCTAssertTrue(wait { self.separator(Fixture.yesterday).isHittable }, "the opened day's separator scrolled out of sight")
        XCTAssertEqual(separator(Fixture.yesterday).value as? String, "Expanded")
        // An earlier day's list starts closed.
        XCTAssertTrue(footer(Fixture.yesterday).waitForExistence(timeout: 5), "the opened day has no Based on line")
        XCTAssertEqual(footer(Fixture.yesterday).value as? String, "Collapsed")
        XCTAssertFalse(source("doc_insurance_quote").exists)

        separator(Fixture.yesterday).tap()
        XCTAssertTrue(wait { self.folded(Fixture.yesterday).exists }, "the day did not fold")
        XCTAssertFalse(app.staticTexts[Fixture.yesterdayReply].exists, "the folded day still shows its replies")
        // Its items are known now, so the folded line counts them.
        XCTAssertEqual(folded(Fixture.yesterday).label, "Morning brief · 1 thing · 2 replies")
    }

    // MARK: - 3. The Based on list

    func testTodaysListFoldsAndOpens() {
        XCTAssertTrue(bringIntoView(footer(Fixture.today)))
        footer(Fixture.today).tap()
        XCTAssertTrue(wait { !self.source(Fixture.loanSource).exists }, "the list did not fold")
        XCTAssertEqual(footer(Fixture.today).value as? String, "Collapsed")
        footer(Fixture.today).tap()
        XCTAssertTrue(wait { self.source(Fixture.loanSource).exists }, "the list did not open")
        XCTAssertEqual(footer(Fixture.today).value as? String, "Expanded")
    }

    /// At the bottom, opening today's list keeps following the bottom: the
    /// last item's chip ends up on screen above the composer.
    func testOpeningTodaysListAtTheBottomKeepsItInView() {
        let last = source("doc_club_update")
        XCTAssertTrue(wait { last.isHittable }, "the conversation did not open at today's list")
        footer(Fixture.today).tap()
        XCTAssertTrue(wait { !last.exists }, "the list did not fold")
        footer(Fixture.today).tap()
        XCTAssertTrue(wait { last.exists && last.isHittable }, "the opened list grew below the screen")
        XCTAssertLessThan(last.frame.maxY, app.frame.maxY - 80, "the last item sits under the composer")
    }

    func testOpenedEarlierDaysListShowsItsItems() {
        XCTAssertTrue(bringIntoView(folded(Fixture.yesterday)))
        folded(Fixture.yesterday).tap()
        XCTAssertTrue(footer(Fixture.yesterday).waitForExistence(timeout: 5))
        XCTAssertTrue(bringIntoView(footer(Fixture.yesterday)))
        footer(Fixture.yesterday).tap()
        XCTAssertTrue(wait { self.source("doc_insurance_quote").exists }, "yesterday's list did not open")
        XCTAssertTrue(task("loop_brief_insurance").exists)
    }

    // MARK: - 4. Chips

    func testSourceChipOpensTheDocument() {
        XCTAssertTrue(bringIntoView(source(Fixture.loanSource)))
        source(Fixture.loanSource).tap()
        XCTAssertTrue(app.navigationBars[Fixture.loanTitle].waitForExistence(timeout: 5), "the document did not open")
        app.navigationBars[Fixture.loanTitle].buttons.firstMatch.tap()
        XCTAssertTrue(wait { self.footer(Fixture.today).exists }, "Back did not return to the brief")
    }

    func testTaskChipOpensTasksOnThatTask() {
        XCTAssertTrue(bringIntoView(task(Fixture.boilerTask)))
        task(Fixture.boilerTask).tap()
        XCTAssertTrue(app.navigationBars["Task"].waitForExistence(timeout: 8), "the task's details did not open")
        let title = app.textViews.matching(NSPredicate(format: "value == %@", Fixture.boilerTitle)).firstMatch
        let field = title.exists ? title : app.textFields.matching(NSPredicate(format: "value == %@", Fixture.boilerTitle)).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3), "the details show another task")
        XCTAssertTrue(app.navigationBars["Tasks"].exists || app.staticTexts["Tasks"].exists, "not in Tasks")
    }

    // MARK: - 5. A failed read

    func testFailedItemsOfferRetryAndRetryRecovers() {
        XCTAssertTrue(bringIntoView(folded(Fixture.monday)))
        folded(Fixture.monday).tap()
        let retry = app.buttons["dailyBrief.retry.\(Fixture.monday)"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5), "no Retry after the failed read")
        XCTAssertTrue(app.staticTexts[Fixture.mondayReply].exists, "the failure broke the transcript")
        XCTAssertTrue(bringIntoView(retry))
        retry.tap()
        XCTAssertTrue(footer(Fixture.monday).waitForExistence(timeout: 5), "Retry did not load the items")
        XCTAssertEqual(footer(Fixture.monday).label, "Based on 2 things")
        XCTAssertFalse(retry.exists)
    }

    // MARK: - 6. Scrolling

    /// After a day opens and folds, the transcript still scrolls both ways.
    func testScrollingAfterOpeningAndFolding() {
        XCTAssertTrue(bringIntoView(folded(Fixture.yesterday)))
        folded(Fixture.yesterday).tap()
        XCTAssertTrue(app.staticTexts[Fixture.yesterdayReply].waitForExistence(timeout: 5))
        separator(Fixture.yesterday).tap()
        XCTAssertTrue(wait { self.folded(Fixture.yesterday).exists })

        let marker = folded(Fixture.monday)
        let before = marker.frame.minY
        app.swipeUp(velocity: .slow)
        XCTAssertTrue(wait { abs(marker.frame.minY - before) > 40 }, "the transcript did not scroll up")
        let afterUp = marker.frame.minY
        app.swipeDown(velocity: .slow)
        XCTAssertTrue(wait { marker.frame.minY > afterUp + 40 }, "the transcript did not scroll back down")
        XCTAssertTrue(bringIntoView(footer(Fixture.today)), "today's list cannot be reached")
        XCTAssertTrue(bringIntoView(folded(Fixture.monday)), "the first day cannot be reached")
    }

    // MARK: - Helpers

    private func footer(_ day: String) -> XCUIElement {
        app.buttons["dailyBrief.footer.\(day)"]
    }

    private func folded(_ day: String) -> XCUIElement {
        app.buttons["dailyBrief.folded.\(day)"]
    }

    private func separator(_ day: String) -> XCUIElement {
        app.descendants(matching: .any)["dailyBrief.separator.\(day)"]
    }

    private func source(_ id: String) -> XCUIElement {
        app.buttons["dailyBrief.source.\(id)"]
    }

    private func task(_ id: String) -> XCUIElement {
        app.buttons["dailyBrief.task.\(id)"]
    }

    /// Scrolls until `element` sits in the open middle of the screen — clear
    /// of the floating top buttons and of the composer — so a tap lands on it.
    private func bringIntoView(_ element: XCUIElement) -> Bool {
        guard element.waitForExistence(timeout: 5) else { return false }
        let top = app.frame.minY + 140
        let bottom = app.frame.maxY - 220
        for _ in 0 ..< 10 {
            let mid = element.frame.midY
            if mid >= top, mid <= bottom, element.isHittable { return true }
            if mid < top {
                app.swipeDown(velocity: .slow)
            } else {
                app.swipeUp(velocity: .slow)
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }
        return element.isHittable
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
