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
}
