// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

/// Exercises the real removal view through the shared sheet wrapper, not Settings navigation.
@MainActor
private struct RemovalSheetFixture: View {
    let store: DesktopStore
    @State private var presented = true
    var body: some View {
        Text("Fictional removal settings")
            .omnesisSheet(isPresented: $presented) { DesktopRemovalView().environment(store) }
    }
}

@MainActor
final class RemovalLayoutTests: XCTestCase {
    private func wait(_ condition: @MainActor () throws -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < deadline {
            let ready = try condition()
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            if ready { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw URLError(.timedOut)
    }

    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { descendants($0) }
    }

    private func button(_ label: String, in view: NSView) throws -> DesktopAccessibilityDriver.Element {
        try XCTUnwrap(DesktopAccessibilityDriver.elements(in: view).first {
            $0.accessibilityRole() == .button && $0.accessibilityLabel() == label
        })
    }

    private func plan(erase: Bool) throws -> DesktopRemovalPlan {
        try JSONDecoder().decode(DesktopRemovalPlan.self, from: JSONSerialization.data(withJSONObject: [
            "available": true, "mode": erase ? "erase-data" : "keep-data",
            "confirmationId": String(repeating: "a", count: 64),
            "summary": erase ? "Erase only this managed library." : "Stop Omnesis and keep its library.", "dataKept": !erase,
            "keyKept": !erase,
        ]))
    }

    func testRemovalSheetsKeepLongErrorsScrollableAndApplicableActionsPinned() async throws {
        var completed = 0
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            for width in [CGFloat(860), CGFloat(720)] {
                var compactHeight: CGFloat?
                for scenario in ["compact", "long-error", "finished", "pending"] {
                    let height = try await exercise(scenario, appearance: appearance, parentWidth: width)
                    if scenario == "compact" { compactHeight = height }
                    if scenario == "long-error" { XCTAssertGreaterThan(height, try XCTUnwrap(compactHeight)) }
                    completed += 1
                }
            }
        }
        XCTAssertEqual(completed, 16)
    }

