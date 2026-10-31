// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import XCTest

/// Drives the real capture/history views over NotesHistoryDemoSession. Assertions
/// describe visible state after each action, including retained drafts and mutations.
final class NotesInteractionUITests: XCTestCase {
    private var app: XCUIApplication!
    private let draft = "Keep the draft while reviewing earlier notes."
    private let original = "Remind me to reserve a room for the design workshop next week."
    private let reply = "I added a task to reserve the workshop room."
    private let suffix = " Add a projector to the reservation."

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchEnvironment["DEMO_MENU_REVEAL"] = "notes"
        app.launchEnvironment["DEMO_DISABLE_ANIMATIONS"] = "1"
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
    }

    func testOpeningNotesPausesCaptureAndKeepsItsDraft() throws {
        XCTAssertTrue(app.buttons["Stop listening"].waitForExistence(timeout: 15))
        XCTAssertEqual(captureDraft.value as? String, draft)
        openNotes()
        XCTAssertTrue(app.staticTexts[original].waitForExistence(timeout: 10))
        app.buttons["Back to capture"].tap()
        XCTAssertTrue(app.buttons["Start listening"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Stop listening"].exists)
        XCTAssertEqual(captureDraft.value as? String, draft)
        XCTAssertTrue(captureDraft.isEnabled)
        try captureEvidence("notes-interaction-draft-paused")
    }

    func testReplyEditUndoAndConfirmedDeletionStayInSync() throws {
        openNotes()
        let note = app.staticTexts[original]
        XCTAssertTrue(note.waitForExistence(timeout: 10))
        note.tap()
        XCTAssertTrue(app.navigationBars["Note"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts[reply].exists)

        app.buttons["Edit"].tap()
        let editor = app.textViews["notes.editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        // A tap below the short fixture's text places the caret at its end.
        editor.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.9)).tap()
        editor.typeText(suffix)
        let save = app.buttons["Save changes"]
        reveal(save)
        save.tap()
        let edited = app.staticTexts[original + suffix]
        XCTAssertTrue(edited.waitForExistence(timeout: 5), "saved text did not replace the editor")
        XCTAssertTrue(app.staticTexts[reply].exists, "editing lost the historical response")

        let undo = app.buttons["Undo change"]
        reveal(undo)
        undo.tap()
        XCTAssertTrue(app.buttons["Undone"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Undone"].isEnabled)

        let remove = app.buttons["Delete note"]
        reveal(remove)
        remove.tap()
        XCTAssertTrue(app.sheets.firstMatch.waitForExistence(timeout: 5))
        try captureEvidence("notes-delete-confirmation")
        // A confirmation dialog can present without an explicit Cancel button;
        // tapping its outside area dismisses it without deleting anything.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.1)).tap()
        XCTAssertTrue(remove.isHittable, "cancelling deletion did not close its confirmation")
        XCTAssertTrue(edited.exists, "cancelling deletion removed the note")
        reveal(remove)
        remove.tap()
        app.sheets.buttons["Delete note"].tap()
        XCTAssertTrue(app.navigationBars["Notes"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts[original + suffix].exists, "deleted note remained in history")
        XCTAssertTrue(app.staticTexts["The workshop agenda should leave space for questions."].exists, "unrelated history disappeared")
        app.buttons["Back to capture"].tap()
        XCTAssertEqual(captureDraft.value as? String, draft)
        XCTAssertTrue(app.buttons["Start listening"].exists)
        try captureEvidence("notes-interaction-mutations-complete")
    }

    private var captureDraft: XCUIElement {
        app.textFields["captureTranscript"].exists ? app.textFields["captureTranscript"] : app.textViews["captureTranscript"]
    }

    private func openNotes() {
        let button = app.buttons["Previous notes"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        button.tap()
        XCTAssertTrue(app.navigationBars["Notes"].waitForExistence(timeout: 5))
    }

    private func reveal(_ element: XCUIElement) {
        for _ in 0 ..< 6 {
            if element.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "control could not be reached by scrolling")
    }

    private func captureEvidence(_ name: String) throws {
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try app.screenshot().pngRepresentation.write(to: directory.appendingPathComponent(name + ".png"))
    }
}
