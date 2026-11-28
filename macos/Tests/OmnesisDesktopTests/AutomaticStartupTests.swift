// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
@testable import OmnesisDesktop
import SwiftUI
import XCTest

@MainActor
final class AutomaticStartupTests: XCTestCase {
    func testDurableOwnedInstallationAttemptsOnceAndNeverOverridesLaterRevocation() async {
        var receipts = Set<String>()
        var calls = 0
        var status = DesktopAutomaticStartup.Status.disabled
        let scope = "desktop-0000000000000001"
        let flow = DesktopAutomaticStartup(read: { status }, register: {
            XCTAssertTrue(receipts.contains(scope), "Receipt must precede the OS request")
            calls += 1
            status = .enabled
        }, attempted: { receipts.contains($0) }, remember: { _ = receipts.insert($0) })
        flow.bindInstallation(scope)
        await flow.ensureForExplicitSetup(installationId: scope)
        XCTAssertEqual(calls, 1)
        XCTAssertTrue(flow.ready)
        status = .disabled
        flow.refresh()
        await flow.ensureForExplicitSetup(installationId: scope)
        XCTAssertEqual(calls, 1)
        XCTAssertFalse(flow.ready)
        let relaunched = DesktopAutomaticStartup(
            read: { status },
            register: { calls += 1 },
            attempted: { receipts.contains($0) },
            remember: { _ = receipts.insert($0) }
        )
        relaunched.bindInstallation(scope)
        await relaunched.ensureForExplicitSetup(installationId: scope)
        XCTAssertEqual(calls, 1, "Relaunch must retain the once-attempted receipt")
    }

    func testAlreadyEnabledOrPendingInstallationIsInitializedBeforeLaterRevocation() async {
        for initial in [DesktopAutomaticStartup.Status.enabled, .approvalRequired] {
            var receipts = Set<String>()
            var calls = 0
            var status = initial
            let scope = "desktop-0000000000000004"
            let flow = DesktopAutomaticStartup(
                read: { status },
                register: { calls += 1 },
                attempted: { receipts.contains($0) },
                remember: { _ = receipts.insert($0) }
            )
            flow.bindInstallation(scope)
            await flow.ensureForExplicitSetup(installationId: scope)
            XCTAssertTrue(receipts.contains(scope))
            XCTAssertEqual(calls, 0)
            status = .disabled
            await flow.ensureForExplicitSetup(installationId: scope)
            XCTAssertEqual(calls, 0, "Previously observed startup must never be silently re-enabled after revocation")
            XCTAssertFalse(flow.ready)
        }
    }

    func testQueuedOldInstallationCannotRebindOrRegisterAfterReplacementOrRetirement() async {
        var calls = 0
        var receipts = Set<String>()
        let first = "desktop-0000000000000001", next = "desktop-0000000000000002"
        let flow = DesktopAutomaticStartup(
            read: { .disabled },
            register: { calls += 1 },
            attempted: { receipts.contains($0) },
            remember: { _ = receipts.insert($0) }
        )
        flow.bindInstallation(first)
        let stale = Task { await flow.ensureForExplicitSetup(installationId: first) }
        flow.bindInstallation(next)
        await stale.value
        XCTAssertEqual(calls, 0)
        XCTAssertFalse(receipts.contains(first))
        await flow.ensureForExplicitSetup(installationId: next)
        XCTAssertEqual(calls, 1)
        flow.bindInstallation(nil)
        await flow.ensureForExplicitSetup(installationId: next)
        XCTAssertEqual(calls, 1)
        XCTAssertFalse(flow.ready)
    }

    func testCancelledStartupRequestHasNoOsEffectOrAttemptReceipt() async {
        var calls = 0
        var receipts = Set<String>()
        let scope = "desktop-0000000000000003"
        let flow = DesktopAutomaticStartup(
            read: { .disabled },
            register: { calls += 1 },
            attempted: { receipts.contains($0) },
            remember: { _ = receipts.insert($0) }
        )
        flow.bindInstallation(scope)
        let task = Task { await flow.ensureForExplicitSetup(installationId: scope) }
        task.cancel()
        await task.value
        XCTAssertEqual(calls, 0)
        XCTAssertTrue(receipts.isEmpty)
    }

