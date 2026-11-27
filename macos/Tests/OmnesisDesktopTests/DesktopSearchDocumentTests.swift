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
        let suite = "dev.omnesis.document-render-tests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let hosting = NSHostingView(rootView: DesktopSearchView(context: store.apiContext).environment(store).omnesisTheme()
            .defaultAppStorage(defaults).environment(\.desktopAppearanceOverride, .dark))
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
        try DesktopNativeColorReference.validateLogicalCanvas(NSColor(DesktopTheme.canvas), appearance: documentWindow.effectiveAppearance)
        let reference = try await DesktopNativeColorReference.capture(for: documentWindow, output: output)
        let appearance = try XCTUnwrap(documentWindow.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]))
        XCTAssertEqual(appearance, .darkAqua, "The isolated document fixture explicitly selects Dark appearance")
        try await DesktopSnapshotRenderer.captureOwnedWindow(
            documentWindow,
            output: output,
            name: "search-full-indexed-document",
            appearance: appearance,
            requireActive: true
        )
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: output.appendingPathComponent(
            "search-full-indexed-document-window-\(appearance.rawValue).png"
        ))))
        try DesktopNativeColorReference.validatePipeline(bitmap, window: documentWindow, reference: reference)
        let background = try DesktopNativeColorReference.pixel(bitmap, x: bitmap.pixelsWide - 40, y: bitmap.pixelsHigh - 40)
        let content = try XCTUnwrap(documentWindow.contentView)
        let elements = try DesktopAccessibilityDriver.elements(in: content)
        @MainActor func textElement(_ text: String) throws -> DesktopAccessibilityDriver.Element {
            try XCTUnwrap(elements.filter {
                $0.accessibilityLabel() == text || $0.accessibilityTextValue() == text
            }.filter { $0.accessibilityFrame().width > 0 && $0.accessibilityFrame().height > 0 }.min {
                $0.accessibilityFrame().width * $0.accessibilityFrame().height < $1.accessibilityFrame().width * $1.accessibilityFrame()
                    .height
            })
        }
        let title = try textElement("Fictional project outline")
        let paragraph = "This is the full indexed document, read through the authenticated library connection. The planning session will confirm the schedule and the first draft owner."
        let bodyText = try textElement(paragraph)
        let body = try DesktopAccessibilityDriver.element("chat-document-content", in: content)
        let done = try DesktopAccessibilityDriver.element("chat-document-done", in: content)
        XCTAssertTrue(done.isAccessibilityEnabled())
        XCTAssertTrue(try DesktopAccessibilityDriver.contains(paragraph, in: content))
        XCTAssertTrue(
            body.accessibilityFrame().contains(bodyText.accessibilityFrame()),
            "The actual paragraph must remain inside the document viewport"
        )
        let screen = try XCTUnwrap(documentWindow.screen)
        let frames = [title.accessibilityFrame(), bodyText.accessibilityFrame(), done.accessibilityFrame(), body.accessibilityFrame()]
        func rectangle(_ rect: NSRect) -> [String: CGFloat] {
            ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
        }
        let receiptPath = output.appendingPathComponent("search-full-indexed-document-color-comparison.json")
        var receipt: [String: Any] = [
            "format": 1, "comparison": "same-invocation-native-brush-not-absolute-display-calibration",
            "backgroundRGBA": background.channels, "referenceRGBA": reference.canvas.channels,
            "referenceInkRGBA": reference.ink.channels, "semanticFramesInScreen": frames.map(rectangle),
            "effectiveAppearance": documentWindow.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua])?.rawValue ?? "unknown",
            "windowFrame": rectangle(documentWindow.frame), "screenVisibleFrame": rectangle(screen.visibleFrame),
        ]
        try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]).write(to: receiptPath, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receiptPath.path)
        let mapped = try frames.map { frame -> NSRect in
            guard frame.width > 0, frame.height > 0, documentWindow.frame.contains(frame), screen.visibleFrame.contains(frame) else {
                throw DesktopNativeColorReference.Failure.mapping
            }
            return try DesktopNativeColorReference.mappedRect(
                documentWindow.convertFromScreen(frame),
                bitmap: bitmap,
                extent: documentWindow.frame.size
            )
        }
        receipt["semanticPixelRects"] = mapped.map(rectangle)
        try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]).write(to: receiptPath, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receiptPath.path)
        XCTAssertEqual(background.channels[3], 1, accuracy: 0.01)
        XCTAssertTrue(
            background.matches(reference.canvas),
            "The real sheet must match an independent opaque native canvas through the same capture pipeline"
        )
        // AX copy alone cannot certify that the captured title/body actually painted.
        try DesktopNativeColorReference.requireInk(bitmap, rect: mapped[0], ink: reference.ink)
        try DesktopNativeColorReference.requireInk(bitmap, rect: mapped[1], ink: reference.ink)
        try DesktopAccessibilityDriver.press("chat-document-done", in: hosting)
        try await wait { window.attachedSheet == nil }
    }
}
