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

    func testOnlyDrawerOwnsTheInAppCaptureAction() throws {
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
        let offenders = try files
            .filter { $0.pathExtension == "swift" }
            .filter { try source(at: $0).contains("mic.badge.plus") }
            .map(\.lastPathComponent)

        XCTAssertEqual(offenders, [], "A legacy capture toolbar button remains")

        let captureKey = uiRoot.appendingPathComponent("Capture/CaptureView.swift")
        // Home installs the action the drawer calls; it draws no entry point of its own.
        let home = uiRoot.appendingPathComponent("HomeView.swift")
        // Tasks are added by telling Omnesis, so the Tasks page's closing line
        // links to the same capture. That line is its only use.
        let tasks = uiRoot.appendingPathComponent("Tasks/TaskJournalBanners.swift")
        let tasksSource = try source(at: tasks)
        XCTAssertTrue(tasksSource.contains("struct TaskCaptureHint"))
        XCTAssertEqual(
            tasksSource.components(separatedBy: "openCapture?()").count - 1,
            2,
            "The Tasks hint opens capture from its link and its accessibility action, nowhere else"
        )
        let allowed = Set([drawer, captureKey, home, tasks].map(\.standardizedFileURL))
        let actionOffenders = try files
            .filter { $0.pathExtension == "swift" && !allowed.contains($0.standardizedFileURL) }
            .filter { try source(at: $0).contains("openCapture") }
            .map(\.lastPathComponent)

        XCTAssertEqual(actionOffenders, [], "In-app capture action escaped the drawer")
    }

    func testExternalCaptureSurfaceIsControlOnly() throws {
        let widgetSource = try source(
            at: iosRoot.appendingPathComponent("Sources/OmnesisWidgets/OmnesisWidgets.swift")
        )
        XCTAssertTrue(widgetSource.contains("TellBrainControl"))
        XCTAssertFalse(widgetSource.contains("TellBrainWidget"))
        XCTAssertTrue(widgetSource.contains("Tell Omnesis"))

        let intentsSource = try source(
            at: iosRoot.appendingPathComponent("Sources/Omnesis/Intents/OmnesisAppIntents.swift")
        )
        XCTAssertTrue(intentsSource.contains("CaptureNoteIntent"))
        XCTAssertFalse(intentsSource.contains("OpenCaptureIntent"))

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
