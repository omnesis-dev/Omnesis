// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class NearbyConnectionTests: XCTestCase {
    func testDeniedAccessGuidanceRechecksAndDoesNotClaimOfflineRelayIsAvailable() async throws {
        var rechecks = 0
        var settings = 0
        let view = Form {
            DesktopNearbyConnectionView(status: .denied, connected: false, busy: false, retry: { rechecks += 1 }, navigate: {
                settings += 1
                return .unavailable
            })
        }.formStyle(.grouped)
        let hosting = NSHostingView(rootView: view.frame(width: 640, height: 400))
        hosting.frame = NSRect(x: 0, y: 0, width: 640, height: 400)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        defer { window.close() }
        window.makeKeyAndOrderFront(nil)
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        hosting.layoutSubtreeIfNeeded()
        XCTAssertTrue(try DesktopAccessibilityDriver.contains("Local network access needs attention", in: hosting))
        XCTAssertFalse(try DesktopAccessibilityDriver.contains("Your secure library connection is available.", in: hosting))
        try DesktopAccessibilityDriver.press("nearby-recheck", in: hosting)
        try DesktopAccessibilityDriver.press("nearby-privacy-settings", in: hosting)
        XCTAssertEqual(rechecks, 1)
        XCTAssertEqual(settings, 1)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(try DesktopAccessibilityDriver.contains("Open System Settings", in: hosting))
    }

    func testEveryNearbyStateHasBrandedReadableGuidanceWithoutEndpointDetails() async throws {
        for status in [DesktopNearbyGatewayHints.State.finding, .ready, .denied, .unavailable] {
            try await DesktopSnapshotRenderer.render(
                Form { DesktopNearbyConnectionView(status: status, connected: true, busy: false, retry: {}) }.formStyle(.grouped),
                name: "nearby-connection-\(status.rawValue)", size: CGSize(width: 640, height: 400),
                validate: { hosting in
                    XCTAssertTrue(try DesktopAccessibilityDriver.contains("Your secure library connection is available.", in: hosting))
                    XCTAssertTrue(try DesktopAccessibilityDriver.element("nearby-recheck", in: hosting).isAccessibilityEnabled())
                }
            )
        }
    }

    func testBeforeConnectionExplainsWhyMacOSMayAskForNetworkAccess() async throws {
        try await DesktopSnapshotRenderer.render(
            DesktopRootView().environment(DesktopStore.preview()),
            name: "nearby-before-connection", size: CGSize(width: 1080, height: 740),
            validate: { hosting in
                XCTAssertTrue(try DesktopAccessibilityDriver.contains("macOS may ask for Local Network access", in: hosting))
                XCTAssertTrue(try DesktopAccessibilityDriver.element("find-library", in: hosting).isAccessibilityEnabled())
            }
        )
    }
}
