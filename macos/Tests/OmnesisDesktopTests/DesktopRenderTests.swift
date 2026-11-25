// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopRenderTests: XCTestCase {
    func testWelcome() throws {
        try render(DesktopRootView().environment(DesktopStore.preview()), name: "welcome")
    }

    func testHomeChoice() throws {
        try render(DesktopRootView().environment(DesktopStore.preview(phase: .chooseHome)), name: "choose-home")
    }

    func testWaiting() throws {
        try render(DesktopRootView().environment(DesktopStore.preview(phase: .waiting)), name: "waiting")
    }

    func testPreparing() throws {
        try render(DesktopRootView().environment(DesktopStore.preview(phase: .preparing)), name: "preparing")
    }

    func testAccountRequired() throws {
        try render(
            DesktopRootView().environment(DesktopStore.preview(phase: .accountRequired)),
            name: "account-required"
        )
    }

    func testEmptySources() throws {
        try render(DesktopSourcesView().environment(DesktopStore.preview()), name: "sources-empty")
    }

    func testAskEmpty() throws {
        try render(DesktopAskView().environment(DesktopStore.preview()), name: "ask-empty")
    }

    func testSearchEmpty() throws {
        try render(DesktopSearchView().environment(DesktopStore.preview()), name: "search-empty")
    }

    func testDevicesEmpty() throws {
        try render(DesktopDevicesView().environment(DesktopStore.preview()), name: "devices-empty")
    }

    private func render(_ view: some View, name: String) throws {
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let hosting = NSHostingView(rootView: view)
            hosting.frame = NSRect(x: 0, y: 0, width: 1080, height: 740)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: appearance)
            window.contentView = hosting
            hosting.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return XCTFail("No image was rendered") }
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            XCTAssertGreaterThan(png.count, 1000, "The snapshot must contain a rendered view")
            try png.write(to: output.appendingPathComponent("\(name)-\(appearance.rawValue).png"))
            window.close()
        }
    }
}