    private func exercise(_ scenario: String, appearance: NSAppearance.Name, parentWidth: CGFloat) async throws -> CGFloat {
        let bridge = RuntimeBridge()
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, monitorPrerequisites: false)
        store.state = try JSONDecoder().decode(DesktopState.self, from: Data(#"{"phase":"ready","mode":"home"}"#.utf8))
        if scenario == "finished" || scenario == "pending" {
            let wire = scenario == "finished" ? #"{"status":"retired","data":"retained","keyring":"retained"}"# :
                #"{"status":"key-cleanup-pending","data":"erased","keyring":"pending"}"#
            store.removalOutcome = try JSONDecoder().decode(DesktopRemovalOutcome.self, from: Data(wire.utf8))
        } else {
            store.removalPlan = try plan(erase: false)
        }
        let failure = String(
            repeating: "This fictional removal review could not finish. Your library and saved key are unchanged; review the diagnostic before trying again. ",
            count: 18
        )
        if scenario == "long-error" { store.failure = failure }
        let suite = "dev.omnesis.removal-layout." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let hosting = NSHostingView(rootView: RemovalSheetFixture(store: store).omnesisTheme()
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
        defer { window.close() }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try await wait { window.attachedSheet != nil }
        let sheet = try XCTUnwrap(window.attachedSheet)
        let content = try XCTUnwrap(sheet.contentView)
        XCTAssertTrue(sheet.sheetParent === window)
        let area = try DesktopAccessibilityDriver.element("removal-content", in: content)
        let areaFrame = area.accessibilityFrame()
        let pixel = 1 / sheet.backingScaleFactor
        let scrolls = descendants(content).compactMap { $0 as? NSScrollView }.filter {
            let frame = sheet.convertToScreen($0.convert($0.bounds, to: nil))
            return $0.window === sheet && abs(frame.minX - areaFrame.minX) <= pixel && abs(frame.minY - areaFrame.minY) <= pixel &&
                abs(frame.width - areaFrame.width) <= pixel && abs(frame.height - areaFrame.height) <= pixel
        }
        XCTAssertEqual(scrolls.count, 1)
        let scroll = try XCTUnwrap(scrolls.first)
        var previous: NSRect?, previousHeight: CGFloat?, stable = 0
        try await wait {
            guard let document = scroll.documentView, scroll.contentView.bounds.height > 0 else { return false }
            let height = scroll.contentView.bounds.height
            let fits = scenario == "long-error" ? document.bounds.height > height + 44 : document.bounds
                .height <= height + pixel && height < 320
            guard fits else { stable = 0
                return false
            }
            if previous == sheet.frame, previousHeight == height { stable += 1 } else { stable = 0 }
            previous = sheet.frame
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
        let labels: [String] = switch scenario {
        case "finished": ["Done", "Move app to Trash and quit…"]
        case "pending": ["Retry saved key cleanup", "Keep the app for now"]
        default: ["Remove Omnesis, keep my library", "Cancel"]
        }
        let title = try DesktopAccessibilityDriver.element("removal-title", in: content)
        let actions = try labels.map { try button($0, in: content) }
        let controls = [title] + actions
        let frames = controls.map { $0.accessibilityFrame() }
        let viewport = sheet.convertToScreen(content.convert(content.bounds, to: nil))
        for frame in frames {
            XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
            XCTAssertGreaterThan(frame.width, 0)
            XCTAssertGreaterThan(frame.height, 0)
            XCTAssertTrue(viewport.contains(frame))
        }
        for action in actions {
            XCTAssertTrue(action.isAccessibilityEnabled())
        }
        if let outcome = store.removalOutcome {
            let message = try DesktopAccessibilityDriver.element("removal-outcome-message", in: content)
            XCTAssertEqual(message.accessibilityTextValue() ?? message.accessibilityLabel(), outcome.message)
            XCTAssertEqual(outcome.finished, scenario == "finished")
            XCTAssertFalse(try DesktopAccessibilityDriver.elements(in: content)
                .contains { $0.accessibilityIdentifier() == "remove-erase-data" })
        }
        if scenario == "long-error" {
            let error = try DesktopAccessibilityDriver.element("removal-error", in: content)
            XCTAssertEqual(error.accessibilityTextValue() ?? error.accessibilityLabel(), failure)
            let document = try XCTUnwrap(scroll.documentView)
            let origin = scroll.contentView.bounds.origin
            scroll.contentView.scroll(to: NSPoint(
                x: origin.x,
                y: document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.height : document.bounds.minY
            ))
            scroll.reflectScrolledClipView(scroll.contentView)
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertNotEqual(scroll.contentView.bounds.origin.y, origin.y)
            let gap = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.maxY : scroll.contentView.bounds.minY - document
                .bounds.minY
            XCTAssertEqual(gap, 0, accuracy: pixel)
            XCTAssertEqual(controls.map { $0.accessibilityFrame() }, frames)
            let visibleBody = sheet.convertToScreen(scroll.contentView.convert(scroll.contentView.bounds, to: nil))
            let errorFrame = try DesktopAccessibilityDriver.element("removal-error", in: content).accessibilityFrame()
            XCTAssertGreaterThan(errorFrame.width, 0)
            XCTAssertGreaterThan(errorFrame.height, 0)
            XCTAssertTrue(visibleBody.intersects(errorFrame))
            scroll.contentView.scroll(to: origin)
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try await DesktopSnapshotRenderer.captureOwnedWindow(
            sheet,
            output: output,
            name: "removal-wrapper-" + scenario + "-" + String(Int(parentWidth)),
            appearance: appearance,
            requireActive: true
        )
        let height = sheet.frame.height
        if scenario == "compact" {
            // A valid plan for the other erase mode must not authorize the visible remove action.
            store.removalPlan = try plan(erase: true)
            try await wait {
                try !DesktopAccessibilityDriver.elements(in: content)
                    .contains { $0.accessibilityRole() == .button && $0.accessibilityLabel() == "Remove Omnesis, keep my library" }
            }
            store.removalPlan = try plan(erase: false)
            try await wait { (try? self.button("Remove Omnesis, keep my library", in: content)) != nil }
            try DesktopAccessibilityDriver.press("remove-erase-data", in: content)
            try await wait { store.removalPlan == nil }
            XCTAssertTrue(try button("Review removal", in: content).isAccessibilityEnabled())
            XCTAssertFalse(try DesktopAccessibilityDriver.elements(in: content)
                .contains { $0.accessibilityRole() == .button && $0.accessibilityLabel() == "Remove Omnesis and erase its library…" })
        }
        XCTAssertNil(bridge.selectedRuntime)
        XCTAssertFalse(store.busy)
        let dismissal = try button(scenario == "finished" ? "Done" : scenario == "pending" ? "Keep the app for now" : "Cancel", in: content)
        XCTAssertTrue(dismissal.accessibilityPerformPress())
        try await wait { window.attachedSheet == nil }
        XCTAssertNil(bridge.selectedRuntime)
        return height
    }
}
