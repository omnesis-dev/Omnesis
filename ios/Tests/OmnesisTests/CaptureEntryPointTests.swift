// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import XCTest

/// Source-level guard for the intentionally narrow quick-capture UI.
/// SwiftUI does not expose a stable public view-tree inspection API, so
/// this test protects the concrete presentation boundaries instead.
final class CaptureEntryPointTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    func testOnlyDrawerTasksAndNotesHistoryOwnTheInAppCaptureAction() throws {
        let uiRoot = iosRoot.appendingPathComponent("Sources/Omnesis/UI")
        let drawer = uiRoot.appendingPathComponent("MainMenuDrawer.swift")
        let drawerSource = try source(at: drawer)

        XCTAssertEqual(drawerSource.components(separatedBy: "openCapture?()").count - 1, 1)
        XCTAssertTrue(drawerSource.contains("Tell Omnesis"))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: uiRoot.appendingPathComponent("Capture/CaptureToolbarButton.swift").path
            )
        )

        let files = try XCTUnwrap(
            FileManager.default.enumerator(
                at: uiRoot,
                includingPropertiesForKeys: nil
            )?.allObjects as? [URL]
        )
        // The Tasks bar owns the task-capture glyph: tasks are added by
        // telling Omnesis. Notes history uses the ordinary microphone.
        let tasks = uiRoot.appendingPathComponent("Tasks/TasksView.swift")
        let offenders = try files
            .filter { $0.pathExtension == "swift" && $0.standardizedFileURL != tasks.standardizedFileURL }
            .filter { try source(at: $0).contains("mic.badge.plus") }
            .map(\.lastPathComponent)

        XCTAssertEqual(offenders, [], "A capture toolbar button outside Tasks")

        let captureKey = uiRoot.appendingPathComponent("Capture/CaptureView.swift")
        // Home installs the action the drawer calls; it draws no entry point of its own.
        let home = uiRoot.appendingPathComponent("HomeView.swift")
        // The Tasks bar's Tell Omnesis button opens the same capture, once.
        let tasksSource = try source(at: tasks)
        XCTAssertTrue(tasksSource.contains("struct TellOmnesisToolbarButton"))
        XCTAssertEqual(
            tasksSource.components(separatedBy: "openCapture?()").count - 1,
            1,
            "The Tasks bar's button is the only place Tasks opens capture"
        )
        // The Tasks UI-test harness (DEBUG only) installs the action the way Home does.
        let tasksHarness = uiRoot.appendingPathComponent("Tasks/TasksFanDemoSurface.swift")
        // Browsing existing notes keeps a direct path back to immediate capture.
        let notesHistory = uiRoot.appendingPathComponent("Capture/NotesHistoryView.swift")
        let notesHistorySource = try source(at: notesHistory)
        XCTAssertEqual(
            notesHistorySource.components(separatedBy: "openCapture?()").count - 1,
            1,
            "Notes history owns one Tell Omnesis action"
        )
        let notesHarness = uiRoot.appendingPathComponent("Capture/NotesHistoryDemoSurface.swift")
        XCTAssertTrue(try source(at: notesHarness).contains("#if DEBUG && canImport(SwiftUI) && canImport(UIKit)"))
        let allowed = Set([drawer, captureKey, home, tasks, tasksHarness, notesHistory, notesHarness].map(\.standardizedFileURL))
        let actionOffenders = try files
            .filter { $0.pathExtension == "swift" && !allowed.contains($0.standardizedFileURL) }
            .filter { try source(at: $0).contains("openCapture") }
            .map(\.lastPathComponent)

        XCTAssertEqual(actionOffenders, [], "In-app capture action escaped the drawer, Tasks, and Notes history")
    }

    func testExternalVoiceEntryUsesControlAndShortcut() throws {
        let widgetSource = try source(
            at: iosRoot.appendingPathComponent("Sources/OmnesisWidgets/OmnesisWidgets.swift")
        )
        XCTAssertTrue(widgetSource.contains("TellBrainControl"))
        XCTAssertFalse(widgetSource.contains("TellBrainWidget"))
        XCTAssertTrue(widgetSource.contains("Label(\"Omnesis\", image: \"omnesis.mark\")"))

        let intentsSource = try source(
            at: iosRoot.appendingPathComponent("Sources/Omnesis/Intents/OmnesisAppIntents.swift")
        )
        XCTAssertTrue(intentsSource.contains("CaptureNoteIntent"))
        XCTAssertTrue(intentsSource.contains("intent: SpeakToOmnesisIntent()"))

        for name in ["Info.plist", "Info-Demo.plist"] {
            XCTAssertFalse(
                try source(at: iosRoot.appendingPathComponent(name))
                    .contains("UIApplicationShortcutItems")
            )
        }

        let homeSource = try source(
            at: iosRoot.appendingPathComponent("Sources/Omnesis/UI/HomeView.swift")
        )
        XCTAssertTrue(homeSource.contains("?? .control"))
        XCTAssertFalse(homeSource.contains("?? .widget"))
    }

    private func source(at url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
    }
}
