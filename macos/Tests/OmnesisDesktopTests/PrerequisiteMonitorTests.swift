// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
@testable import OmnesisDesktop
import SwiftUI
import XCTest

private final class PrerequisiteFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var denied = false
    private static var needsAuth = false
    private static var hasSource = true
    private static var counts: [String: Int] = [:]
    static func reset() {
        lock.withLock { denied = false
            needsAuth = false
            hasSource = true
            counts = [:]
        }
    }

    static func loseAccess() {
        lock.withLock { denied = true }
    }

    static func loseSignIn() {
        lock.withLock { needsAuth = true }
    }

    static func empty() {
        lock.withLock { hasSource = false }
    }

    static func count(_ path: String) -> Int {
        lock.withLock { counts[path, default: 0] }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func stopLoading() {}
    override func startLoading() {
        guard request.url?.host == "localhost", request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let path = request.url?.path ?? ""
        let body = Self.lock.withLock { () -> String in
            Self.counts[path, default: 0] += 1
            switch path {
            case "/admin/sources":
                return Self
                    .hasSource ?
                    #"{"items":[{"id":"fictional-source","type":"invented","accountId":"Fictional notebook","enabled":true,"deviceId":"fixture-device"}]}"# :
                    #"{"items":[]}"#
            case "/admin/devices":
                return #"{"items":[{"id":"fixture-device","name":"Example Mac","kind":"collector","online":true}]}"#
            case "/admin/source-descriptors", "/admin/sources/descriptors":
                return #"{"deviceId":"fixture-device","items":[{"id":"invented","name":"Fictional source","description":"Chosen notebook","hasAuthFlow":false,"hasDiscover":false,"permissionRequirements":[{"id":"chosen-files","kind":"protected-files","summary":"Read selected information","scope":"Selected notebook root","blocking":true,"actions":[{"kind":"retry-access"}]}]}]}"#
            case "/admin/sync/status":
                return Self.hasSource ? #"{"items":[{"sourceId":"fictional-source","deviceId":"fixture-device","state":"STATE"}]}"#
                    .replacingOccurrences(of: "STATE", with: Self.needsAuth ? "needs-auth" : "synced") : #"{"items":[]}"#
            case "/admin/sources/permissions":
                return #"{"deviceId":"fixture-device","descriptorId":"invented","sourceId":"fictional-source","scopeDigest":"DIGEST","checkedAt":"2030-01-01T12:00:00Z","status":"STATE","target":"unverified","requirements":[{"id":"chosen-files","kind":"protected-files","summary":"Read selected information","scope":"Selected notebook root","blocking":true,"actions":[{"kind":"retry-access"}]}]}"#
                    .replacingOccurrences(of: "DIGEST", with: String(repeating: "a", count: 64))
                    .replacingOccurrences(of: "STATE", with: Self.denied ? "denied" : "readable")
            default: return #"{"items":[]}"#
            }
        }
        client?.urlProtocol(
            self,
            didReceive: HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!,
            cacheStoragePolicy: .notAllowed
        )
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class PrerequisitePowerValue: @unchecked Sendable {
    private let lock = NSLock()
    private var value = DesktopMacServerPowerObservation.Status.ready
    func losePower() {
        lock.withLock { value = .onBattery }
    }

    func read() -> DesktopMacServerPowerObservation {
        lock.withLock { DesktopMacServerPowerObservation(status: value) }
    }
}

private actor PrerequisitePowerProbe {
    private(set) var calls = 0
    private var closed = false
    private var pending: [CheckedContinuation<DesktopMacServerPowerObservation, Never>] = []
    func read() async -> DesktopMacServerPowerObservation {
        guard !closed else { return .init(status: .unavailable) }
        calls += 1
        return await withCheckedContinuation { pending.append($0) }
    }

    func finish(_ status: DesktopMacServerPowerObservation.Status) {
        guard !pending.isEmpty else { return }
        pending.removeFirst().resume(returning: .init(status: status))
    }

    func close() {
        closed = true
        let owned = pending
        pending = []
        owned.forEach { $0.resume(returning: .init(status: .unavailable)) }
    }
}

@MainActor
final class PrerequisiteMonitorTests: XCTestCase {
    private func api() throws -> DesktopAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PrerequisiteFixtureProtocol.self]
        let session = URLSession(configuration: config)
        addTeardownBlock { session.invalidateAndCancel() }
        let connection = try JSONDecoder().decode(DesktopConnection.self, from: Data(
            #"{"url":"http://localhost","token":"fixture-token","collectorDeviceId":"fixture-device"}"#.utf8
        ))
        return try DesktopAPI(connection: connection, sessionOverride: session)
    }

    private func wait(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard condition() else { throw URLError(.timedOut) }
    }

    private func waitForCalls(_ count: Int, probe: PrerequisitePowerProbe) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while await probe.calls < count, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let observed = await probe.calls
        XCTAssertEqual(observed, count)
        guard observed == count else { throw URLError(.timedOut) }
    }

    func testRoleChangeDrainsOldPowerProbeBeforeStartingReplacementAndCannotPublishItsReadyResult() async throws {
        let probe = PrerequisitePowerProbe()
        let power = DesktopMacServerPowerFlow(probe: { await probe.read() })
        let store = DesktopStore(
            startRuntime: false,
            automaticStartup: DesktopAutomaticStartup(read: { .enabled }, register: {}),
            serverPower: power,
            monitorPrerequisites: true,
            monitoringIntervals: .init(collection: .seconds(30), system: .seconds(60)),
            monitoringNotifications: NotificationCenter()
        )
        addTeardownBlock { await probe.close()
            await store.stopPrerequisiteMonitoring()
        }
        store.state = DesktopState(phase: .preparing, mode: "home", installationId: "desktop-0000000000000001")
        try await waitForCalls(1, probe: probe)
        store.state = DesktopState(phase: .waiting, mode: "joined", installationId: "desktop-0000000000000001")
        store.state = DesktopState(phase: .preparing, mode: "home", installationId: "desktop-0000000000000002")
        try await Task.sleep(for: .milliseconds(40))
        let callsBeforeJoin = await probe.calls
        XCTAssertEqual(callsBeforeJoin, 1, "A replacement incarnation must join the physical old power check")
        await probe.finish(.ready)
        try await waitForCalls(2, probe: probe)
        XCTAssertFalse(power.ready, "The old incarnation’s delayed success must not publish into the replacement")
        await probe.finish(.onBattery)
        try await wait { power.status == .onBattery }
        await store.stopPrerequisiteMonitoring()
    }

    func testClosingRootKeepsStartupPowerAccessAndSignInLossVisibleInMenu() async throws {
        PrerequisiteFixtureProtocol.reset()
        var startup = DesktopAutomaticStartup.Status.enabled
        let power = PrerequisitePowerValue()
        let store = DesktopStore(
            startRuntime: false,
            automaticStartup: DesktopAutomaticStartup(read: { startup }, register: {}),
            serverPower: DesktopMacServerPowerFlow(probe: { power.read() }),
            nativeOwnerVerified: true,
            monitorPrerequisites: true,
            monitoringIntervals: .init(
                collection: .milliseconds(60),
                system: .milliseconds(60)
            ),
            monitoringNotifications: NotificationCenter()
        )
        addTeardownBlock { await store.stopPrerequisiteMonitoring() }
        let api = try api()
        let expiry = floor(Date().timeIntervalSince1970 * 1000) + 60000
        store.state = DesktopState(
            phase: .ready,
            mode: "home",
            connection: api.connection,
            encrypted: true,
            installationId: "desktop-0000000000000001",
            storageAdmission: .init(state: "ready", validUntil: expiry),
            remoteRoute: .init(state: "ready", validUntil: expiry)
        )
        store.api = api
        store.destination = .setup
        try await wait { store.requiredSetupReady }
        let hosting = NSHostingView(rootView: DesktopRootView().environment(store))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 720),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.makeKeyAndOrderFront(nil)
        hosting.layoutSubtreeIfNeeded()
        window.contentView = nil
        window.close()
        let checks = PrerequisiteFixtureProtocol.count("/admin/sources/permissions")
        startup = .disabled
        power.losePower()
        PrerequisiteFixtureProtocol.loseAccess()
        PrerequisiteFixtureProtocol.loseSignIn()
        try await wait {
            store.automaticStartup.status == .disabled && store.serverPower.status == .onBattery &&
                store.collectionAccess.flows.values.contains { $0.state == .denied } && !store.sourceConnectionsReady
        }
        XCTAssertGreaterThan(PrerequisiteFixtureProtocol.count("/admin/sources/permissions"), checks)
        XCTAssertEqual(store.menuStatusLabel, "Setup needs attention")
        XCTAssertFalse(store.requiredSetupReady)
        XCTAssertTrue(store.state.canOpenLibrary)
        XCTAssertTrue(store.api === api)
        await store.stopPrerequisiteMonitoring()
    }

    func testMenuOnlyKnownEmptyRosterStillMonitorsAndStoppedRolesJoinTheirChecks() async throws {
        PrerequisiteFixtureProtocol.reset()
        PrerequisiteFixtureProtocol.empty()
        let power = PrerequisitePowerValue()
        let notifications = NotificationCenter()
        let store = DesktopStore(
            startRuntime: false,
            automaticStartup: DesktopAutomaticStartup(read: { .enabled }, register: {}),
            serverPower: DesktopMacServerPowerFlow(probe: { power.read() }),
            nativeOwnerVerified: true,
            monitorPrerequisites: true,
            monitoringIntervals: .init(
                collection: .milliseconds(60),
                system: .milliseconds(60)
            ),
            monitoringNotifications: notifications
        )
        addTeardownBlock { await store.stopPrerequisiteMonitoring() }
        XCTAssertFalse(store.sourceAccessReady, "An unknown roster is not the observed absence of local sources")
        let api = try api()
        store.state = DesktopState(
            phase: .ready,
            mode: "joined",
            connection: api.connection,
            encrypted: true,
            installationId: "desktop-0000000000000001"
        )
        store.api = api
        try await wait { store.sourcesLoaded && store.requiredSetupReady }
        XCTAssertEqual(PrerequisiteFixtureProtocol.count("/admin/sources/permissions"), 0)
        notifications.post(name: NSApplication.didBecomeActiveNotification, object: nil)
        try await wait { PrerequisiteFixtureProtocol.count("/admin/sources") >= 2 }
        store.state = DesktopState(phase: .waiting, mode: "joined", retired: true)
        store.api = nil
        await store.stopPrerequisiteMonitoring()
        let checked = PrerequisiteFixtureProtocol.count("/admin/sources")
        notifications.post(name: NSApplication.didBecomeActiveNotification, object: nil)
        try await Task.sleep(for: .milliseconds(140))
        XCTAssertEqual(PrerequisiteFixtureProtocol.count("/admin/sources"), checked)
        XCTAssertFalse(store.requiredSetupReady)
    }
}
