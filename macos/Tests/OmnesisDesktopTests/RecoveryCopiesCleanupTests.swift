// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class RecoveryCopiesCleanupTests: XCTestCase {
    private let selected = "11111111-1111-4111-8111-111111111111"
    private let keeper = "22222222-2222-4222-8222-222222222222"
    private let operation = "33333333-3333-4333-8333-333333333333"
    private let token = String(repeating: "a", count: 64)
    private func value(_ object: [String: Any]) throws -> BridgeValue {
        try JSONDecoder().decode(BridgeValue.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func summary(_ id: String) -> [String: Any] {
        [
            "id": id,
            "purpose": "update",
            "oldVersion": "1.2.3",
            "registeredAt": "2030-01-01T12:00:00.000Z",
            "bytes": 1024,
            "order": id == selected ? 1 : 2,
        ]
    }

    private func list(pending: String? = nil, present: Bool = true, bound: Bool = true) throws -> BridgeValue {
        var rows = [[String: Any]]()
        if present { rows.append(summary(selected).merging([
            "pinned": false,
            "order": 1,
            "disposition": "redundant-snapshot",
            "canReview": true,
        ]) { _, new in new }) }
        rows.append(summary(keeper).merging(["pinned": true, "order": 2, "disposition": "pinned", "canReview": false]) { _, new in new })
        var intent: [String: Any] = ["id": operation, "phase": pending ?? "planned", "canCancel": pending != "deleting"]
        if bound { intent.merge(["snapshotId": selected, "staging": false, "mode": "redundant-snapshot", "keeperId": keeper]) { _, new in
            new
        } }
        return try value([
            "kind": "desktopRecoveryCopies",
            "limit": 16,
            "items": rows,
            "partialCopies": [],
            "pending": pending == nil ? NSNull() : intent,
            "unregisteredCopies": 0,
        ])
    }

    private func catalog(_ value: BridgeValue) throws -> DesktopRecoveryCopiesCatalog {
        try JSONDecoder().decode(DesktopRecoveryCopiesCatalog.self, from: JSONEncoder().encode(value))
    }

    private func review(id: String? = nil, authoritative: Bool = true) throws -> BridgeValue {
        var object: [String: Any] = [
            "kind": "desktopRecoveryCleanup",
            "phase": "preview",
            "id": id ?? selected,
            "confirmationId": token,
            "bytes": 1024,
            "mode": "redundant-snapshot",
            "message": "Remove this automatic recovery copy. Personal backups and exports are kept.",
        ]
        if authoritative { object["selected"] = summary(id ?? selected)
            object["keeper"] = summary(keeper)
        }
        return try value(object)
    }

    private func removed(id: String? = nil) throws -> BridgeValue {
        try value(["kind": "desktopRecoveryCleanup", "phase": "removed", "id": id ?? selected, "operationId": operation, "bytes": 1024])
    }

    private func waitFor(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition(), ContinuousClock.now < deadline {
            do { try await Task.sleep(for: .milliseconds(10)) } catch { return false }
        }
        return condition()
    }

    func testActualVersionOneBridgeEnvelopesKeepCleanupRepliesSeparateFromLibraryReadiness() throws {
        for result in try [review(), removed(), list(pending: "planned")] {
            let frame = BridgeValue.object(["version": .number(1), "id": .string("fixture-cleanup"), "ok": .bool(true), "result": result])
            let envelope = try JSONDecoder().decode(BridgeEnvelope.self, from: JSONEncoder().encode(frame))
            XCTAssertEqual(envelope.rawResult, result)
            XCTAssertNil(envelope.result)
            XCTAssertNil(envelope.state)
        }
    }

    func testPreviewShowsTheAuthoritativeKeeperAndRemovalRequiresConfirmedReplyAndFreshAbsence() async throws {
        let initial = try catalog(list()), preview = try review(), outcome = try removed(), fresh = try list(present: false)
        var calls = [String]()
        let flow = DesktopRecoveryCopiesFlow(catalog: initial) { name, params in
            calls.append(name)
            switch name {
            case "recoveryCopyPreview":
                XCTAssertEqual(params, ["id": .string(self.selected), "incompleteStaging": .bool(false)])
                return preview
            case "recoveryCopyRemove":
                XCTAssertEqual(
                    params,
                    ["id": .string(self.selected), "incompleteStaging": .bool(false), "confirmationId": .string(self.token)]
                )
                return outcome
            default: XCTAssertEqual(name, "recoveryCopies")
                return fresh
            }
        }
        await flow.review(selected)
        XCTAssertEqual(flow.preview?.keeper?.id, keeper)
        XCTAssertNotEqual(flow.preview?.selected?.label, flow.preview?.keeper?.label)
        XCTAssertTrue(flow.preview?.selected?.label.hasPrefix("Copy 1") == true)
        XCTAssertTrue(flow.preview?.keeper?.label.hasPrefix("Copy 2") == true)
        XCTAssertTrue(flow.preview?.valid == true)
        XCTAssertEqual(calls, ["recoveryCopyPreview"])
        await flow.removeReviewed(confirmationId: String(repeating: "b", count: 64))
        XCTAssertEqual(calls, ["recoveryCopyPreview"])
        await flow.removeReviewed()
        XCTAssertEqual(calls, ["recoveryCopyPreview", "recoveryCopyRemove", "recoveryCopies"])
        XCTAssertNil(flow.error)
        XCTAssertEqual(flow.notice, "Automatic recovery copy removed.")
        XCTAssertEqual(flow.catalog?.items.map(\.id), [keeper])
        XCTAssertTrue(flow.catalog?.items.first?.pinned == true)
    }

    func testOlderOrSwappedPreviewCannotEnableRemovalAndDismissalSendsNoMutation() async throws {
        for response in try [review(authoritative: false), review(id: keeper)] {
            let flow = try DesktopRecoveryCopiesFlow(catalog: catalog(list())) { _, _ in response }
            await flow.review(selected)
            XCTAssertNil(flow.preview)
            XCTAssertNotNil(flow.error)
            await flow.removeReviewed()
            XCTAssertNil(flow.notice)
        }
        var calls = [String]()
        let response = try review()
        let flow = try DesktopRecoveryCopiesFlow(catalog: catalog(list())) { name, _ in calls.append(name)
            return response
        }
        await flow.review(selected)
        flow.dismissReview()
        await flow.removeReviewed()
        XCTAssertEqual(calls, ["recoveryCopyPreview"])
    }

    func testMissingRefreshOrContradictoryListNeverClaimsAConfirmedRemoval() async throws {
        for unavailable in [false, true] {
            let initial = try list(), preview = try review(), outcome = try removed()
            let flow = try DesktopRecoveryCopiesFlow(catalog: catalog(initial)) { name, _ in
                if name == "recoveryCopyPreview" { return preview }
                if name == "recoveryCopyRemove" { return outcome }
                if unavailable { throw DesktopRecoveryCopiesFlow.Failure("Fixture unavailable") }
                return initial
            }
            await flow.review(selected)
            await flow.removeReviewed()
            XCTAssertNil(flow.notice)
            XCTAssertNotNil(flow.error)
            XCTAssertEqual(flow.catalogCurrent, !unavailable)
            XCTAssertEqual(flow.catalog?.items.first?.id, selected)
        }
    }

    func testCancellationWaitsForTheOriginalOperationToDrainThenObservesPendingDeletion() async throws {
        let initial = try catalog(list()), preview = try review(), pending = try list(pending: "deleting")
        var continuation: CheckedContinuation<BridgeValue, Error>?
        var commands = [String]()
        let flow = DesktopRecoveryCopiesFlow(catalog: initial) { name, _ in
            commands.append(name)
            if name == "recoveryCopyPreview" { return preview }
            if name == "recoveryCopyRemove" { return try await withCheckedThrowingContinuation { continuation = $0 } }
            return pending
        }
        await flow.review(selected)
        let work = Task { await flow.removeReviewed() }
        guard await waitFor({ continuation != nil }) else {
            work.cancel()
            await work.value
            return XCTFail("The fixture removal request did not start")
        }
        flow.cancelActive()
        await Task.yield()
        XCTAssertTrue(flow.busy)
        XCTAssertTrue(flow.stopping)
        XCTAssertFalse(commands.contains("recoveryCopies"))
        continuation?.resume(throwing: CancellationError())
        await work.value
        XCTAssertFalse(flow.busy)
        XCTAssertEqual(commands.last, "recoveryCopies")
        XCTAssertEqual(flow.catalog?.pending?.phase, .deleting)
        XCTAssertNil(flow.notice)
        XCTAssertNotNil(flow.error)
    }

    func testRetryAndCancelUseOnlyTheAuthoritativePendingIdentityAndNeverUnfenceDeleting() async throws {
        let pending = try list(pending: "deleting"), outcome = try removed(), fresh = try list(present: false)
        var commands = [String]()
        let flow = try DesktopRecoveryCopiesFlow(catalog: catalog(pending)) { name, params in
            commands.append(name)
            if name == "recoveryCopyRetry" { XCTAssertEqual(params, ["operationId": .string(self.operation)])
                return outcome
            }
            return fresh
        }
        await flow.retryPending(expectedId: self.keeper)
        await flow.cancelPending(expectedId: self.keeper)
        await flow.cancelPending()
        XCTAssertTrue(commands.isEmpty)
        await flow.retryPending()
        XCTAssertEqual(commands, ["recoveryCopyRetry", "recoveryCopies"])
        XCTAssertNotNil(flow.notice)
        let old = try DesktopRecoveryCopiesFlow(catalog: catalog(list(pending: "planned", bound: false))) { _, _ in
            XCTFail("An unbound old reply cannot authorize cleanup")
            return .null
        }
        await old.retryPending()
        await old.cancelPending()
        XCTAssertNil(old.notice)
    }

    func testPlannedCancellationNeedsAnAcknowledgementAndASecondFreshCatalog() async throws {
        let pending = try catalog(list(pending: "planned")), kept = try list()
        var names = [String]()
        let flow = DesktopRecoveryCopiesFlow(catalog: pending) { name, params in
            names.append(name)
            if name == "recoveryCopyCancel" { XCTAssertEqual(params, ["operationId": .string(self.operation)]) }
            return kept
        }
        await flow.cancelPending()
        XCTAssertEqual(names, ["recoveryCopyCancel", "recoveryCopies"])
        XCTAssertNotNil(flow.notice)
        XCTAssertEqual(flow.catalog?.items.first?.id, selected)
    }

    func testCancelAcknowledgementCannotClaimTheCopyWasKeptWhenTheFreshListLostIt() async throws {
        let pending = try catalog(list(pending: "planned")), absent = try list(present: false)
        let flow = DesktopRecoveryCopiesFlow(catalog: pending) { _, _ in absent }
        await flow.cancelPending()
        XCTAssertNil(flow.notice)
        XCTAssertNotNil(flow.error)
    }

    func testActualConfirmationRequiresTheCheckboxBeforeSendingTheBoundRemoval() async throws {
        let preview = try JSONDecoder().decode(DesktopRecoveryCleanupPreview.self, from: JSONEncoder().encode(review()))
        let outcome = try removed(), fresh = try list(present: false)
        var commands = [String]()
        let flow = try DesktopRecoveryCopiesFlow(catalog: catalog(list()), preview: preview) { name, params in
            commands.append(name)
            if name == "recoveryCopyRemove" {
                XCTAssertEqual(params["confirmationId"], .string(self.token))
                XCTAssertEqual(params["id"], .string(self.selected))
                return outcome
            }
            return fresh
        }
        let hosting = NSHostingView(rootView: DesktopRecoveryCopyConfirmation(flow: flow, preview: preview).omnesisTheme())
        hosting.frame = NSRect(x: 0, y: 0, width: 700, height: 560)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(150))
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        XCTAssertFalse(try DesktopAccessibilityDriver.element("confirm-remove-recovery-copy", in: hosting).isAccessibilityEnabled())
        XCTAssertTrue(commands.isEmpty)
        try DesktopAccessibilityDriver.press("confirm-recovery-copy-understood", in: hosting)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(try DesktopAccessibilityDriver.element("confirm-remove-recovery-copy", in: hosting).isAccessibilityEnabled())
        try DesktopAccessibilityDriver.press("confirm-remove-recovery-copy", in: hosting)
        let deadline = ContinuousClock.now + .seconds(3)
        while flow.notice == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(commands, ["recoveryCopyRemove", "recoveryCopies"])
        XCTAssertEqual(flow.notice, "Automatic recovery copy removed.")
    }

    func testLoadingReviewRenderShowsItsRealStopControl() async throws {
        var continuation: CheckedContinuation<BridgeValue, Error>?
        let flow = try DesktopRecoveryCopiesFlow(catalog: catalog(list())) { _, _ in
            try await withCheckedThrowingContinuation { continuation = $0 }
        }
        let work = Task { await flow.review(selected) }
        guard await waitFor({ continuation != nil }) else {
            work.cancel()
            await work.value
            return XCTFail("The fixture review request did not start")
        }
        do { try await DesktopSnapshotRenderer.render(
            Form { DesktopRecoveryCopiesSection(flow: flow, loadCatalog: false) }
                .formStyle(.grouped).environment(DesktopStore(startRuntime: false)),
            name: "recovery-copy-verifying",
            size: CGSize(width: 900, height: 820)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.element("stop-recovery-cleanup", in: view).isAccessibilityEnabled())
        } } catch {
            continuation?.resume(throwing: CancellationError())
            await work.value
            throw error
        }
        continuation?.resume(throwing: CancellationError())
        await work.value
        XCTAssertNil(flow.preview)
    }

    func testConfirmationAndPendingFailureRenderActualChoices() async throws {
        let preview = try JSONDecoder().decode(DesktopRecoveryCleanupPreview.self, from: JSONEncoder().encode(review()))
        let flow = try DesktopRecoveryCopiesFlow(catalog: catalog(list()), preview: preview) { _, _ in .null }
        try await DesktopSnapshotRenderer.render(
            DesktopRecoveryCopyConfirmation(flow: flow, preview: preview),
            name: "recovery-copy-confirmation",
            size: CGSize(width: 700, height: 560)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("This newer recovery copy stays kept", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Remove copy", in: view))
        }
        let pending = try DesktopRecoveryCopiesFlow(catalog: catalog(list(pending: "deleting"))) { _, _ in
            throw DesktopRecoveryCopiesFlow.Failure("Fixture refused")
        }
        await pending.retryPending()
        try await DesktopSnapshotRenderer.render(
            Form { DesktopRecoveryCopiesSection(flow: pending, loadCatalog: false) }
                .formStyle(.grouped).environment(DesktopStore(startRuntime: false)),
            name: "recovery-copy-pending-error",
            size: CGSize(width: 900, height: 900)
        )
    }
}
