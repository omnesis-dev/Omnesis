// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class RecoveryCopiesTests: XCTestCase {
    private let id = "11111111-1111-4111-8111-111111111111"
    private func value(pinned: Bool, pending: Bool = false) throws -> BridgeValue {
        let text = #"{"kind":"desktopRecoveryCopies","limit":16,"items":[{"id":"11111111-1111-4111-8111-111111111111","purpose":"update","oldVersion":"1.2.3","registeredAt":"2026-01-01T12:00:00.000Z","bytes":1024,"pinned":PIN,"order":1,"disposition":"DISPOSITION","canReview":false}],"partialCopies":[],"pending":PENDING,"unregisteredCopies":0}"#
            .replacingOccurrences(of: "PIN", with: pinned ? "true" : "false")
            .replacingOccurrences(of: "DISPOSITION", with: pinned ? "pinned" : "latest")
            .replacingOccurrences(
                of: "PENDING",
                with: pending ? #"{"id":"22222222-2222-4222-8222-222222222222","phase":"planned","canCancel":true}"# : "null"
            )
        return try JSONDecoder().decode(BridgeValue.self, from: Data(text.utf8))
    }

    private func catalog(_ value: BridgeValue) throws -> DesktopRecoveryCopiesCatalog {
        try JSONDecoder().decode(DesktopRecoveryCopiesCatalog.self, from: JSONEncoder().encode(value))
    }

    func testReadAndPinUseOnlyTheRegisteredMetadataCommandsAndAuthoritativeReply() async throws {
        let initial = try value(pinned: false), saved = try value(pinned: true)
        var commands: [String] = []
        let flow = DesktopRecoveryCopiesFlow { name, params in
            commands.append(name)
            if name == "recoveryCopies" { XCTAssertTrue(params.isEmpty)
                return initial
            }
            XCTAssertEqual(name, "recoveryCopyPin")
            XCTAssertEqual(params, ["id": .string(self.id), "pinned": .bool(true)])
            return saved
        }
        await flow.refresh()
        XCTAssertEqual(flow.catalog?.items.first?.pinned, false)
        await flow.setPinned(id, true)
        XCTAssertEqual(flow.catalog?.items.first?.pinned, true)
        XCTAssertEqual(commands, ["recoveryCopies", "recoveryCopyPin"])
        XCTAssertNotNil(flow.notice)
    }

    func testRefusedOrPendingPinDoesNotClaimTheKeepChoiceWasSaved() async throws {
        let initial = try catalog(value(pinned: false))
        let flow = DesktopRecoveryCopiesFlow(catalog: initial) { _, _ in throw DesktopRecoveryCopiesFlow.Failure("Operation refused") }
        await flow.setPinned(id, true)
        XCTAssertEqual(flow.catalog?.items.first?.pinned, false)
        XCTAssertNil(flow.notice)
        XCTAssertNotNil(flow.error)
        let pending = try DesktopRecoveryCopiesFlow(catalog: catalog(value(pinned: false, pending: true))) { _, _ in
            XCTFail("A pending recovery operation must block keep-setting changes")
            return .null
        }
        await pending.setPinned(id, true)
        XCTAssertFalse(pending.busy)
        XCTAssertNil(pending.notice)
    }

    func testActualKeepToggleWaitsForConfirmedReplyAndDoesNotInvokeDeletion() async throws {
        let initial = try catalog(value(pinned: false)), saved = try value(pinned: true)
        var command: String?
        let flow = DesktopRecoveryCopiesFlow(catalog: initial) { name, params in
            command = name
            XCTAssertEqual(params, ["id": .string(self.id), "pinned": .bool(true)])
            return saved
        }
        let hosting = NSHostingView(rootView: Form { DesktopRecoveryCopiesSection(flow: flow, loadCatalog: false) }
            .formStyle(.grouped).environment(DesktopStore(startRuntime: false)))
        hosting.frame = NSRect(x: 0, y: 0, width: 820, height: 700)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(150))
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try DesktopAccessibilityDriver.press("keep-recovery-" + id, in: hosting)
        let deadline = ContinuousClock.now + .seconds(3)
        while flow.catalog?.items.first?.pinned != true, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertEqual(command, "recoveryCopyPin")
        XCTAssertEqual(flow.catalog?.items.first?.pinned, true)
        XCTAssertNotNil(flow.notice)
    }

    func testRecoveryCopyRenderShowsRecordedTimeAndProtectionWithoutDeleteControls() async throws {
        let flow = try DesktopRecoveryCopiesFlow(catalog: catalog(value(pinned: true, pending: true))) { _, _ in
            XCTFail("Render fixtures must not send runtime commands")
            return .null
        }
        try await DesktopSnapshotRenderer.render(
            Form { DesktopRecoveryCopiesSection(flow: flow, loadCatalog: false) }.formStyle(.grouped)
                .environment(DesktopStore(startRuntime: false)), name: "recovery-copies-kept", size: CGSize(width: 820, height: 740)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Retained", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Kept by your choice", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Delete", in: view))
        }
    }

    func testRecoveryCopyConfirmationKeepsLongDetailsScrollableAndConsentAndActionsReachableInBothAppearances() async throws {
        let longMessage = String(
            repeating: "This fictional recovery copy contains the earlier project index. Personal backups and original source files stay kept. ",
            count: 15
        )
        for (name, message, overflows) in [
            ("compact", "Personal backups and original files stay kept.", false),
            ("long", longMessage, true),
        ] {
            let data = try JSONSerialization.data(withJSONObject: [
                "kind": "desktopRecoveryCleanup", "phase": "preview", "id": id,
                "confirmationId": String(repeating: "a", count: 64), "bytes": 1024,
                "mode": "redundant-snapshot", "message": message,
                "selected": [
                    "id": id,
                    "purpose": "update",
                    "oldVersion": "1.2.3",
                    "registeredAt": "2030-01-01T12:00:00.000Z",
                    "bytes": 1024,
                    "order": 1,
                ],
                "keeper": [
                    "id": "22222222-2222-4222-8222-222222222222",
                    "purpose": "restore",
                    "oldVersion": "1.2.4",
                    "registeredAt": "2030-01-02T12:00:00.000Z",
                    "bytes": 2048,
                    "order": 2,
                ],
            ])
            let preview = try JSONDecoder().decode(DesktopRecoveryCleanupPreview.self, from: data)
            XCTAssertTrue(preview.valid, "The long fixture must remain inside the real preview contract")
            var commands = [String](), appearances = 0
            let flow = DesktopRecoveryCopiesFlow(preview: preview) { command, _ in
                commands.append(command)
                XCTFail("Measuring, scrolling and keeping a copy must not request removal")
                return .null
            }
            try await DesktopSnapshotRenderer.renderVisibleWindow(
                DesktopRecoveryCopyConfirmation(flow: flow, preview: preview),
                name: "recovery-copy-confirmation-\(name)", size: CGSize(width: 620, height: 560)
            ) { hosting in
                @MainActor
                func descendants(_ view: NSView) -> [NSView] {
                    [view] + view.subviews.flatMap(descendants)
                }
                let scrolls = descendants(hosting).compactMap { $0 as? NSScrollView }
                XCTAssertEqual(scrolls.count, 1, "Only the variable confirmation details need a scroll viewport")
                let scroll = try XCTUnwrap(scrolls.first)
                let deadline = ContinuousClock.now + .seconds(3)
                while scroll.contentView.bounds.height <= 0 || scroll.documentView == nil, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(25))
                }
                let document = try XCTUnwrap(scroll.documentView)
                XCTAssertGreaterThan(scroll.contentView.bounds.height, 0)
                XCTAssertLessThanOrEqual(scroll.contentView.bounds.height, 320)
                if overflows {
                    XCTAssertGreaterThan(document.bounds.height, scroll.contentView.bounds.height + 44)
                } else {
                    XCTAssertLessThanOrEqual(document.bounds.height, scroll.contentView.bounds.height + 1)
                    XCTAssertLessThan(scroll.contentView.bounds.height, 320, "Ordinary details must retain their natural compact height")
                }
                let explanation = try DesktopAccessibilityDriver.element("recovery-copy-confirmation-explanation", in: hosting)
                XCTAssertEqual(explanation.accessibilityTextValue() ?? explanation.accessibilityLabel(), message)
                let title = try DesktopAccessibilityDriver.element("recovery-copy-confirmation-title", in: hosting)
                let consent = try DesktopAccessibilityDriver.element("confirm-recovery-copy-understood", in: hosting)
                let keep = try DesktopAccessibilityDriver.element("keep-recovery-copy", in: hosting)
                let remove = try DesktopAccessibilityDriver.element("confirm-remove-recovery-copy", in: hosting)
                let window = try XCTUnwrap(hosting.window)
                let frames = [title, consent, keep, remove].map { $0.accessibilityFrame() }
                let viewport = window.convertToScreen(hosting.convert(hosting.bounds, to: nil))
                for frame in frames {
                    XCTAssertGreaterThan(frame.width, 0)
                    XCTAssertGreaterThan(frame.height, 0)
                    XCTAssertTrue(viewport.contains(frame), "Title, consent and footer actions must remain in the actual small viewport")
                }
                XCTAssertTrue(keep.isAccessibilityEnabled())
                XCTAssertFalse(remove.isAccessibilityEnabled(), "Scrolling does not imply consent")
                let original = scroll.contentView.bounds.origin
                if overflows {
                    let end = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.height : document.bounds.minY
                    scroll.contentView.scroll(to: NSPoint(x: original.x, y: end))
                    scroll.reflectScrolledClipView(scroll.contentView)
                    try await Task.sleep(for: .milliseconds(100))
                    XCTAssertNotEqual(scroll.contentView.bounds.origin.y, original.y)
                    let distance = document.isFlipped
                        ? document.bounds.maxY - scroll.contentView.bounds.maxY
                        : scroll.contentView.bounds.minY - document.bounds.minY
                    XCTAssertEqual(
                        distance,
                        0,
                        accuracy: 1 / window.backingScaleFactor,
                        "The actual end of the complete message must be scrollable into view"
                    )
                    XCTAssertEqual(
                        [title, consent, keep, remove].map { $0.accessibilityFrame() },
                        frames,
                        "Scrolling details must not move the fixed consent or footer"
                    )
                    scroll.contentView.scroll(to: original)
                    scroll.reflectScrolledClipView(scroll.contentView)
                }
                XCTAssertTrue(consent.accessibilityPerformPress())
                let consentDeadline = ContinuousClock.now + .seconds(3)
                while !remove.isAccessibilityEnabled(), ContinuousClock.now < consentDeadline {
                    try await Task.sleep(for: .milliseconds(25))
                }
                XCTAssertTrue(
                    remove.isAccessibilityEnabled(),
                    "Only the unchanged explicit consent enables removal for a valid idle preview"
                )
                XCTAssertTrue(commands.isEmpty, "Consent alone must not remove a copy")
                XCTAssertTrue(consent.accessibilityPerformPress())
                let clearDeadline = ContinuousClock.now + .seconds(3)
                while remove.isAccessibilityEnabled(), ContinuousClock.now < clearDeadline {
                    try await Task.sleep(for: .milliseconds(25))
                }
                XCTAssertFalse(remove.isAccessibilityEnabled())
                XCTAssertTrue(commands.isEmpty)
                XCTAssertEqual(flow.preview?.confirmationId, preview.confirmationId)
                if appearances == 1 {
                    XCTAssertTrue(keep.accessibilityPerformPress())
                    XCTAssertNil(flow.preview, "The existing Keep action must still dismiss review without removal")
                }
                appearances += 1
            }
            XCTAssertEqual(appearances, 2)
            XCTAssertTrue(commands.isEmpty)
        }
    }

    func testProductionRecoveryCopySheetFitsAndDismissesWithoutRemovalForCompactAndLongDetails() async throws {
        @MainActor
        func wait(_ condition: () throws -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(3)
            while ContinuousClock.now < deadline {
                let ready = try condition()
                guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
                if ready { return }
                try await Task.sleep(for: .milliseconds(25))
            }
            throw URLError(.timedOut)
        }
        @MainActor
        func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap(descendants)
        }
        let longMessage = String(
            repeating: "This fictional recovery copy contains the earlier project index. Personal backups and original source files stay kept. ",
            count: 15
        )
        let output = URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            var compactHeight: CGFloat?
            for (name, message, overflows) in [
                ("compact", "Personal backups and original files stay kept.", false),
                ("long", longMessage, true),
            ] {
                let data = try JSONSerialization.data(withJSONObject: [
                    "kind": "desktopRecoveryCleanup", "phase": "preview", "id": id,
                    "confirmationId": String(repeating: "a", count: 64), "bytes": 1024,
                    "mode": "redundant-snapshot", "message": message,
                    "selected": [
                        "id": id,
                        "purpose": "update",
                        "oldVersion": "1.2.3",
                        "registeredAt": "2030-01-01T12:00:00.000Z",
                        "bytes": 1024,
                        "order": 1,
                    ],
                    "keeper": [
                        "id": "22222222-2222-4222-8222-222222222222",
                        "purpose": "restore",
                        "oldVersion": "1.2.4",
                        "registeredAt": "2030-01-02T12:00:00.000Z",
                        "bytes": 2048,
                        "order": 2,
                    ],
                ])
                let preview = try JSONDecoder().decode(DesktopRecoveryCleanupPreview.self, from: data)
                XCTAssertTrue(preview.valid)
                var commands = [String]()
                let flow = DesktopRecoveryCopiesFlow(preview: preview) { command, _ in
                    commands.append(command)
                    XCTFail("The attached-sheet fixture must not remove or refresh a copy")
                    return .null
                }
                let suite = "dev.omnesis.recovery-sheet-tests." + UUID().uuidString
                let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
                defer { defaults.removePersistentDomain(forName: suite) }
                let hosting = NSHostingView(rootView: Form {
                    DesktopRecoveryCopiesSection(flow: flow, loadCatalog: false)
                }.formStyle(.grouped).environment(DesktopStore(startRuntime: false)).omnesisTheme()
                    .defaultAppStorage(defaults)
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
                try await wait { descendants(content).contains { $0 is NSScrollView } }
                let scrolls = descendants(content).compactMap { $0 as? NSScrollView }
                XCTAssertEqual(scrolls.count, 1)
                let scroll = try XCTUnwrap(scrolls.first)
                var lastFrame: NSRect?, lastViewportHeight: CGFloat?, stableSamples = 0
                try await wait {
                    guard let document = scroll.documentView, scroll.contentView.bounds.height > 0 else { return false }
                    let height = scroll.contentView.bounds.height
                    let matchesContent = overflows
                        ? document.bounds.height > height + 44
                        : document.bounds.height <= height + 1 && height < 320
                    guard matchesContent else { stableSamples = 0
                        return false
                    }
                    if lastFrame == sheet.frame, lastViewportHeight == height { stableSamples += 1 } else { stableSamples = 0 }
                    lastFrame = sheet.frame
                    lastViewportHeight = height
                    return stableSamples >= 3
                }
                let document = try XCTUnwrap(scroll.documentView)
                let screen = try XCTUnwrap(sheet.screen)
                XCTAssertEqual(
                    hosting.bounds.size,
                    NSSize(width: 860, height: 600),
                    "The attached sheet must retain the configured small parent viewport"
                )
                XCTAssertGreaterThanOrEqual(window.contentLayoutRect.width, 860)
                XCTAssertGreaterThanOrEqual(window.contentLayoutRect.height, 600)
                XCTAssertTrue(screen.visibleFrame.contains(window.frame), "The supported-minimum parent fixture must fit its actual screen")
                XCTAssertTrue(screen.visibleFrame.contains(sheet.frame), "The real attached sheet must fit the actual display")
                XCTAssertTrue(window.attachedSheet === sheet && sheet.sheetParent === window)
                XCTAssertEqual(sheet.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]), appearance)
                if overflows {
                    XCTAssertGreaterThan(
                        sheet.frame.height,
                        try XCTUnwrap(compactHeight),
                        "Long content must grow only as far as its bounded details viewport"
                    )
                    XCTAssertLessThanOrEqual(scroll.contentView.bounds.height, 320)
                } else { compactHeight = sheet.frame.height }
                let explanation = try DesktopAccessibilityDriver.element("recovery-copy-confirmation-explanation", in: content)
                XCTAssertEqual(explanation.accessibilityTextValue() ?? explanation.accessibilityLabel(), message)
                let controls = try [
                    "recovery-copy-confirmation-title",
                    "confirm-recovery-copy-understood",
                    "keep-recovery-copy",
                    "confirm-remove-recovery-copy",
                ].map {
                    try DesktopAccessibilityDriver.element($0, in: content)
                }
                let frames = controls.map { $0.accessibilityFrame() }
                let viewport = sheet.convertToScreen(content.convert(content.bounds, to: nil))
                for frame in frames {
                    XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                    XCTAssertGreaterThan(frame.width, 0)
                    XCTAssertGreaterThan(frame.height, 0)
                    XCTAssertTrue(viewport.contains(frame))
                    XCTAssertTrue(screen.visibleFrame.contains(frame))
                }
                let consent = controls[1], keep = controls[2], remove = controls[3]
                XCTAssertFalse(remove.isAccessibilityEnabled())
                XCTAssertTrue(keep.isAccessibilityEnabled())
                if overflows {
                    let origin = scroll.contentView.bounds.origin
                    let end = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.height : document.bounds.minY
                    scroll.contentView.scroll(to: NSPoint(x: origin.x, y: end))
                    scroll.reflectScrolledClipView(scroll.contentView)
                    try await Task.sleep(for: .milliseconds(100))
                    XCTAssertNotEqual(scroll.contentView.bounds.origin.y, origin.y)
                    let gap = document.isFlipped ? document.bounds.maxY - scroll.contentView.bounds.maxY : scroll.contentView.bounds
                        .minY - document.bounds.minY
                    XCTAssertEqual(gap, 0, accuracy: 1 / sheet.backingScaleFactor)
                    XCTAssertEqual(
                        controls.map { $0.accessibilityFrame() },
                        frames,
                        "Scrolling the real sheet's details must not move its footer"
                    )
                    scroll.contentView.scroll(to: origin)
                    scroll.reflectScrolledClipView(scroll.contentView)
                    try await Task.sleep(for: .milliseconds(100))
                }
                XCTAssertTrue(consent.accessibilityPerformPress())
                try await wait { remove.isAccessibilityEnabled() }
                XCTAssertTrue(commands.isEmpty)
                XCTAssertTrue(consent.accessibilityPerformPress())
                try await wait { !remove.isAccessibilityEnabled() }
                let captureName = "recovery-copy-attached-" + name
                try await DesktopSnapshotRenderer.captureOwnedWindow(
                    sheet,
                    output: output,
                    name: captureName,
                    appearance: appearance,
                    requireActive: true
                )
                XCTAssertTrue(window.attachedSheet === sheet && sheet.sheetParent === window)
                XCTAssertTrue(keep.accessibilityPerformPress())
                try await wait { flow.preview == nil && window.attachedSheet == nil }
                XCTAssertTrue(commands.isEmpty, "Actual Keep dismissal must never invoke removal")
            }
        }
    }
}