    func testRegistrationAcknowledgementIsPendingUntilActualSystemStatusIsEnabled() async {
        var status = DesktopAutomaticStartup.Status.disabled
        let flow = DesktopAutomaticStartup(read: { status }, register: { status = .approvalRequired })
        flow.refresh()
        XCTAssertFalse(flow.ready)
        await flow.enable()
        XCTAssertEqual(flow.status, .approvalRequired)
        XCTAssertFalse(flow.ready)
        status = .enabled
        flow.refresh()
        XCTAssertTrue(flow.ready)
        status = .disabled
        flow.refresh()
        XCTAssertFalse(flow.ready, "Revocation must invalidate required setup")
    }

    func testRegistrationFailureCannotSetEnabledFromRequestedIntent() async {
        let flow = DesktopAutomaticStartup(read: { .disabled }, register: { throw URLError(.cannotConnectToHost) })
        await flow.enable()
        XCTAssertFalse(flow.ready)
        XCTAssertEqual(flow.status, .disabled)
        XCTAssertNotNil(flow.error)
    }

    func testConcurrentEnableRequestsAreCoalesced() async throws {
        var calls = 0
        var complete: CheckedContinuation<Void, Never>?
        let flow = DesktopAutomaticStartup(read: { .approvalRequired }, register: { calls += 1
            await withCheckedContinuation { complete = $0 }
        })
        let first = Task { await flow.enable() }
        let end = ContinuousClock.now + .seconds(2)
        while complete == nil, ContinuousClock.now < end {
            try await Task.sleep(for: .milliseconds(10))
        }
        await flow.enable()
        XCTAssertEqual(calls, 1)
        let continuation = try XCTUnwrap(complete)
        continuation.resume()
        await first.value
        XCTAssertFalse(flow.ready)
    }

