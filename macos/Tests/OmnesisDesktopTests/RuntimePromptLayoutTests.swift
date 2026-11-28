// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class RuntimePromptLayoutTests: XCTestCase {
    func testProductionPromptSheetsKeepLongContentScrollableAndExistingActionsReachable() async throws {
        @MainActor func wait(_ predicate: @MainActor () throws -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(3)
            while ContinuousClock.now < deadline {
                let ready = try predicate()
                guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
                if ready { return }
                try await Task.sleep(for: .milliseconds(25))
            }
            throw URLError(.timedOut)
        }
        @MainActor func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap { descendants($0) }
        }
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var completedCases = 0
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for kind in ["chooseGateway", "compareCode", "openBrowser"] {
                var compactHeight: CGFloat?
                for variant in kind == "compareCode" ? ["compact", "long", "code-only"] : ["compact", "long"] {
                    let long = variant == "long", empty = variant == "code-only"
                    let message: String? = empty ? nil : long ? String(
                        repeating: "The fictional planning library keeps earlier project notes and the current draft. Review this information before choosing the next step. ",
                        count: 14
                    ) : "Review the fictional planning library."
                    var payload: [String: Any] = ["id": "invented-prompt", "kind": kind]
                    if let message { payload["message"] = message }
                    let choiceCount = long ? 12 : 2
                    if kind == "chooseGateway" {
                        payload["choices"] = (0 ..< choiceCount).map { [
                            "id": "choice-\($0)",
                            "name": "Fictional planning library on example computer \($0 + 1)",
                        ] }
                    }
                    if kind == "compareCode" { payload["code"] = "314159" }
                    if kind == "openBrowser" { payload["url"] = "https://signin.example.org/fictional" }
                    let prompt = try JSONDecoder().decode(RuntimeInteraction.self, from: JSONSerialization.data(withJSONObject: payload))
                    let bridge = RuntimeBridge()
                    let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
                    store.interaction = prompt
                    let suite = "dev.omnesis.prompt-layout-tests." + UUID().uuidString
                    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
                    defer { defaults.removePersistentDomain(forName: suite) }
                    let hosting = NSHostingView(rootView: DesktopRootView().environment(store).defaultAppStorage(defaults)
                        .environment(\.desktopAppearanceOverride, appearance == .aqua ? .light : .dark))
                    hosting.sizingOptions = []
                    hosting.autoresizingMask = [.width, .height]
                    hosting.frame = NSRect(x: 0, y: 0, width: 860, height: 600)
                    let window = NSWindow(
                        contentRect: hosting.frame,
                        styleMask: [.titled, .closable, .resizable],
                        backing: .buffered,
                        defer: false
                    )
                    window.isReleasedWhenClosed = false
                    window.contentView = hosting
                    window.setContentSize(NSSize(width: 860, height: 600))
                    window.center()
                    window.makeKeyAndOrderFront(nil)
                    defer { window.close() }
                    try await DesktopAccessibilityDriver.materializeOwnedApplication()
                    try await wait { window.attachedSheet != nil }
                    let sheet = try XCTUnwrap(window.attachedSheet)
                    XCTAssertTrue(sheet.sheetParent === window)
                    let content = try XCTUnwrap(sheet.contentView)
                    if !empty { try await wait { descendants(content).contains { $0 is NSScrollView } } }
                    let scrolls = descendants(content).compactMap { $0 as? NSScrollView }
                    if empty { XCTAssertLessThanOrEqual(scrolls.count, 1) } else { XCTAssertEqual(scrolls.count, 1) }
                    var scroll = scrolls.first
                    var previousFrame: NSRect?, previousHeight: CGFloat?, stable = 0
                    try await wait {
                        if empty {
                            let current = descendants(content).compactMap { $0 as? NSScrollView }
                            guard current.count <= 1 else { stable = 0
                                return false
                            }
                            scroll = current.first
                        }
                        let height = scroll?.contentView.bounds.height ?? 0
                        let matches: Bool = if empty {
                            height.isFinite && height >= 0 && height <= 1 &&
                                compactHeight.map { sheet.frame.height < $0 } == true
                        } else if let document = scroll?.documentView, height > 0 {
                            long ? document.bounds.height > height + 44 : document.bounds.height <= height + 1 && height < 320
                        } else { false }
                        guard matches else { stable = 0
                            return false
                        }
                        if previousFrame == sheet.frame, previousHeight == height { stable += 1 } else { stable = 0 }
                        previousFrame = sheet.frame
                        previousHeight = height
                        return stable >= 3
                    }
                    if empty {
                        let current = descendants(content).compactMap { $0 as? NSScrollView }
                        XCTAssertLessThanOrEqual(current.count, 1)
                        scroll = current.first
                        let height = scroll?.contentView.bounds.height ?? 0
                        XCTAssertTrue(height.isFinite)
                        XCTAssertGreaterThanOrEqual(height, 0)
                        XCTAssertLessThanOrEqual(
                            height,
                            1,
                            "The settled empty prompt must use the current native viewport, not an earlier missing-view snapshot"
                        )
                    }
                    XCTAssertEqual(hosting.bounds.size, NSSize(width: 860, height: 600))
                    XCTAssertGreaterThanOrEqual(window.contentLayoutRect.width, 860)
                    XCTAssertGreaterThanOrEqual(window.contentLayoutRect.height, 600)
                    let screen = try XCTUnwrap(sheet.screen)
                    XCTAssertTrue(screen.visibleFrame.contains(window.frame))
                    XCTAssertTrue(screen.visibleFrame.contains(sheet.frame))
                    XCTAssertLessThanOrEqual(
                        sheet.frame.height,
                        600,
                        "The actual prompt sheet must remain bounded at the small-window height, including its pinned comparison code"
                    )
                    XCTAssertEqual(sheet.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]), appearance)
                    if long { XCTAssertGreaterThan(sheet.frame.height, try XCTUnwrap(compactHeight)) }
                    else if empty {
                        XCTAssertLessThan(
                            sheet.frame.height,
                            try XCTUnwrap(compactHeight),
                            "A code-only prompt must not retain an unmeasured positive body viewport"
                        )
                        XCTAssertNil(prompt.message)
                        XCTAssertFalse(try DesktopAccessibilityDriver.elements(in: content)
                            .contains { $0.accessibilityIdentifier() == "runtime-prompt-message" })
                    } else { compactHeight = sheet.frame.height }
                    if let message {
                        let text = try DesktopAccessibilityDriver.element("runtime-prompt-message", in: content)
                        XCTAssertEqual(text.accessibilityTextValue() ?? text.accessibilityLabel(), message)
                    }
                    let cancel = try DesktopAccessibilityDriver.element("runtime-prompt-cancel", in: content)
                    var pinned = try [DesktopAccessibilityDriver.element("runtime-prompt-title", in: content), cancel]
                    if kind == "compareCode" {
                        let code = try DesktopAccessibilityDriver.element("comparison-code", in: content)
                        XCTAssertEqual(code.accessibilityTextValue() ?? code.accessibilityLabel(), "314159")
                        pinned.append(code)
                        let approve = try DesktopAccessibilityDriver.element("runtime-prompt-approve", in: content)
                        XCTAssertTrue(approve.isAccessibilityEnabled())
                        pinned.append(approve)
                    }
                    if kind == "openBrowser" {
                        let proceed = try DesktopAccessibilityDriver.element("runtime-prompt-continue", in: content)
                        XCTAssertTrue(proceed.isAccessibilityEnabled())
                        pinned.append(proceed)
                    }
                    XCTAssertTrue(cancel.isAccessibilityEnabled())
                    let frames = pinned.map { $0.accessibilityFrame() }
                    let viewport = sheet.convertToScreen(content.convert(content.bounds, to: nil))
                    for frame in frames {
                        XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                        XCTAssertGreaterThan(frame.width, 0)
                        XCTAssertGreaterThan(frame.height, 0)
                        XCTAssertTrue(viewport.contains(frame))
                    }
                    XCTAssertEqual(store.interaction, prompt, "Mounting must not respond to, approve or cancel the runtime prompt")
                    XCTAssertNil(bridge.selectedRuntime, "The presentation fixture must not start a runtime")
                    if long {
                        let scroll = try XCTUnwrap(scroll)
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
                        XCTAssertEqual(pinned.map { $0.accessibilityFrame() }, frames)
                        let scrollViewport = sheet.convertToScreen(scroll.contentView.convert(scroll.contentView.bounds, to: nil))
                        if kind == "openBrowser" {
                            let browser = try DesktopAccessibilityDriver.element("runtime-prompt-browser", in: content)
                            XCTAssertTrue(browser.isAccessibilityEnabled())
                            XCTAssertTrue(
                                scrollViewport.contains(browser.accessibilityFrame()),
                                "The existing browser action remains reachable without launching it"
                            )
                        }
                        if kind == "chooseGateway" {
                            let last = try DesktopAccessibilityDriver.element("runtime-prompt-choice-\(choiceCount - 1)", in: content)
                            XCTAssertTrue(last.isAccessibilityEnabled())
                            XCTAssertTrue(
                                scrollViewport.contains(last.accessibilityFrame()),
                                "The final real choice must be reachable by scrolling"
                            )
                            XCTAssertEqual(last.accessibilityLabel(), "Fictional planning library on example computer \(choiceCount)")
                        }
                        scroll.contentView.scroll(to: origin)
                        scroll.reflectScrolledClipView(scroll.contentView)
                        try await Task.sleep(for: .milliseconds(100))
                    }
                    try await DesktopSnapshotRenderer.captureOwnedWindow(
                        sheet,
                        output: output,
                        name: "runtime-prompt-attached-" + kind + "-" + variant,
                        appearance: appearance,
                        requireActive: true
                    )
                    XCTAssertTrue(window.attachedSheet === sheet && sheet.sheetParent === window)
                    XCTAssertTrue(cancel.accessibilityPerformPress())
                    try await wait { store.interaction == nil && window.attachedSheet == nil }
                    XCTAssertNil(bridge.selectedRuntime)
                    completedCases += 1
                }
            }
        }
        XCTAssertEqual(completedCases, 14)
    }
}
