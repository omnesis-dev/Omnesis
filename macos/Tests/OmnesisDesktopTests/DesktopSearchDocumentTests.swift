// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopSearchDocumentTests: XCTestCase {
    func testSearchResultWithoutOriginalLinkOpensTheCompleteIndexedDocument() async throws {
        let fixture = try await ScriptedAgentFixture.start()
        defer { fixture.stop() }
        let connection = try JSONDecoder().decode(DesktopConnection.self, from: JSONSerialization.data(withJSONObject: [
            "url": fixture.url.absoluteString, "token": "gui-fixture-token",
        ]))
        let store = DesktopStore(startRuntime: false)
        store.api = try DesktopAPI(connection: connection)
        let hosting = NSHostingView(rootView: DesktopSearchView(context: store.apiContext).environment(store).omnesisTheme())
        hosting.sizingOptions = []
        hosting.autoresizingMask = [.width, .height]
        hosting.frame = NSRect(x: 0, y: 0, width: 860, height: 600)
        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.setContentSize(CGSize(width: 860, height: 600))
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        func wait(_ condition: () throws -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(5)
            while ContinuousClock.now < deadline {
                if try condition() { return }
                try await Task.sleep(for: .milliseconds(25))
            }
            throw URLError(.timedOut)
        }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try await wait { (try? DesktopAccessibilityDriver.element("library-search-input", in: hosting)) != nil }
        try DesktopAccessibilityDriver.type("Fictional outline", into: "library-search-input", in: hosting)
        try await wait { try DesktopAccessibilityDriver.element("library-search-submit", in: hosting).isAccessibilityEnabled() }
        try DesktopAccessibilityDriver.press("library-search-submit", in: hosting)
        try await wait { (try? DesktopAccessibilityDriver.element("search-document-fictional-document", in: hosting)) != nil }
        XCTAssertFalse(try DesktopAccessibilityDriver.contains("Open original", in: hosting), "The result deliberately has no original URL")
        try DesktopAccessibilityDriver.press("search-document-fictional-document", in: hosting)
        try await wait { try DesktopAccessibilityDriver.contains("Original project note", in: hosting) }
        let status = try await fixture.status()
        XCTAssertEqual(status.documentReads, 1)
        XCTAssertEqual(status.unauthorized, 0)
        let documentWindow = try XCTUnwrap(window.attachedSheet, "The full document must open in the actual native sheet")
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots")
        try await DesktopSnapshotRenderer.captureOwnedWindow(
            documentWindow,
            output: output,
            name: "search-full-indexed-document",
            appearance: .darkAqua
        )
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: output.appendingPathComponent(
            "search-full-indexed-document-window-NSAppearanceNameDarkAqua.png"
        ))))
        guard bitmap.bitsPerSample == 8, bitmap.samplesPerPixel == 4 else {
            XCTFail("The own-window capture must use the expected 8-bit RGBA representation")
            return
        }
        var channels = [Int](repeating: 0, count: bitmap.samplesPerPixel)
        bitmap.getPixel(&channels, atX: bitmap.pixelsWide - 40, y: bitmap.pixelsHigh - 40)
        let rgb = bitmap.bitmapFormat.contains(.alphaFirst) ? Array(channels.dropFirst()) : Array(channels.prefix(3))
        let expected = try XCTUnwrap(NSColor(DesktopTheme.canvas).usingColorSpace(.sRGB))
        XCTAssertEqual(Double(rgb[0]) / 255, expected.redComponent, accuracy: 0.01)
        XCTAssertEqual(Double(rgb[1]) / 255, expected.greenComponent, accuracy: 0.01)
        XCTAssertEqual(
            Double(rgb[2]) / 255,
            expected.blueComponent,
            accuracy: 0.01,
            "The real presentation must use the shared opaque canvas, not inherited window material"
        )
        try DesktopAccessibilityDriver.press("chat-document-done", in: hosting)
    }
}
