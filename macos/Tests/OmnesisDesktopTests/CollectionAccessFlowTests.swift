// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class CollectionAccessFlowTests: XCTestCase {
    private func api() throws -> DesktopAPI {
        let connection = try JSONDecoder().decode(
            DesktopConnection.self,
            from: Data(#"{"url":"http://localhost","token":"fixture-token","collectorDeviceId":"fixture-device"}"#.utf8)
        )
        return try DesktopAPI(connection: connection)
    }

    private let target = DesktopAccessTarget(
        descriptorId: "invented",
        deviceId: "fixture-device",
        sourceId: "fictional-source",
        accountId: "Fictional notebook",
        params: [:]
    )
    private func evidence(
        _ status: String,
        digest: String = String(repeating: "a", count: 64),
        date: String = "2030-01-01T12:00:00Z",
        publicationGuard: String? = nil
    ) throws
        -> DesktopPermissionObservation {
        try JSONDecoder().decode(DesktopPermissionObservation.self, from: JSONSerialization.data(withJSONObject: [
            "deviceId": "fixture-device", "descriptorId": "invented", "sourceId": "fictional-source", "scopeDigest": digest,
            "checkedAt": date, "status": status, "target": "unverified",
            "publicationGuard": publicationGuard as Any? ?? NSNull(),
            "requirements": [[
                "id": "chosen-information",
                "kind": "protected-files",
                "summary": "Read the chosen information",
                "scope": "Only the selected notebook",
                "blocking": true,
                "actions": [
                    ["kind": "open-system-settings", "category": "privacy-security"],
                    ["kind": "retry-access"],
                    ["kind": "restart-collector"],
                ],
            ]],
        ]))
    }

    private func wait(_ condition: () -> Bool) async throws {
        let end = ContinuousClock.now + .seconds(3)
        while ContinuousClock.now < end {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw URLError(.timedOut)
    }

    func testConcurrentChecksCoalesceAndCancelledOldSuccessCannotClearNewDenial() async throws {
        var continuations: [CheckedContinuation<DesktopPermissionObservation, Error>] = []
        let flow = DesktopCollectionAccessFlow { _, _ in try await withCheckedThrowingContinuation { continuations.append($0) } }
        defer { for continuation in continuations {
            continuation.resume(throwing: CancellationError())
        }
        flow.cancel()
        }
        let api = try api()
        flow.configure(target, api: api)
        let first = Task { await flow.check(api: api) }
        try await wait { continuations.count == 1 }
        var duplicateCompleted = false
        var duplicateEntered = false
        let duplicate = Task { duplicateEntered = true
            await flow.check(api: api)
            duplicateCompleted = true
        }
        try await wait { duplicateEntered }
        XCTAssertFalse(duplicateCompleted, "A joined check must await the applied result")
        XCTAssertEqual(continuations.count, 1)
        let replacement = DesktopAccessTarget(
            descriptorId: target.descriptorId,
            deviceId: target.deviceId,
            sourceId: target.sourceId,
            accountId: "Another fictional notebook",
            params: [:]
        )
        flow.configure(replacement, api: api)
        let second = Task { await flow.check(api: api) }
        try await wait { continuations.count == 2 }
        try continuations.removeLast().resume(returning: evidence("denied"))
        await second.value
        try continuations.removeFirst().resume(returning: evidence("readable"))
        await first.value
        await duplicate.value
        XCTAssertEqual(flow.state, .denied)
        XCTAssertTrue(flow.unresolvedDenial)
        XCTAssertFalse(flow.allowsCollection)
    }

    func testJoinedCheckReturnsOnlyAfterFreshAllowedEvidenceWasApplied() async throws {
        var pending: CheckedContinuation<DesktopPermissionObservation, Error>?
        let flow = DesktopCollectionAccessFlow { _, _ in try await withCheckedThrowingContinuation { pending = $0 } }
        let api = try api()
        flow.configure(target, api: api)
        let first = Task { await flow.check(api: api) }
        defer {
            first.cancel()
            if let remaining = pending { pending = nil
                remaining.resume(throwing: CancellationError())
            }
        }
        try await wait { pending != nil }
        var joinedEntered = false
        let joined = Task { joinedEntered = true
            await flow.check(api: api)
            return flow.allowsCollection
        }
        try await wait { joinedEntered }
        let allowed = try evidence("readable")
        let reply = try XCTUnwrap(pending)
        pending = nil
        reply.resume(returning: allowed)
        let applied = await joined.value
        await first.value
        XCTAssertTrue(applied, "A source gate joining foreground verification must observe its applied result")
    }

    func testImmediateSecondForegroundCheckCanObserveARealPermissionChange() async throws {
        var next = try evidence("readable")
        let flow = DesktopCollectionAccessFlow { _, _ in next }
        let api = try api()
        flow.configure(target, api: api)
        await flow.foreground(api: api)
        XCTAssertTrue(flow.allowsCollection)
        next = try evidence("denied", date: "2030-01-01T12:01:00Z")
        await flow.foreground(api: api)
        XCTAssertEqual(flow.state, .denied)
        XCTAssertFalse(flow.allowsCollection)
    }

    func testPriorDenialCannotBeClearedByUnavailableOrSettingsNavigation() async throws {
        var next = try evidence("denied")
        let flow = DesktopCollectionAccessFlow { _, _ in next }
        let api = try api()
        flow.configure(target, api: api)
        await flow.check(api: api)
        flow.navigationMessage = "Settings opened"
        XCTAssertFalse(flow.allowsCollection)
        next = try evidence("unavailable")
        await flow.check(api: api)
        XCTAssertTrue(flow.unresolvedDenial)
        XCTAssertFalse(flow.allowsCollection)
        next = try evidence("readable", date: "2030-01-01T12:02:00Z")
        await flow.check(api: api)
        XCTAssertFalse(flow.unresolvedDenial)
        XCTAssertTrue(flow.allowsCollection)
    }

    func testChangedSourceContextDropsPositiveEvidenceWhileKeepingAnUnresolvedDenial() async throws {
        var next = try evidence("readable")
        let flow = DesktopCollectionAccessFlow { _, _ in next }
        let api = try api()
        flow.configure(target, api: api)
        await flow.check(api: api)
        XCTAssertTrue(flow.allowsCollection)
        flow.invalidateEvidenceKeepingDenial()
        XCTAssertFalse(flow.allowsCollection, "An actual configuration change cannot retain an earlier scope approval")
        XCTAssertNil(flow.observation)
        next = try evidence("denied")
        await flow.check(api: api)
        XCTAssertTrue(flow.unresolvedDenial)
        flow.invalidateEvidenceKeepingDenial()
        XCTAssertTrue(flow.unresolvedDenial, "A monitoring restart must not erase known negative evidence")
        XCTAssertFalse(flow.allowsCollection)
    }

    func testFreshScopedLossInvalidatesApprovalButOldLossCannotOverrideFreshRegrant() async throws {
        let readable = try evidence("readable")
        let flow = DesktopCollectionAccessFlow { _, _ in readable }
        let api = try api()
        flow.configure(target, api: api)
        await flow.check(api: api)
        flow.observeDenial(scopeDigest: readable.scopeDigest, checkedAt: "2030-01-01T12:01:00Z")
        XCTAssertEqual(flow.state, .denied)
        XCTAssertFalse(flow.allowsCollection)
        let refreshed = DesktopCollectionAccessFlow { _, _ in try self.evidence("readable", date: "2030-01-01T12:02:00Z") }
        refreshed.configure(target, api: api)
        await refreshed.check(api: api)
        refreshed.observeDenial(scopeDigest: readable.scopeDigest, checkedAt: "2030-01-01T12:01:00Z")
        XCTAssertTrue(refreshed.allowsCollection)
        XCTAssertTrue(refreshed.memberAccessProblem, "A root-level check cannot clear a known nested collection failure")
        refreshed.observeSuccessfulCollection()
        XCTAssertFalse(refreshed.memberAccessProblem, "Only the affected member’s successful collection clears its retained problem")
    }

    func testMetadataRefreshRetainsKnownMemberFailureUntilSuccessfulCollection() throws {
        let api = try api()
        let registry = DesktopCollectionAccessRegistry()
        registry.configure(targets: [target], api: api, context: "first-roster")
        let original = try XCTUnwrap(registry.flows[target.id])
        original.observeDenial(scopeDigest: String(repeating: "a", count: 64), checkedAt: "2030-01-01T12:01:00Z")
        registry.configure(targets: [target], api: api, context: "refreshed-roster")
        XCTAssertTrue(registry.flows[target.id] === original)
        XCTAssertTrue(original.memberAccessProblem)
        XCTAssertFalse(registry.ready)
        original.observeSuccessfulCollection()
        XCTAssertFalse(original.memberAccessProblem)
        try registry.configure(targets: [target], api: self.api(), context: "different-library")
        XCTAssertFalse(registry.flows[target.id] === original)
    }

    func testRestartAcknowledgementAlwaysNeedsFreshCollectorEvidence() async throws {
        var probes = 0
        let flow = DesktopCollectionAccessFlow { _, _ in probes += 1
            return try self.evidence("denied")
        }
        let api = try api()
        flow.configure(target, api: api)
        await flow.restartCollector(api: api) {
            .object([
                "kind": .string("desktopCollectorRestart"),
                "status": .string("ready"),
                "deviceId": .string("fixture-device"),
                "permissionRecheckRequired": .bool(true),
            ])
        }
        XCTAssertEqual(probes, 1)
        XCTAssertEqual(flow.state, .denied)
        XCTAssertFalse(flow.allowsCollection)
    }

    func testTrialControlRequiresActualRecognizedCollectorPublicationGuard() async throws {
        let api = try api()
        let store = DesktopStore(startRuntime: false)
        store.api = api
        for guardValue in [nil, "future-v2", "managed-v1"] as [String?] {
            let observation = try evidence("unavailable", publicationGuard: guardValue)
            let flow = DesktopCollectionAccessFlow { _, _ in observation }
            flow.configure(target, api: api)
            await flow.check(api: api)
            let hosting = NSHostingView(rootView: DesktopCollectionAccessCard(
                flow: flow, requirements: observation.requirements, computer: "Example Mac", local: true,
                check: {}, continueUnverified: {}
            ).environment(store).omnesisTheme())
            hosting.frame = NSRect(x: 0, y: 0, width: 700, height: 600)
            let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = hosting
            window.makeKeyAndOrderFront(nil)
            try await DesktopAccessibilityDriver.materializeOwnedApplication()
            let end = ContinuousClock.now + .seconds(2)
            while hosting.accessibilityChildren()?.isEmpty != false, ContinuousClock.now < end {
                hosting.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(10))
            }
            let controls = try DesktopAccessibilityDriver.elements(in: hosting)
            XCTAssertEqual(controls.contains { $0.accessibilityIdentifier() == "collection-access-try" }, guardValue == "managed-v1")
            flow.cancel()
            window.close()
        }
    }

    func testGuardWithoutActualBlockingRequirementsCannotAuthorizeATrial() async throws {
        let api = try api()
        for requirements in [
            "null",
            "[]",
            #"[{"id":"optional","kind":"selected-folder","summary":"Optional files","scope":"Selected root","blocking":false,"actions":[]}]"#,
        ] {
            let observation = try JSONDecoder().decode(DesktopPermissionObservation.self, from: Data(
                #"{"deviceId":"fixture-device","descriptorId":"invented","sourceId":"fictional-source","scopeDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","checkedAt":"2030-01-01T12:00:00Z","status":"unavailable","target":"unverified","publicationGuard":"managed-v1","requirements":\#(requirements)}"#
                    .utf8
            ))
            let flow = DesktopCollectionAccessFlow { _, _ in observation }
            flow.configure(target, api: api)
            await flow.check(api: api)
            XCTAssertFalse(flow.hasManagedPublicationGuard)
            XCTAssertFalse(flow.allowsCollection)
        }
    }

    func testMountedCardForegroundLossAndFreshRegrantPreserveTheDraftAndNeverGrantFromSettingsOpened() async throws {
        var next = try evidence("readable")
        var probes = 0
        let flow = DesktopCollectionAccessFlow { _, _ in probes += 1
            return next
        }
        let api = try api()
        flow.configure(target, api: api)
        await flow.check(api: api)
        let store = DesktopStore(startRuntime: false)
        store.api = api
        let descriptor = try JSONDecoder().decode(
            DesktopDescriptor.self,
            from: Data(
                #"{"id":"invented","name":"Fictional source","description":"A chosen notebook","hasAuthFlow":false,"hasDiscover":false,"permissionRequirements":[]}"#
                    .utf8
            )
        )
        let draft = store.sourceDraft(descriptor, api: api)
        draft.params = ["chosenFolder": "/tmp/fictional-notebook"]
        draft.accounts = ["Fictional notebook"]
        let hosting = NSHostingView(rootView: DesktopCollectionAccessCard(
            flow: flow,
            requirements: next.requirements,
            computer: "This Mac",
            local: true,
            check: { await flow.check(api: api) },
            navigate: { .requestedCategoryOpened }
        ).environment(store).omnesisTheme())
        hosting.frame = NSRect(x: 0, y: 0, width: 640, height: 580)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        defer { flow.cancel()
            window.close()
        }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        hosting.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        try await wait {
            (try? DesktopAccessibilityDriver.elements(in: hosting).contains {
                $0.accessibilityIdentifier() == "collection-access-check"
            }) == true
        }
        let initialProbes = probes
        next = try evidence("denied", date: "2030-01-01T12:01:00Z")
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        do {
            try await wait { flow.state == .denied }
        } catch {
            let evidence = "stage=foreground-loss probes=\(probes) initialProbes=\(initialProbes) state=\(flow.state) sameAPI=\(store.api === api)"
            try evidence.write(
                to: URL(fileURLWithPath: "/tmp/omnesis-macos-snapshots/access-foreground-state.txt"),
                atomically: true,
                encoding: .utf8
            )
            XCTFail(evidence)
            throw error
        }
        XCTAssertGreaterThan(probes, initialProbes, "A mounted return from Settings must check current collector access")
        XCTAssertFalse(flow.allowsCollection)
        try DesktopAccessibilityDriver.press("collection-access-settings", in: hosting)
        XCTAssertEqual(flow.state, .denied, "Opening Settings is navigation, never a grant")
        XCTAssertTrue(store.sourceDraft(descriptor, api: api) === draft)
        XCTAssertEqual(draft.params["chosenFolder"], "/tmp/fictional-notebook")
        XCTAssertEqual(draft.accounts, ["Fictional notebook"])
        next = try evidence("readable", date: "2030-01-01T12:02:00Z")
        try DesktopAccessibilityDriver.press("collection-access-check", in: hosting)
        try await wait { flow.allowsCollection }
        XCTAssertEqual(store.sources.count, 0, "Checking access must not register, erase or replace indexed sources")
    }

    func testNeededCheckingAndPartialAccessRendersDoNotPromiseSetupCompletion() async throws {
        let api = try api()
        var pending: CheckedContinuation<DesktopPermissionObservation, Error>?
        let checking = DesktopCollectionAccessFlow { _, _ in try await withCheckedThrowingContinuation { pending = $0 } }
        checking.configure(target, api: api)
        try await DesktopSnapshotRenderer.render(
            DesktopCollectionAccessCard(flow: checking, requirements: nil, computer: "This Mac", local: true, check: {})
                .environment(DesktopStore.preview()),
            name: "access-needed",
            size: CGSize(width: 700, height: 460)
        )
        let request = Task { await checking.check(api: api) }
        defer { request.cancel()
            if let continuation = pending { continuation.resume(throwing: CancellationError()) }
        }
        try await wait { pending != nil }
        try await DesktopSnapshotRenderer.render(
            DesktopCollectionAccessCard(flow: checking, requirements: nil, computer: "This Mac", local: true, check: {})
                .environment(DesktopStore.preview()),
            name: "access-checking",
            size: CGSize(width: 700, height: 460)
        )
        let denied = try evidence("denied")
        let continuation = try XCTUnwrap(pending)
        pending = nil
        continuation.resume(returning: denied)
        await request.value
        let available = DesktopCollectionAccessFlow { _, _ in try self.evidence("readable") }
        available.configure(target, api: api)
        await available.check(api: api)
        try await DesktopSnapshotRenderer.render(ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Some chosen sources need attention").font(.title2)
                DesktopCollectionAccessCard(flow: available, requirements: nil, computer: "This Mac", local: true, check: {})
                DesktopCollectionAccessCard(flow: checking, requirements: nil, computer: "This Mac", local: true, check: {})
            }.padding(24)
        }.environment(DesktopStore.preview()), name: "access-partial", size: CGSize(width: 740, height: 760))
        XCTAssertTrue(available.allowsCollection)
        XCTAssertFalse(checking.allowsCollection)
    }

    func testPermissionStateRendersAndPartialSourceReadiness() async throws {
        let api = try api()
        for status in ["readable", "denied", "unavailable", "unsupported"] {
            let observation = try evidence(status)
            let flow = DesktopCollectionAccessFlow { _, _ in observation }
            flow.configure(target, api: api)
            await flow.check(api: api)
            try await DesktopSnapshotRenderer.render(
                DesktopCollectionAccessCard(
                    flow: flow,
                    requirements: observation.requirements,
                    computer: status == "unavailable" ? "Fictional library Mac" : "This Mac",
                    local: status != "unavailable",
                    check: {}
                ).environment(DesktopStore.preview()),
                name: "access-" + status,
                size: CGSize(width: 700, height: 640)
            )
        }
    }
}
