// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

/// Uses the actual document view and shared sheet presentation, not Search navigation.
@MainActor
private struct DocumentReaderSheetFixture: View {
    let store: DesktopStore
    let context: DesktopAPIContext
    let selection: DesktopDocumentSelection
    @State private var presented = true
    var body: some View {
        Text("Fictional document library")
            .omnesisSheet(isPresented: $presented) {
                DesktopDocumentView(selection: selection, context: context).environment(store)
            }
    }
}

@MainActor
final class DocumentReaderLayoutTests: XCTestCase {
    private func wait(_ condition: @MainActor () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline {
            let ready = try await condition()
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            if ready { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw URLError(.timedOut)
    }

    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { descendants($0) }
    }

    /// Uses the full owned AX text as authority and public character-range geometry, never a drawn surrogate.
    private func finalTitleLineFrame(_ element: DesktopAccessibilityDriver.Element, expected: String, pixel: CGFloat) throws -> NSRect {
        XCTAssertEqual(element.accessibilityTextValue() ?? element.accessibilityLabel(), expected)
        let lastLine = try XCTUnwrap(expected.components(separatedBy: "\n").last)
        XCTAssertFalse(lastLine.isEmpty)
        let range = NSRange(location: expected.utf16.count - lastLine.utf16.count, length: lastLine.utf16.count)
        let frame = try XCTUnwrap(
            element.object.accessibilityFrame?(for: range),
            "The actual title must expose public last-line text-range geometry"
        )
        XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
        XCTAssertGreaterThan(frame.width, 0)
        XCTAssertGreaterThan(frame.height, 0)
        XCTAssertTrue(element.accessibilityFrame().insetBy(dx: -pixel, dy: -pixel).contains(frame))
        return frame
    }

    private func control(_ url: URL, _ path: String, session: URLSession, body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: url.appendingPathComponent(path))
        request.timeoutInterval = 3
        request.setValue("Bearer gui-fixture-token", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testDocumentReaderKeepsCompleteTitlesAndBodyScrollableWithPinnedDismissal() async throws {
        var completed = 0
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for width in [CGFloat(860), CGFloat(720)] {
                var compactHeight: CGFloat?
                for scenario in ["normal", "long", "error", "loading"] {
                    let height = try await exercise(scenario, appearance: appearance, parentWidth: width)
                    if scenario == "normal" { compactHeight = height }
                    else { XCTAssertGreaterThan(height, try XCTUnwrap(compactHeight)) }
                    completed += 1
                }
            }
        }
        XCTAssertEqual(completed, 16)
    }

    private func exercise(_ scenario: String, appearance: NSAppearance.Name, parentWidth: CGFloat) async throws -> CGFloat {
        let fixture = try await ScriptedAgentFixture.start(scriptName: "api-context-fixture.mjs")
        defer { fixture.stop() }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let id = "fictional-reader-document"
        let long = scenario != "normal"
        let chosenTitle = long ? (0 ..< 80).map { "Fictional pending title line \($0)" }.joined(separator: "\n") : "Selected fictional document"
        let loadedTitle = scenario == "long" ? (0 ..< 80).map { "Fictional indexed title line \($0)" }.joined(separator: "\n") : "Fictional indexed document"
        let finalParagraph = "Fictional final paragraph. The complete indexed document ends here."
        let body = scenario == "long" ? String(
            repeating: "A fictional planning note retains its complete wording and reading order. This paragraph has no external actions.\n\n",
            count: 30
        ) + finalParagraph : finalParagraph
        let response: [String: Any] = [
            "id": id, "provider_id": "example", "source_id": "example:notes", "external_id": "fictional-note",
            "title": loadedTitle, "content": body, "content_hash": "fictional-content-hash", "metadata": [String: String](),
            "source_created_at": "2026-01-01T12:00:00Z",
        ]
        let route: [String: Any] = ["status": scenario == "error" ? 500 : 200, "hold": scenario == "loading", "body": response]
        let routes: [String: Any] = ["GET /documents/" + id: route]
        _ = try await control(fixture.url, "fixture-config", session: session, body: ["routes": routes])
        let connection = try JSONDecoder().decode(DesktopConnection.self, from: JSONSerialization.data(withJSONObject: [
            "url": fixture.url.absoluteString, "token": "gui-fixture-token",
        ]))
        let context = try DesktopAPIContext(api: DesktopAPI(connection: connection), id: 1)
        let bridge = RuntimeBridge()
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
        let selection = DesktopDocumentSelection(id: id, title: chosenTitle, originalURL: URL(string: "https://original.example.com/note"))
        let suite = "dev.omnesis.document-layout." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let hosting = NSHostingView(rootView: DocumentReaderSheetFixture(store: store, context: context, selection: selection)
            .frame(width: parentWidth, height: 600).omnesisTheme()
            .defaultAppStorage(defaults).environment(\.desktopAppearanceOverride, appearance == .aqua ? .light : .dark))
        hosting.sizingOptions = []
        hosting.autoresizingMask = [.width, .height]
        hosting.frame = NSRect(x: 0, y: 0, width: parentWidth, height: 600)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.setContentSize(NSSize(width: parentWidth, height: 600))
        window.center()
        window.makeKeyAndOrderFront(nil)
        do {
            try await DesktopAccessibilityDriver.materializeOwnedApplication()
            try await wait { window.attachedSheet != nil }
            let sheet = try XCTUnwrap(window.attachedSheet)
            XCTAssertTrue(sheet.sheetParent === window)
            let content = try XCTUnwrap(sheet.contentView)
            try await wait {
                let status = try await self.control(fixture.url, "fixture-context-status", session: session)
                let requests = try XCTUnwrap(status["requests"] as? [[String: Any]])
                guard requests.contains(where: { $0["path"] as? String == "/documents/" + id }) else { return false }
                switch scenario {
                case "loading": return (try? DesktopAccessibilityDriver.element("chat-document-loading", in: content)) != nil
                case "error": return (try? DesktopAccessibilityDriver.element("chat-document-error", in: content)) != nil
                default: return try DesktopAccessibilityDriver.contains(finalParagraph, in: content)
                }
            }
            if scenario == "error" {
                XCTAssertTrue(try DesktopAccessibilityDriver.contains(
                    "This document could not be opened. It may have been removed, or your connection may be interrupted.",
                    in: content
                ))
            }
            if scenario == "loading" {
                XCTAssertTrue(try DesktopAccessibilityDriver.contains("Opening the source document…", in: content))
            }
            let title = try DesktopAccessibilityDriver.element("chat-document-title", in: content)
            XCTAssertEqual(
                title.accessibilityTextValue() ?? title.accessibilityLabel(),
                scenario == "error" || scenario == "loading" ? chosenTitle : loadedTitle
            )
            let area = try DesktopAccessibilityDriver.element("chat-document-content", in: content)
            let areaFrame = area.accessibilityFrame()
            let pixel = 1 / sheet.backingScaleFactor
            let scrolls = descendants(content).compactMap { $0 as? NSScrollView }.filter {
                let frame = sheet.convertToScreen($0.convert($0.bounds, to: nil))
                return $0.window === sheet && abs(frame.minX - areaFrame.minX) <= pixel && abs(frame.minY - areaFrame.minY) <= pixel &&
                    abs(frame.width - areaFrame.width) <= pixel && abs(frame.height - areaFrame.height) <= pixel
            }
            XCTAssertEqual(scrolls.count, 1)
            let scroll = try XCTUnwrap(scrolls.first)
            var previous: NSRect?, previousHeight: CGFloat?, previousDocument: CGFloat?, stable = 0
            try await wait {
                guard let document = scroll.documentView, scroll.contentView.bounds.height > 0 else { return false }
                let height = scroll.contentView.bounds.height
                let fits = long ? document.bounds.height > height + 44 : document.bounds.height <= height + pixel && height < 360
                guard fits else { stable = 0
                    return false
                }
                if previous == sheet.frame, previousHeight == height,
                   previousDocument == document.bounds.height { stable += 1 } else { stable = 0 }
                previous = sheet.frame
                previousHeight = height
                previousDocument = document.bounds.height
                return stable >= 3
            }
            XCTAssertEqual(hosting.bounds.size, NSSize(width: parentWidth, height: 600))
            XCTAssertGreaterThanOrEqual(window.contentLayoutRect.width, parentWidth)
            XCTAssertGreaterThanOrEqual(window.contentLayoutRect.height, 600)
            let screen = try XCTUnwrap(sheet.screen)
            XCTAssertTrue(screen.visibleFrame.contains(window.frame))
            XCTAssertTrue(screen.visibleFrame.contains(sheet.frame))
            XCTAssertLessThanOrEqual(sheet.frame.height, 600)
            XCTAssertEqual(sheet.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]), appearance)
            let heading = try DesktopAccessibilityDriver.element("chat-document-heading", in: content)
            XCTAssertEqual(heading.accessibilityTextValue() ?? heading.accessibilityLabel(), "Source document")
            let done = try DesktopAccessibilityDriver.element("chat-document-done", in: content)
            XCTAssertTrue(done.isAccessibilityEnabled())
            var fixed = [heading, done]
            if scenario == "normal" || scenario == "long" {
                let link = try DesktopAccessibilityDriver.element("chat-document-original", in: content)
                XCTAssertTrue(link.isAccessibilityEnabled())
                fixed.append(link)
            } else {
                XCTAssertFalse(try DesktopAccessibilityDriver.elements(in: content)
                    .contains { $0.accessibilityIdentifier() == "chat-document-original" })
            }
            let frames = fixed.map { $0.accessibilityFrame() }
            let viewport = sheet.convertToScreen(content.convert(content.bounds, to: nil))
            for frame in frames {
                XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                XCTAssertGreaterThan(frame.width, 0)
                XCTAssertGreaterThan(frame.height, 0)
                XCTAssertTrue(viewport.contains(frame))
            }
            if scenario == "loading" || scenario == "error" {
                let status = try DesktopAccessibilityDriver.element(
                    scenario == "loading" ? "chat-document-loading" : "chat-document-error",
                    in: content
                )
                let statusFrame = status.accessibilityFrame()
                let initialClip = sheet.convertToScreen(scroll.contentView.convert(scroll.contentView.bounds, to: nil))
                XCTAssertTrue([statusFrame.minX, statusFrame.minY, statusFrame.width, statusFrame.height].allSatisfy(\.isFinite))
                XCTAssertGreaterThan(statusFrame.width, 0)
                XCTAssertGreaterThan(statusFrame.height, 0)
                XCTAssertTrue(
                    initialClip.contains(statusFrame),
                    "Important loading/error status must be fully visible before scrolling the full title"
                )
            }
            if long {
                let document = try XCTUnwrap(scroll.documentView)
                let origin = scroll.contentView.bounds.origin
                scroll.contentView.scroll(to: NSPoint(
                    x: origin.x,
                    y: document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.height : document.bounds.minY
                ))
                scroll.reflectScrolledClipView(scroll.contentView)
                try await Task.sleep(for: .milliseconds(100))
                XCTAssertNotEqual(scroll.contentView.bounds.origin.y, origin.y)
                let gap = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.maxY : scroll.contentView.bounds
                    .minY - document.bounds.minY
                XCTAssertEqual(gap, 0, accuracy: pixel)
                XCTAssertEqual(fixed.map { $0.accessibilityFrame() }, frames)
                let terminalFrame: NSRect
                if scenario == "loading" || scenario == "error" {
                    let actualTitle = try DesktopAccessibilityDriver.element("chat-document-title", in: content)
                    terminalFrame = try finalTitleLineFrame(actualTitle, expected: chosenTitle, pixel: pixel)
                } else {
                    let terminal = try XCTUnwrap(DesktopAccessibilityDriver.elements(in: content).first {
                        $0.accessibilityTextValue() == finalParagraph || $0.accessibilityLabel() == finalParagraph
                    })
                    terminalFrame = terminal.accessibilityFrame()
                }
                let clip = sheet.convertToScreen(scroll.contentView.convert(scroll.contentView.bounds, to: nil))
                XCTAssertTrue([terminalFrame.minX, terminalFrame.minY, terminalFrame.width, terminalFrame.height].allSatisfy(\.isFinite))
                XCTAssertGreaterThan(terminalFrame.width, 0)
                XCTAssertGreaterThan(terminalFrame.height, 0)
                XCTAssertTrue(
                    clip.intersects(terminalFrame),
                    "The actual final paragraph or final title line must be reachable at the native document end"
                )
                scroll.contentView.scroll(to: origin)
                scroll.reflectScrolledClipView(scroll.contentView)
            }
            let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            try await DesktopSnapshotRenderer.captureOwnedWindow(
                sheet,
                output: output,
                name: "document-reader-wrapper-" + scenario + "-" + String(Int(parentWidth)),
                appearance: appearance,
                requireActive: true
            )
            let height = sheet.frame.height
            XCTAssertNil(bridge.selectedRuntime)
            try DesktopAccessibilityDriver.press("chat-document-done", in: content)
            try await wait { window.attachedSheet == nil }
            context.invalidate()
            _ = try await control(fixture.url, "fixture-release", session: session, body: [:])
            await context.drain()
            XCTAssertNil(window.attachedSheet, "A released held reply must not reopen a dismissed document")
            let status = try await control(fixture.url, "fixture-context-status", session: session)
            let requests = try XCTUnwrap(status["requests"] as? [[String: Any]])
            XCTAssertEqual(requests.count, 1)
            XCTAssertEqual(requests.first?["method"] as? String, "GET")
            XCTAssertEqual(requests.first?["path"] as? String, "/documents/" + id)
            window.close()
            return height
        } catch {
            window.close()
            context.invalidate()
            _ = try? await control(fixture.url, "fixture-release", session: session, body: [:])
            await context.drain()
            throw error
        }
    }
}
