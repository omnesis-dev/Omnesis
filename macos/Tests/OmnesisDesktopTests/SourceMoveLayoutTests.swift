// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

/// Mounts the production consent view through the shared sheet wrapper.
/// Source discovery and the production setup presenter are covered separately.
@MainActor
private struct SourceMoveSheetFixture: View {
    let flow: DesktopSourceFlow
    var body: some View {
        Text("Fictional source settings")
            .omnesisSheet(isPresented: Binding(get: { flow.pendingMove != nil }, set: { if !$0 { flow.pendingMove = nil } })) {
                if let pending = flow.pendingMove { DesktopSourceMoveConfirmation(flow: flow, pending: pending) }
            }
    }
}

@MainActor
final class SourceMoveLayoutTests: XCTestCase {
    func testMoveConsentKeepsFullContextScrollableAndOriginalCancellationAndBusyGuards() async throws {
        @MainActor func wait(_ condition: @MainActor () throws -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(3)
            while ContinuousClock.now < deadline {
                let ready = try condition()
                guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
                if ready { return }
                try await Task.sleep(for: .milliseconds(25))
            }
            throw URLError(.timedOut)
        }
        @MainActor func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap { descendants($0) }
        }
        func decode<T: Decodable>(_ type: T.Type, _ value: [String: Any]) throws -> T {
            try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
        }
        let fixture = try await ScriptedAgentFixture.start(scriptName: "api-context-fixture.mjs")
        defer { fixture.stop() }
        let api = try DesktopAPI(connection: decode(
            DesktopConnection.self,
            ["url": fixture.url.absoluteString, "token": "gui-fixture-token"]
        ))
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var completedCases = 0
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for parentWidth in [CGFloat(860), CGFloat(720)] {
                for enabled in [false, true] {
                    var compactHeight: CGFloat?
                    for long in [false, true] {
                        let targetName = long ? String(repeating: "Fictional archive computer with an extended display name ", count: 8) : "Example archive computer"
                        let account = long ? String(repeating: "Fictional source account with an extended display name ", count: 8) : "Example archive account"
                        let requirements: [[String: Any]] = long ? (0 ..< 6).map { index in [
                            "id": "invented-folder-\(index)", "kind": "selected-folder", "blocking": true,
                            "summary": "Review access to fictional folder \(index + 1)",
                            "scope": String(repeating: "Only this invented folder is included in the access review. ", count: 6),
                            "actions": [["kind": "retry-access"]],
                        ] } : []
                        let descriptor = try decode(DesktopDescriptor.self, [
                            "id": "invented", "name": "Fictional source", "description": "Fictional source description",
                            "hasAuthFlow": false, "hasDiscover": false, "permissionRequirements": requirements,
                            "devices": [["id": "target", "name": targetName]],
                        ])
                        let pending = try decode(DesktopSourceSettingsSnapshot.self, [
                            "source": [
                                "id": "fictional-source",
                                "type": "invented",
                                "accountId": account,
                                "enabled": enabled,
                                "deviceId": "previous",
                                "config": [:],
                            ] as [String: Any],
                            "revision": String(repeating: "a", count: 64),
                        ])
                        let flow = DesktopSourceFlow(descriptor: descriptor, api: api, hostId: "target")
                        flow.pendingMove = pending
                        flow.needsAccess = long
                        let bridge = RuntimeBridge()
                        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
                        let suite = "dev.omnesis.source-move-layout." + UUID().uuidString
                        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
                        defer { defaults.removePersistentDomain(forName: suite) }
                        let hosting = NSHostingView(rootView: SourceMoveSheetFixture(flow: flow).environment(store).omnesisTheme()
                            .defaultAppStorage(defaults).environment(\.desktopAppearanceOverride, appearance == .aqua ? .light : .dark))
                        hosting.sizingOptions = []
                        hosting.autoresizingMask = [.width, .height]
                        hosting.frame = NSRect(x: 0, y: 0, width: parentWidth, height: 600)
                        let window = NSWindow(
                            contentRect: hosting.frame,
                            styleMask: [.titled, .closable, .resizable],
                            backing: .buffered,
                            defer: false
                        )
                        window.isReleasedWhenClosed = false
                        window.contentView = hosting
                        window.setContentSize(NSSize(width: parentWidth, height: 600))
                        window.center()
                        window.makeKeyAndOrderFront(nil)
                        defer { window.close() }
                        try await DesktopAccessibilityDriver.materializeOwnedApplication()
                        try await wait { window.attachedSheet != nil }
                        let sheet = try XCTUnwrap(window.attachedSheet)
                        XCTAssertTrue(sheet.sheetParent === window)
                        let content = try XCTUnwrap(sheet.contentView)
                        try await wait { descendants(content).contains { $0 is NSScrollView } }
                        let scrolls = descendants(content).compactMap { $0 as? NSScrollView }
                        XCTAssertEqual(scrolls.count, 1)
                        let scroll = try XCTUnwrap(scrolls.first)
                        var previousFrame: NSRect?, previousHeight: CGFloat?, stable = 0
                        try await wait {
                            guard let document = scroll.documentView, scroll.contentView.bounds.height > 0 else { return false }
                            let height = scroll.contentView.bounds.height
                            let fits = long ? document.bounds.height > height + 44 : document.bounds.height <= height + 1 && height < 360
                            guard fits else { stable = 0
                                return false
                            }
                            if previousFrame == sheet.frame, previousHeight == height { stable += 1 } else { stable = 0 }
                            previousFrame = sheet.frame
                            previousHeight = height
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
                        if long { XCTAssertGreaterThan(sheet.frame.height, try XCTUnwrap(compactHeight)) }
                        else { compactHeight = sheet.frame.height }
                        let title = try DesktopAccessibilityDriver.element("source-move-title", in: content)
                        let keep = try DesktopAccessibilityDriver.element("source-move-keep", in: content)
                        let move = try DesktopAccessibilityDriver.element("source-move-confirm", in: content)
                        XCTAssertEqual(title.accessibilityTextValue() ?? title.accessibilityLabel(), "Move this account?")
                        XCTAssertEqual(move.accessibilityLabel(), "Move account to \(targetName)")
                        XCTAssertTrue(keep.isAccessibilityEnabled())
                        XCTAssertTrue(move.isAccessibilityEnabled())
                        let frames = [title, keep, move].map { $0.accessibilityFrame() }
                        let viewport = sheet.convertToScreen(content.convert(content.bounds, to: nil))
                        for frame in frames {
                            XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                            XCTAssertGreaterThan(frame.width, 0)
                            XCTAssertGreaterThan(frame.height, 0)
                            XCTAssertTrue(viewport.contains(frame))
                        }
                        let accountText = try DesktopAccessibilityDriver.element("source-move-account", in: content)
                        let destination = try DesktopAccessibilityDriver.element("source-move-destination", in: content)
                        XCTAssertEqual(accountText.accessibilityTextValue() ?? accountText.accessibilityLabel(), account)
                        XCTAssertEqual(destination.accessibilityTextValue() ?? destination.accessibilityLabel(), "To: \(targetName)")
                        XCTAssertEqual(try DesktopAccessibilityDriver.elements(in: content).contains {
                            $0.accessibilityIdentifier() == "source-move-paused"
                        }, !enabled)
                        if long {
                            let document = try XCTUnwrap(scroll.documentView)
                            let origin = scroll.contentView.bounds.origin
                            let end = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.height : document.bounds.minY
                            scroll.contentView.scroll(to: NSPoint(x: origin.x, y: end))
                            scroll.reflectScrolledClipView(scroll.contentView)
                            try await Task.sleep(for: .milliseconds(100))
                            XCTAssertNotEqual(scroll.contentView.bounds.origin.y, origin.y)
                            let gap = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.maxY : scroll.contentView.bounds
                                .minY - document.bounds.minY
                            XCTAssertEqual(gap, 0, accuracy: 1 / sheet.backingScaleFactor)
                            XCTAssertEqual([title, keep, move].map { $0.accessibilityFrame() }, frames)
                            scroll.contentView.scroll(to: origin)
                            scroll.reflectScrolledClipView(scroll.contentView)
                            try await Task.sleep(for: .milliseconds(100))
                        }
                        flow.busy = true
                        try await wait {
                            try !DesktopAccessibilityDriver.element("source-move-keep", in: content).isAccessibilityEnabled() &&
                                !DesktopAccessibilityDriver.element("source-move-confirm", in: content).isAccessibilityEnabled()
                        }
                        XCTAssertNotNil(flow.pendingMove)
                        flow.busy = false
                        try await wait { try DesktopAccessibilityDriver.element("source-move-keep", in: content).isAccessibilityEnabled() }
                        let name = "source-move-wrapper-\(Int(parentWidth))-" + (enabled ? "enabled" : "paused") +
                            (long ? "-long" : "-compact")
                        try await DesktopSnapshotRenderer.captureOwnedWindow(
                            sheet,
                            output: output,
                            name: name,
                            appearance: appearance,
                            requireActive: true
                        )
                        try DesktopAccessibilityDriver.press("source-move-keep", in: content)
                        try await wait { window.attachedSheet == nil }
                        XCTAssertNil(flow.pendingMove)
                        XCTAssertEqual(flow.deviceId, "target")
                        XCTAssertEqual(pending.source.enabled, enabled)
                        XCTAssertNil(bridge.selectedRuntime)
                        completedCases += 1
                    }
                }
            }
        }
        XCTAssertEqual(completedCases, 16)
        var request = URLRequest(url: fixture.url.appendingPathComponent("fixture-context-status"))
        request.setValue("Bearer gui-fixture-token", forHTTPHeaderField: "Authorization")
        let (bytes, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        struct Request: Decodable { let method: String
            let path: String
        }
        struct Requests: Decodable { let requests: [Request] }
        XCTAssertTrue(
            try JSONDecoder().decode(Requests.self, from: bytes).requests.isEmpty,
            "Review and Keep must not dispatch source moves or permission requests"
        )
    }
}
