// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

/// Uses the production shared sheet wrapper with the existing no-status-request seam.
/// The production root uses loadStatus=true and is not qualified by this fixture.
@MainActor
private struct RecoveryProtectionSheetFixture: View {
    let store: DesktopStore
    @State private var presented = true
    var body: some View {
        Text("Fictional recovery settings")
            .omnesisSheet(isPresented: $presented) { DesktopRecoveryView(loadStatus: false).environment(store) }
    }
}

@MainActor
final class RecoveryProtectionLayoutTests: XCTestCase {
    func testRecoveryProtectionSheetsKeepLongErrorsScrollableAndExistingDismissalReachable() async throws {
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
        @MainActor func button(_ label: String, in view: NSView) throws -> DesktopAccessibilityDriver.Element {
            try XCTUnwrap(DesktopAccessibilityDriver.elements(in: view).first {
                $0.accessibilityRole() == .button && $0.accessibilityLabel() == label
            })
        }
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var completedCases = 0
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for phase in ["status", "error", "draft", "saved", "import"] {
                var compactHeight: CGFloat?
                for long in phase == "import" ? [false] : [false, true] {
                    let bridge = RuntimeBridge()
                    let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
                    store.state = try JSONDecoder().decode(DesktopState.self, from: JSONSerialization.data(withJSONObject: [
                        "phase": "ready", "mode": phase == "status" ? "joined" : "home", "homeName": "Example library server",
                    ]))
                    store.recoveryStatus = try JSONDecoder().decode(
                        DesktopRecoveryStatus.self,
                        from: JSONSerialization.data(withJSONObject: [
                            "available": phase != "status", "hasEnvelope": false, "envelopeValid": false,
                        ])
                    )
                    if phase == "draft" {
                        store.recoveryDraft = try JSONDecoder().decode(
                            DesktopRecoveryDraft.self,
                            from: JSONSerialization.data(withJSONObject: [
                                "draftId": "fictional-draft", "expiresAt": Date().timeIntervalSince1970 * 1000 + 300_000,
                                "recoveryCode": "fictional-private-recovery-code", "envelope": ["fictional": true],
                            ])
                        )
                    }
                    if phase == "saved" { store.recoverySaved = true }
                    let message = long
                        ? String(
                            repeating: "This fictional recovery check could not finish. Your library and existing recovery protection are kept. Review the connection before trying again. ",
                            count: 14
                        )
                        : "The fictional recovery check could not finish. Existing protection is kept."
                    if long || phase == "error" { store.failure = message }
                    let suite = "dev.omnesis.recovery-protection-layout." + UUID().uuidString
                    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
                    defer { defaults.removePersistentDomain(forName: suite) }
                    let hosting = NSHostingView(rootView: RecoveryProtectionSheetFixture(store: store).omnesisTheme()
                        .defaultAppStorage(defaults).environment(\.desktopAppearanceOverride, appearance == .aqua ? .light : .dark))
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
                    if phase == "draft" {
                        try await wait { (try? DesktopAccessibilityDriver.element("recovery-protection-reveal", in: content)) != nil }
                        XCTAssertFalse(try DesktopAccessibilityDriver.elements(in: content)
                            .contains { $0.accessibilityIdentifier() == "recovery-protection-code" })
                        try DesktopAccessibilityDriver.press("recovery-protection-reveal", in: content)
                        try await wait { (try? DesktopAccessibilityDriver.element("recovery-protection-code", in: content)) != nil }
                        let code = try DesktopAccessibilityDriver.element("recovery-protection-code", in: content)
                        XCTAssertEqual(code.accessibilityTextValue() ?? code.accessibilityLabel(), "fictional-private-recovery-code")
                        XCTAssertFalse(
                            try DesktopAccessibilityDriver.element("recovery-protection-confirm", in: content).isAccessibilityEnabled(),
                            "Revealing a code does not satisfy saving and separation requirements"
                        )
                    }
                    if phase == "import" {
                        let start = try button("Restore access with a recovery file…", in: content)
                        XCTAssertTrue(start.accessibilityPerformPress())
                        try await wait { (try? DesktopAccessibilityDriver.element("recovery-import-code", in: content)) != nil }
                        try DesktopAccessibilityDriver.type("fictional-import-code", into: "recovery-import-code", in: content)
                        XCTAssertFalse(
                            try button("Restore library access", in: content).isAccessibilityEnabled(),
                            "A typed code does not select or read a recovery file"
                        )
                    }
                    try await wait { (try? DesktopAccessibilityDriver.element("recovery-protection-content", in: content)) != nil }
                    let area = try DesktopAccessibilityDriver.element("recovery-protection-content", in: content)
                    let areaFrame = area.accessibilityFrame()
                    let pixel = 1 / sheet.backingScaleFactor
                    let scrolls = descendants(content).compactMap { $0 as? NSScrollView }.filter { scroll in
                        guard scroll.window === sheet else { return false }
                        let frame = sheet.convertToScreen(scroll.convert(scroll.bounds, to: nil))
                        return abs(frame.minX - areaFrame.minX) <= pixel && abs(frame.minY - areaFrame.minY) <= pixel &&
                            abs(frame.width - areaFrame.width) <= pixel && abs(frame.height - areaFrame.height) <= pixel
                    }
                    XCTAssertEqual(scrolls.count, 1, "Map only the recovery body viewport, not an editor's native scroll view")
                    let scroll = try XCTUnwrap(scrolls.first)
                    var previousFrame: NSRect?, previousHeight: CGFloat?, stable = 0
                    try await wait {
                        guard let document = scroll.documentView, scroll.contentView.bounds.height > 0 else { return false }
                        let height = scroll.contentView.bounds.height
                        let matches = long ? document.bounds.height > height + 44 : document.bounds.height <= height + 1 && height < 360
                        guard matches else { stable = 0
                            return false
                        }
                        if previousFrame == sheet.frame, previousHeight == height { stable += 1 } else { stable = 0 }
                        previousFrame = sheet.frame
                        previousHeight = height
                        return stable >= 3
                    }
                    XCTAssertEqual(hosting.bounds.size, NSSize(width: 860, height: 600))
                    XCTAssertGreaterThanOrEqual(window.contentLayoutRect.width, 860)
                    XCTAssertGreaterThanOrEqual(window.contentLayoutRect.height, 600)
                    let screen = try XCTUnwrap(sheet.screen)
                    XCTAssertTrue(screen.visibleFrame.contains(window.frame))
                    XCTAssertTrue(screen.visibleFrame.contains(sheet.frame))
                    XCTAssertLessThanOrEqual(sheet.frame.height, 600)
                    XCTAssertEqual(sheet.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]), appearance)
                    if long { XCTAssertGreaterThan(sheet.frame.height, try XCTUnwrap(compactHeight)) }
                    else { compactHeight = sheet.frame.height }
                    let title = try DesktopAccessibilityDriver.element("recovery-protection-title", in: content)
                    let dismiss = try DesktopAccessibilityDriver.element("recovery-protection-dismiss", in: content)
                    XCTAssertEqual(dismiss.accessibilityLabel(), phase == "saved" ? "Done" : "Cancel")
                    XCTAssertTrue(dismiss.isAccessibilityEnabled())
                    let frames = [title, dismiss].map { $0.accessibilityFrame() }
                    let viewport = sheet.convertToScreen(content.convert(content.bounds, to: nil))
                    for frame in frames {
                        XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                        XCTAssertGreaterThan(frame.width, 0)
                        XCTAssertGreaterThan(frame.height, 0)
                        XCTAssertTrue(viewport.contains(frame))
                    }
                    if long {
                        let document = try XCTUnwrap(scroll.documentView)
                        let error = try DesktopAccessibilityDriver.element("recovery-protection-error", in: content)
                        XCTAssertEqual(error.accessibilityTextValue() ?? error.accessibilityLabel(), message)
                        let origin = scroll.contentView.bounds.origin
                        let end = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.height : document.bounds.minY
                        scroll.contentView.scroll(to: NSPoint(x: origin.x, y: end))
                        scroll.reflectScrolledClipView(scroll.contentView)
                        try await Task.sleep(for: .milliseconds(100))
                        XCTAssertNotEqual(scroll.contentView.bounds.origin.y, origin.y)
                        let gap = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.maxY : scroll.contentView.bounds
                            .minY - document.bounds.minY
                        XCTAssertEqual(gap, 0, accuracy: 1 / sheet.backingScaleFactor)
                        XCTAssertEqual([title, dismiss].map { $0.accessibilityFrame() }, frames)
                        scroll.contentView.scroll(to: origin)
                        scroll.reflectScrolledClipView(scroll.contentView)
                        try await Task.sleep(for: .milliseconds(100))
                    }
                    XCTAssertNil(bridge.selectedRuntime)
                    let name = "recovery-protection-wrapper-" + phase + (long ? "-long" : "-compact")
                    try await DesktopSnapshotRenderer.captureOwnedWindow(
                        sheet,
                        output: output,
                        name: name,
                        appearance: appearance,
                        requireActive: true
                    )
                    XCTAssertTrue(window.attachedSheet === sheet && sheet.sheetParent === window)
                    if phase == "import" {
                        XCTAssertTrue(try button("Back", in: content).accessibilityPerformPress())
                        try await wait {
                            try !DesktopAccessibilityDriver.elements(in: content)
                                .contains { $0.accessibilityIdentifier() == "recovery-import-code" }
                        }
                        XCTAssertTrue(try button("Restore access with a recovery file…", in: content).accessibilityPerformPress())
                        try await wait { (try? DesktopAccessibilityDriver.element("recovery-import-code", in: content)) != nil }
                        let fields = descendants(content).compactMap { $0 as? NSTextField }.filter(\.isEditable)
                        XCTAssertEqual(fields.count, 1)
                        XCTAssertTrue(try XCTUnwrap(fields.first).stringValue.isEmpty, "Back must clear the local recovery code")
                    }
                    try DesktopAccessibilityDriver.press("recovery-protection-dismiss", in: content)
                    try await wait { window.attachedSheet == nil }
                    if phase == "draft" { XCTAssertNil(store.recoveryDraft) }
                    XCTAssertNil(bridge.selectedRuntime)
                    completedCases += 1
                }
            }
        }
        XCTAssertEqual(completedCases, 18)
    }
}
