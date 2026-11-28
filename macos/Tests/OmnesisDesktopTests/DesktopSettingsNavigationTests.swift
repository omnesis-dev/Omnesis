// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopSettingsNavigationTests: XCTestCase {
    func testSetupModelButtonChoosesNativeAISettingsBeforePresentingSettings() async throws {
        let store = DesktopStore(startRuntime: false)
        store.settingsTab = "general"
        var presented = false
        let hosting = NSHostingView(rootView: DesktopSetupChecklist(presentSettings: {
            XCTAssertEqual(store.settingsTab, "ai", "Select the native model page before opening Settings")
            presented = true
        }).environment(store))
        hosting.frame = NSRect(x: 0, y: 0, width: 720, height: 620)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(200))
        hosting.layoutSubtreeIfNeeded()
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try DesktopAccessibilityDriver.press("setup-models", in: hosting)
        XCTAssertTrue(presented, "The actual Setup action must present native Settings")
        XCTAssertEqual(store.settingsTab, "ai")
        XCTAssertNil(store.failure, "Choosing a model must not attempt a runtime portal command")
    }
}