    func testMountedRequiredStartupRefreshesOnForegroundAndOpeningSettingsCannotApproveIt() async throws {
        var status = DesktopAutomaticStartup.Status.approvalRequired
        var settingsOpened = 0
        let flow = DesktopAutomaticStartup(read: { status }, register: {})
        let hosting = NSHostingView(rootView: DesktopAutomaticStartupView(flow: flow, openSettings: { settingsOpened += 1 }).padding(24)
            .omnesisTheme())
        hosting.frame = NSRect(x: 0, y: 0, width: 600, height: 340)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(100))
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try DesktopAccessibilityDriver.press("startup-approve", in: hosting)
        XCTAssertEqual(settingsOpened, 1)
        XCTAssertFalse(flow.ready)
        status = .enabled
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        XCTAssertTrue(flow.ready)
        status = .disabled
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        XCTAssertFalse(flow.ready)
        XCTAssertEqual(flow.status, .disabled)
    }

    func testPreRuntimeRequiredRepairUsesActualNativeStatusAndNeverReopensRetiredSetup() {
        let flow = DesktopAutomaticStartup(read: { .approvalRequired }, register: {})
        let store = DesktopStore(startRuntime: false, automaticStartup: flow)
        flow.refresh()
        store.failure = "The fictional runtime is unavailable"
        XCTAssertTrue(store.startupRepairRequired)
        store.backgroundStartupBlock = .helperUnavailable
        XCTAssertTrue(store.startupRepairRequired)
        store.state = DesktopState(phase: .waiting, retired: true)
        XCTAssertFalse(store.startupRepairRequired)
        store.failure = nil
        XCTAssertFalse(store.startupRepairRequired)
    }

    func testNativeOwnerMismatchKeepsPortableReadyFromCompletingSetup() throws {
        let flow = DesktopAutomaticStartup(read: { .enabled }, register: {})
        let bridge = RuntimeBridge()
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, automaticStartup: flow, nativeOwnerVerified: true)
        store.state = try JSONDecoder().decode(
            DesktopState.self,
            from: Data(
                #"{"phase":"ready","mode":"joined","encrypted":true,"installationId":"desktop-0000000000000001","connection":{"url":"http://localhost","token":"fixture-only"}}"#
                    .utf8
            )
        )
        bridge.onStartupBlocked?(.ownerMismatch)
        XCTAssertFalse(store.nativeOwnerReady)
        XCTAssertFalse(store.state.canOpenLibrary)
        XCTAssertNil(store.api)
        XCTAssertFalse(store.requiredSetupReady)
        XCTAssertTrue(store.requiredSetupNeedsAction)
        let ready = try JSONDecoder().decode(
            BridgeEnvelope.self,
            from: Data(
                #"{"version":1,"id":"fixture-ready","ok":true,"result":{"phase":"ready","mode":"joined","encrypted":true,"installationId":"desktop-0000000000000001","connection":{"url":"http://localhost","token":"fixture-only"}}}"#
                    .utf8
            )
        )
        bridge.onEnvelope?(ready)
        XCTAssertEqual(store.backgroundStartupBlock, .ownerMismatch)
        XCTAssertFalse(store.state.canOpenLibrary)
        XCTAssertNil(store.api)
        store.backgroundStartupBlock = nil
        XCTAssertFalse(store.nativeOwnerReady, "Clearing presentation alone cannot verify the owner")
        bridge.onStartupBlocked?(nil)
        XCTAssertTrue(store.nativeOwnerReady, "Only the authenticated native callback confirms the owner")
        XCTAssertFalse(store.state.canOpenLibrary, "A fresh runtime status is still required")
    }

    func testRetainedApplicationCannotBecomeInstalledFromStartupOrPortableReady() async throws {
        let bridge = RuntimeBridge()
        let flow = DesktopAutomaticStartup(read: { .enabled }, register: {})
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, automaticStartup: flow, nativeOwnerVerified: true)
        let epoch = String(repeating: "a", count: 64)
        store.state = DesktopState(phase: .waiting, installationId: "desktop-0000000000000001")
        bridge.onApplicationOwnership?(.init(
            state: .verified,
            codeEpoch: epoch,
            originEpoch: epoch,
            presentation: .retained,
            installation: .recoveredVersionInstallNeeded,
            installationId: "desktop-0000000000000001"
        ))
        flow.refresh()
        XCTAssertTrue(flow.ready)
        XCTAssertFalse(store.applicationInstallationCurrent)
        XCTAssertFalse(store.requiredSetupReady)
        XCTAssertTrue(store.requiredSetupNeedsAction)
        try await DesktopSnapshotRenderer.render(
            DesktopStartupPrerequisiteView().environment(store),
            name: "startup-recovered-install-needed",
            size: CGSize(width: 620, height: 340)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Automatic startup will be checked after installation", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Starts automatically when you sign in", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.elements(in: view).contains {
                $0.accessibilityIdentifier() == "startup-enable"
            })
        }
        bridge.onStartupBlocked?(nil)
        XCTAssertFalse(store.applicationInstallationCurrent, "An enabled login item and control connection cannot install a retained app")
        bridge.onApplicationOwnership?(.init(
            state: .verified,
            codeEpoch: epoch,
            originEpoch: epoch,
            presentation: .installedOrigin,
            installation: .current,
            installationId: "desktop-0000000000000001"
        ))
        XCTAssertTrue(store.applicationInstallationCurrent, "Only native authenticated installed-origin evidence changes this requirement")
        XCTAssertFalse(store.requiredSetupReady, "The remaining library prerequisites still need their own evidence")
    }

    func testPreRuntimeRepairNeedsNoInstallationAndRetryDoesNotGrantApproval() async throws {
        var retries = 0
        var registrations = 0
        let flow = DesktopAutomaticStartup(read: { .approvalRequired }, register: { registrations += 1 })
        let hosting = NSHostingView(rootView: DesktopStartupRepairView(flow: flow, retry: { retries += 1 }, openSettings: {}).padding(24)
            .omnesisTheme())
        hosting.frame = NSRect(x: 0, y: 0, width: 620, height: 480)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await DesktopAccessibilityDriver.materializeOwnedApplication()
        try DesktopAccessibilityDriver.press("startup-runtime-retry", in: hosting)
        XCTAssertEqual(retries, 1)
        XCTAssertEqual(registrations, 0)
        XCTAssertFalse(flow.ready)
        try await DesktopSnapshotRenderer.render(
            DesktopStartupRepairView(flow: flow, retry: {}, openSettings: {}).padding(28),
            name: "startup-before-library-approval",
            size: CGSize(width: 680, height: 520)
        )
    }

    func testRepairCopyTracksObservedStartupReadinessAndRetryNeverRegistersInBothAppearances() async throws {
        let pendingCopy = "Automatic startup is required and has not been enabled or approved. Review it in macOS, then retry the background connection. These controls do not create or replace a library."
        let readyCopy = "Automatic startup is enabled. Retry the background connection to continue. These controls do not create or replace a library."
        let unverifiedCopy = "Automatic startup is required. Check its status before retrying the background connection. These controls do not create or replace a library."
        let scenarios: [(name: String, status: DesktopAutomaticStartup.Status, approvalAction: String?, explanation: String)] = [
            ("approval", .approvalRequired, "startup-approve", pendingCopy),
            ("disabled", .disabled, "startup-enable", pendingCopy),
            ("checking", .needsCheck, nil, unverifiedCopy),
            ("unavailable", .unavailable, nil, unverifiedCopy),
            ("ready", .enabled, nil, readyCopy),
        ]
        for scenario in scenarios {
            var registrations = 0, retries = 0, settingsOpens = 0, completedAppearances = 0
            let flow = DesktopAutomaticStartup(read: { scenario.status }, register: { registrations += 1 })
            flow.refresh()
            let expectedReady = scenario.status == .enabled
            try await DesktopSnapshotRenderer.render(
                DesktopStartupRepairView(flow: flow, retry: { retries += 1 }, openSettings: { settingsOpens += 1 }).padding(28),
                name: "startup-repair-hierarchy-\(scenario.name)",
                size: CGSize(width: 680, height: 520)
            ) { host in
                XCTAssertEqual(retries, completedAppearances, "Mounting an appearance must not retry the background connection")
                XCTAssertEqual(registrations, 0)
                XCTAssertEqual(settingsOpens, 0)
                let explanation = try DesktopAccessibilityDriver.element("startup-repair-explanation", in: host)
                XCTAssertEqual(
                    explanation.accessibilityTextValue() ?? explanation.accessibilityLabel(),
                    scenario.explanation
                )
                for otherCopy in [pendingCopy, readyCopy, unverifiedCopy] where otherCopy != scenario.explanation {
                    XCTAssertFalse(try DesktopAccessibilityDriver.contains(otherCopy, in: host))
                }
                if scenario.status == .needsCheck || scenario.status == .unavailable {
                    XCTAssertFalse(try DesktopAccessibilityDriver.contains("has not been enabled or approved", in: host))
                    XCTAssertFalse(try DesktopAccessibilityDriver.contains("Automatic startup is off", in: host))
                }
                let retry = try DesktopAccessibilityDriver.element("startup-runtime-retry", in: host)
                XCTAssertEqual(retry.accessibilityRole(), .button)
                XCTAssertEqual(retry.accessibilityLabel() ?? retry.accessibilityTextValue(), "Retry background connection")
                XCTAssertTrue(retry.isAccessibilityEnabled(), "Repair retry remains permitted without registration or approval")
                let window = try XCTUnwrap(host.window)
                for frame in [explanation.accessibilityFrame(), retry.accessibilityFrame()] {
                    XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
                    XCTAssertGreaterThan(frame.width, 0)
                    XCTAssertGreaterThan(frame.height, 0)
                    XCTAssertTrue(window.frame.contains(frame))
                }
                let approvalActions = try DesktopAccessibilityDriver.elements(in: host).filter {
                    ["startup-approve", "startup-enable"].contains($0.accessibilityIdentifier() ?? "")
                }
                XCTAssertEqual(approvalActions.compactMap { $0.accessibilityIdentifier() }, scenario.approvalAction.map { [$0] } ?? [])
                XCTAssertTrue(retry.accessibilityPerformPress())
                XCTAssertEqual(retries, completedAppearances + 1)
                XCTAssertEqual(registrations, 0, "Retry must never request native startup registration")
                XCTAssertEqual(settingsOpens, 0, "Retry must never substitute a system settings action")
                XCTAssertEqual(flow.status, scenario.status)
                XCTAssertEqual(flow.ready, expectedReady, "Retry is not evidence that startup approval changed")
                completedAppearances += 1
            }
            XCTAssertEqual(completedAppearances, 2)
            XCTAssertEqual(retries, 2)
        }
    }

    func testRequiredStartupPendingAndRevokedRendersAreNotOptionalToggles() async throws {
        for status in [DesktopAutomaticStartup.Status.approvalRequired, .disabled, .enabled] {
            let flow = DesktopAutomaticStartup(read: { status }, register: {})
            try await DesktopSnapshotRenderer.render(
                DesktopAutomaticStartupView(flow: flow, openSettings: {}).padding(28),
                name: status == .approvalRequired ? "startup-approval-required" : status == .disabled ?
                    "startup-required-disabled" : "startup-enabled",
                size: CGSize(width: 640, height: 380)
            )
        }
    }
}
