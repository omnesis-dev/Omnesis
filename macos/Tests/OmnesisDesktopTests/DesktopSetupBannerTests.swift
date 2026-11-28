// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class DesktopSetupBannerTests: XCTestCase {
    private final class StartupProbe {
        var status = DesktopAutomaticStartup.Status.disabled
    }

    private actor PowerProbe {
        var status = DesktopMacServerPowerObservation.Status.sleepEnabled
        func read() -> DesktopMacServerPowerObservation {
            .init(status: status)
        }

        func set(_ status: DesktopMacServerPowerObservation.Status) {
            self.status = status
        }
    }

    private func waitForMessage(_ message: String, in hosting: NSView) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            hosting.layoutSubtreeIfNeeded()
            if try DesktopAccessibilityDriver.contains(message, in: hosting) { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTFail("The mounted prerequisite message did not reflect the current check")
    }

    private func state(
        storage: String,
        route: String = "ready",
        mode: String = "home",
        identity: String? = "desktop-0000000000000001",
        expired: Bool = false
    ) throws
        -> DesktopState {
        let connection = try JSONDecoder().decode(DesktopConnection.self, from: Data(
            #"{"url":"https://gateway.example.test","token":"invented-fixture"}"#.utf8
        ))
        let deadline = floor(Date().timeIntervalSince1970 * 1000) + (expired ? -1000 : 60000)
        return DesktopState(
            phase: .ready,
            mode: mode,
            connection: connection,
            encrypted: true,
            installationId: identity,
            storageAdmission: .init(state: storage, validUntil: deadline),
            remoteRoute: .init(
                state: route,
                validUntil: deadline
            )
        )
    }

    func testBannerTracksActualFirstRepairAsHigherPriorityChecksRecover() async throws {
        let startupProbe = StartupProbe(), powerProbe = PowerProbe()
        let startup = DesktopAutomaticStartup(read: { startupProbe.status }, register: {})
        let power = DesktopMacServerPowerFlow(probe: { await powerProbe.read() })
        let store = DesktopStore(
            startRuntime: false,
            runtimeBridge: RuntimeBridge(preparation: { _ in throw CancellationError() }),
            automaticStartup: startup,
            serverPower: power,
            nativeOwnerVerified: true,
            monitorPrerequisites: false
        )
        store.state = try state(storage: "blocked")
        store.destination = .sources
        startup.refresh()
        await power.refresh()
        XCTAssertEqual(DesktopSetupRepair.first(in: store), .startup)
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Automatic startup is required")
        let hosting = NSHostingView(rootView: DesktopRootView().environment(store))
        hosting.frame = NSRect(x: 0, y: 0, width: 1000, height: 740)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try await waitForMessage("Automatic startup is required", in: hosting)
        startupProbe.status = .enabled
        startup.refresh()
        XCTAssertEqual(DesktopSetupRepair.first(in: store), .power)
        try await waitForMessage("Keep this Mac awake for your library", in: hosting)
        await powerProbe.set(.ready)
        await power.refresh()
        XCTAssertEqual(DesktopSetupRepair.first(in: store), .storage)
        try await waitForMessage("Collection needs more storage", in: hosting)
        try await DesktopSnapshotRenderer.render(
            DesktopRootView().environment(store),
            name: "setup-first-repair-message",
            size: CGSize(width: 1000, height: 740)
        ) { rendered in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Collection needs more storage", in: rendered))
            try DesktopAccessibilityDriver.press("required-setup-review", in: rendered)
            XCTAssertEqual(store.destination, .setup)
            store.destination = .sources
        }
    }

    func testUnknownExpiredStorageAndUnverifiedIdentityNeverInventADiskOrNetworkFailure() async throws {
        let startup = DesktopAutomaticStartup(read: { .enabled }, register: {})
        let power = DesktopMacServerPowerFlow(probe: { .init(status: .ready) })
        let store = DesktopStore(
            startRuntime: false,
            automaticStartup: startup,
            serverPower: power,
            nativeOwnerVerified: true,
            monitorPrerequisites: false
        )
        startup.refresh()
        await power.refresh()
        store.state = try state(storage: "unavailable")
        XCTAssertEqual(DesktopSetupRepair.first(in: store), .storage)
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Storage needs checking")
        store.state = try state(storage: "blocked", expired: true)
        XCTAssertEqual(store.homeServices.storage, .unavailable)
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Storage needs checking")
        store.state = try state(storage: "ready", route: "unavailable")
        XCTAssertEqual(DesktopSetupRepair.first(in: store), .route)
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Your library’s remote connection needs checking")
        store.state = try state(storage: "blocked", identity: nil)
        XCTAssertTrue(store.state.canOpenLibrary)
        XCTAssertEqual(DesktopSetupRepair.first(in: store), .connection)
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Checking this copy of Omnesis")
    }

    func testCheckingAndJoinedPrerequisitesDoNotBorrowHomeStorageOrPowerFailures() async throws {
        let probe = StartupProbe()
        let startup = DesktopAutomaticStartup(read: { probe.status }, register: {})
        let power = DesktopMacServerPowerFlow(probe: { .init(status: .sleepEnabled) })
        let store = DesktopStore(
            startRuntime: false,
            automaticStartup: startup,
            serverPower: power,
            nativeOwnerVerified: true,
            monitorPrerequisites: false
        )
        store.state = try state(storage: "blocked", mode: "joined")
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Checking automatic startup")
        probe.status = .approvalRequired
        startup.refresh()
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Approve automatic startup in Settings")
        probe.status = .enabled
        startup.refresh()
        await power.refresh()
        XCTAssertNotEqual(DesktopSetupRepair.first(in: store), .power)
        XCTAssertNotEqual(DesktopSetupRepair.first(in: store), .storage)
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Checking this computer’s collection connection")
    }

    func testKnownCollectionDenialStaysSpecificUntilThatMembersActualRecovery() throws {
        let startup = DesktopAutomaticStartup(read: { .enabled }, register: {})
        let power = DesktopMacServerPowerFlow(probe: { .init(status: .ready) })
        let store = DesktopStore(
            startRuntime: false,
            automaticStartup: startup,
            serverPower: power,
            nativeOwnerVerified: true,
            monitorPrerequisites: false
        )
        let connection = try JSONDecoder().decode(DesktopConnection.self, from: Data(
            #"{"url":"https://gateway.example.test","token":"invented-fixture","collectorDeviceId":"local"}"#.utf8
        ))
        store.state = DesktopState(
            phase: .ready,
            mode: "joined",
            connection: connection,
            encrypted: true,
            installationId: "desktop-0000000000000001"
        )
        let api = try DesktopAPI(connection: connection)
        store.api = api
        store.sources = try JSONDecoder().decode([DesktopSource].self, from: Data(
            #"[{"id":"invented:example","type":"invented","accountId":"Example account","enabled":true,"deviceId":"local","members":["local"]}]"#
                .utf8
        ))
        startup.refresh()
        let target = DesktopAccessTarget(
            descriptorId: "invented",
            deviceId: "local",
            sourceId: "invented:example",
            accountId: "Example account",
            params: [:]
        )
        store.collectionAccess.configure(targets: [target], api: api, context: store.permissionContext)
        let flow = try XCTUnwrap(store.collectionAccess.flows[target.id])
        XCTAssertEqual(DesktopSetupRepair.first(in: store), .access)
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Checking collection access")
        flow.observeDenial(scopeDigest: String(repeating: "a", count: 64), checkedAt: "2026-01-01T00:00:00Z")
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Collection access needs attention")
        flow.invalidateEvidenceKeepingDenial()
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Collection access needs attention")
        store.collectionAccess.configure(targets: [target], api: api, context: store.permissionContext + ":older-metadata")
        XCTAssertTrue(flow.memberAccessProblem)
        XCTAssertEqual(
            DesktopSetupRepair.bannerTitle(in: store),
            "Checking collection access",
            "An older scope cannot diagnose the current access check"
        )
        store.collectionAccess.configure(targets: [target], api: api, context: store.permissionContext)
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Collection access needs attention")
        flow.observeSuccessfulCollection()
        XCTAssertEqual(DesktopSetupRepair.bannerTitle(in: store), "Checking collection access")
        XCTAssertFalse(store.requiredSetupReady, "Collection recovery alone is not verification of every prerequisite")
    }
}
