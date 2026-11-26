// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import Omnesis
@testable import OmnesisDesktop
import SwiftUI
import XCTest

private final class StoreRefreshFixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var requests: [StoreRefreshFixtureProtocol] = []
    static func take() -> [StoreRefreshFixtureProtocol] {
        lock.withLock { let value = requests
            requests = []
            return value
        }
    }

    static var count: Int {
        lock.withLock { requests.count }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard request.url?.host == "localhost", request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token" else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        Self.lock.withLock { Self.requests.append(self) }
    }

    override func stopLoading() {}
    func reply(_ body: String, status: Int = 200) {
        client?.urlProtocol(
            self,
            didReceive: HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!,
            cacheStoragePolicy: .notAllowed
        )
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
final class DesktopStoreRefreshTests: XCTestCase {
    private func api(collectorDeviceId: String? = nil) throws -> DesktopAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StoreRefreshFixtureProtocol.self]
        let session = URLSession(configuration: configuration)
        addTeardownBlock { session.invalidateAndCancel() }
        var fields = ["url": "http://localhost", "token": "fixture-token"]
        if let collectorDeviceId { fields["collectorDeviceId"] = collectorDeviceId }
        let connection = try JSONDecoder().decode(DesktopConnection.self, from: JSONSerialization.data(withJSONObject: fields))
        return try DesktopAPI(connection: connection, sessionOverride: session)
    }

    private func waitForRequests(_ count: Int) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while StoreRefreshFixtureProtocol.count < count, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(StoreRefreshFixtureProtocol.count, count)
        guard StoreRefreshFixtureProtocol.count == count else { throw URLError(.timedOut) }
    }

    private func history(_ title: String) -> String {
        #"{"conversations":[{"id":"fixture-session","title":"TITLE","model":"fictional","backend":"fixture","createdAt":"2026-01-01T12:00:00Z","updatedAt":"2026-01-01T12:00:00Z","messageCount":2}],"nextCursor":null}"#
            .replacingOccurrences(
                of: "TITLE",
                with: title
            )
    }

    func testLibraryConnectionUsesExistingHTTPReconnectWithoutCertifyingReadinessAndRejectsOldAPI() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        let flow = DesktopLibraryConnectionFlow()
        try flow.bind(DesktopAPIContext(api: api(), id: 1))
        let load = Task { await flow.load() }
        try await waitForRequests(1)
        let initial = try XCTUnwrap(StoreRefreshFixtureProtocol.take().first)
        XCTAssertEqual(initial.request.httpMethod, "GET")
        XCTAssertEqual(initial.request.url?.path, "/admin/cloud-relay")
        let linked = #"{"enabled":true,"account":{"linked":true},"tunnel":{"state":"online"},"certificate":{"state":"valid"},"publicMcp":{"ready":true}}"#
        initial.reply(linked)
        await load.value
        XCTAssertTrue(flow.status?.account?.linked == true)
        var refreshes = 0
        let reconnect = Task { await flow.reconnect { refreshes += 1 } }
        try await waitForRequests(1)
        let command = try XCTUnwrap(StoreRefreshFixtureProtocol.take().first)
        XCTAssertEqual(command.request.httpMethod, "POST")
        XCTAssertEqual(command.request.url?.path, "/admin/cloud-relay/reconnect")
        command.reply(linked)
        await reconnect.value
        XCTAssertEqual(refreshes, 1, "Acknowledgment only asks the coordinator for fresh readiness")
        XCTAssertTrue(flow.recheckRequested)
        let readiness = DesktopHomeServiceReadiness()
        XCTAssertEqual(readiness.route, .unavailable, "A raw relay acknowledgment must not certify the protected installation")

        let stale = Task { await flow.reconnect { refreshes += 1 } }
        try await waitForRequests(1)
        let old = try XCTUnwrap(StoreRefreshFixtureProtocol.take().first)
        try flow.bind(DesktopAPIContext(api: api(), id: 2))
        old.reply(linked)
        await stale.value
        XCTAssertNil(flow.status)
        XCTAssertFalse(flow.recheckRequested)
        XCTAssertEqual(refreshes, 1, "An old library request cannot trigger recovery on a replacement library")
    }

    func testLaterNativeOwnerLossKeepsOnlyPreviouslyVerifiedSameLibraryReads() throws {
        let bridge = RuntimeBridge()
        let store = DesktopStore(
            startRuntime: false,
            runtimeBridge: bridge,
            automaticStartup: DesktopAutomaticStartup(read: { .enabled }, register: {}),
            nativeOwnerVerified: true
        )
        let stateJSON = #"{"phase":"ready","mode":"joined","encrypted":true,"installationId":"desktop-0000000000000001","connection":{"url":"http://localhost","token":"fixture-token"}}"#
        store.state = try JSONDecoder().decode(DesktopState.self, from: Data(stateJSON.utf8))
        let verifiedAPI = try api()
        store.api = verifiedAPI
        let verifiedContext = store.apiContext

        bridge.onStartupBlocked?(.ownerMismatch)
        XCTAssertTrue(store.apiContext === verifiedContext)
        XCTAssertTrue(
            verifiedContext?.isCurrent == true,
            "Existing verified HTTP scopes survive helper loss; native lifecycle authority does not"
        )
        XCTAssertFalse(store.nativeOwnerReady)
        XCTAssertFalse(store.requiredSetupReady)
        XCTAssertTrue(store.requiredSetupNeedsAction)
        XCTAssertEqual(store.menuStatusLabel, "Setup needs attention")
        XCTAssertTrue(store.api === verifiedAPI, "Losing a background prerequisite must retain already verified reads")
        XCTAssertTrue(store.state.canOpenLibrary)

        let same = try JSONDecoder().decode(BridgeEnvelope.self, from: Data(
            (#"{"version":1,"ok":true,"result":STATE}"#.replacingOccurrences(of: "STATE", with: stateJSON)).utf8
        ))
        bridge.onEnvelope?(same)
        XCTAssertTrue(store.api === verifiedAPI)
        XCTAssertTrue(store.state.canOpenLibrary)
        XCTAssertFalse(store.nativeOwnerReady, "Portable status cannot clear a native ownership block")

        bridge.onFailure?("The owned background connection stopped.")
        XCTAssertTrue(store.api === verifiedAPI, "A later control-channel loss must not erase established library reads")
        XCTAssertTrue(store.state.canOpenLibrary)
        XCTAssertFalse(store.requiredSetupReady)

        let replacement = try JSONDecoder().decode(BridgeEnvelope.self, from: Data(
            (#"{"version":1,"ok":true,"result":STATE}"#.replacingOccurrences(
                of: "STATE", with: stateJSON.replacingOccurrences(of: "desktop-0000000000000001", with: "desktop-0000000000000002")
            )).utf8
        ))
        bridge.onEnvelope?(replacement)
        XCTAssertNil(store.api, "A different installation must never inherit the previous read authority")
        XCTAssertFalse(store.state.canOpenLibrary)
    }

    func testInitialUnverifiedAPIIsNotRetainedWhenNativeOwnerIsBlocked() throws {
        let bridge = RuntimeBridge()
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge)
        store.state = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"joined","encrypted":true,"installationId":"desktop-0000000000000001","connection":{"url":"http://localhost","token":"fixture-token"}}"#
                .utf8
        ))
        store.api = try api()
        bridge.onStartupBlocked?(.helperUnavailable)
        XCTAssertNil(store.api)
        XCTAssertFalse(store.state.canOpenLibrary)
        XCTAssertFalse(store.requiredSetupReady)
    }

    func testAuthenticatedRecoveredReadsRemainAvailableButOldOriginCannotCertifyNewInstallation() throws {
        let bridge = RuntimeBridge()
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge, nativeOwnerVerified: true)
        let api = try api()
        store.state = DesktopState(
            phase: .ready,
            mode: "joined",
            connection: api.connection,
            encrypted: true,
            installationId: "desktop-0000000000000001"
        )
        let epoch = String(repeating: "a", count: 64)
        bridge.onApplicationOwnership?(.init(
            state: .verified,
            codeEpoch: epoch,
            originEpoch: epoch,
            presentation: .retained,
            installation: .recoveredVersionInstallNeeded,
            installationId: "desktop-0000000000000001"
        ))
        store.api = api
        XCTAssertTrue(store.state.canOpenLibrary)
        XCTAssertFalse(store.applicationInstallationCurrent)
        XCTAssertFalse(store.requiredSetupReady)
        bridge.onStartupBlocked?(.helperUnavailable)
        XCTAssertTrue(store.api === api, "Verified recovered reads also survive later helper loss")
        bridge.onStartupBlocked?(nil)
        let newer = try JSONDecoder().decode(BridgeEnvelope.self, from: Data(
            #"{"version":1,"ok":true,"result":{"phase":"ready","mode":"joined","encrypted":true,"installationId":"desktop-0000000000000002","connection":{"url":"http://localhost","token":"fixture-token"}}}"#
                .utf8
        ))
        bridge.onEnvelope?(newer)
        XCTAssertNil(store.api, "Authenticated origin evidence from an old installation cannot admit a new one")
        XCTAssertFalse(store.state.canOpenLibrary)
    }

    func testObsoleteLibraryCannotPublishRowsAfterConnectionReplacement() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        let store = DesktopStore(startRuntime: false)
        store.api = try api()
        let refresh = Task { await store.refresh() }
        defer { refresh.cancel() }
        try await waitForRequests(3)
        store.api = try api()
        store.sources = try JSONDecoder().decode(
            [DesktopSource].self,
            from: Data(#"[{"id":"current","type":"example","accountId":"Current notebook","enabled":true,"deviceId":"fixture"}]"#.utf8)
        )
        for request in StoreRefreshFixtureProtocol.take() {
            request
                .reply(request.request.url?
                    .path == "/admin/sources" ?
                    #"{"items":[{"id":"obsolete","type":"example","accountId":"Obsolete notebook","enabled":true,"deviceId":"fixture"}]}"# :
                    #"{"items":[]}"#)
        }
        await refresh.value
        XCTAssertEqual(store.sources.map(\.id), ["current"])
        XCTAssertNil(store.failure)
        XCTAssertEqual(
            StoreRefreshFixtureProtocol.count,
            0,
            "An obsolete refresh must not start a history request on the replacement connection"
        )
    }

    func testRequiredSetupNeedsObservedMetadataStartupAndHomePowerAndRevocationReturnsAttention() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        var startupStatus = DesktopAutomaticStartup.Status.disabled
        let startup = DesktopAutomaticStartup(read: { startupStatus }, register: {})
        let power = DesktopMacServerPowerFlow(probe: { DesktopMacServerPowerObservation(status: .ready) })
        let store = DesktopStore(startRuntime: false, automaticStartup: startup, serverPower: power, nativeOwnerVerified: true)
        store.state = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"home","encrypted":true,"installationId":"desktop-0000000000000001","storageAdmission":{"state":"ready","validUntil":DEADLINE},"remoteRoute":{"state":"ready","validUntil":DEADLINE},"connection":{"url":"http://localhost","token":"fixture-token"}}"#
                .replacingOccurrences(of: "DEADLINE", with: String(Int64(Date().timeIntervalSince1970 * 1000) + 60000))
                .utf8
        ))
        store.api = try api()
        XCTAssertFalse(store.requiredSetupReady)
        let refresh = Task { await store.refreshPrerequisiteMetadata() }
        try await waitForRequests(3)
        for request in StoreRefreshFixtureProtocol.take() {
            request.reply(#"{"items":[]}"#)
        }
        await refresh.value
        await power.refresh()
        startup.refresh()
        XCTAssertFalse(store.requiredSetupReady, "Observed source access cannot substitute for required startup")
        startupStatus = .enabled
        startup.refresh()
        XCTAssertTrue(store.requiredSetupReady, "No chosen local sources means no local permission request")
        XCTAssertEqual(store.menuStatusLabel, "Ready")
        startupStatus = .disabled
        startup.refresh()
        XCTAssertFalse(store.requiredSetupReady)
        XCTAssertTrue(store.requiredSetupNeedsAction)
        XCTAssertEqual(store.menuStatusLabel, "Setup needs attention")
        XCTAssertTrue(store.state.canOpenLibrary, "Losing a prerequisite must preserve existing reads and chat")
        XCTAssertEqual(StoreRefreshFixtureProtocol.count, 0)
    }

    func testAllHealthySetupUsesObservedEmptyRosterAndFreshHomeEvidenceThenLossKeepsReads() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        let bridge = RuntimeBridge()
        let power = DesktopMacServerPowerFlow(probe: { DesktopMacServerPowerObservation(status: .ready) })
        let store = DesktopStore(
            startRuntime: false,
            runtimeBridge: bridge,
            automaticStartup: DesktopAutomaticStartup(read: { .enabled }, register: {}),
            serverPower: power,
            nativeOwnerVerified: true
        )
        let api = try api()
        let deadline = floor(Date().timeIntervalSince1970 * 1000) + 60000
        store.state = DesktopState(
            phase: .ready,
            mode: "home",
            connection: api.connection,
            encrypted: true,
            installationId: "desktop-0000000000000001",
            storageAdmission: .init(state: "ready", validUntil: deadline),
            remoteRoute: .init(state: "ready", validUntil: deadline)
        )
        store.api = api
        let refresh = Task { await store.refreshPrerequisiteMetadata() }
        try await waitForRequests(3)
        for request in StoreRefreshFixtureProtocol.take() {
            request.reply(#"{"items":[]}"#)
        }
        await refresh.value
        await power.refresh()
        store.automaticStartup.refresh()
        XCTAssertTrue(store.sourcesLoaded)
        XCTAssertTrue(store.requiredSetupReady)
        XCTAssertNil(DesktopSetupRepair.first(in: store))
        try await DesktopSnapshotRenderer.render(
            DesktopSetupChecklist(loadStatus: false).environment(store),
            name: "setup-all-required-ready",
            size: CGSize(width: 900, height: 720)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Required setup is complete on this Mac", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Add your first source", in: view))
        }
        store.settingsTab = "general"
        try await DesktopSnapshotRenderer.render(
            DesktopSettingsView().environment(store), name: "settings-all-required-ready", size: CGSize(width: 720, height: 640)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Starts automatically when you sign in", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Closing the window keeps collection running", in: view))
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Automatic sleep is off while plugged in", in: view))
        }
        let epoch = String(repeating: "a", count: 64)
        bridge.onApplicationOwnership?(.init(
            state: .verified,
            codeEpoch: epoch,
            originEpoch: epoch,
            presentation: .retained,
            installation: .recoveredVersionInstallNeeded,
            installationId: "desktop-0000000000000001"
        ))
        XCTAssertFalse(store.requiredSetupReady)
        XCTAssertTrue(store.state.canOpenLibrary)
        XCTAssertTrue(store.api === api)
        XCTAssertEqual(DesktopSetupRepair.first(in: store), .installation)
        try await DesktopSnapshotRenderer.render(
            DesktopSetupChecklist(loadStatus: false).environment(store),
            name: "setup-recovered-install-needed",
            size: CGSize(width: 900, height: 720)
        ) { view in
            XCTAssertTrue(try DesktopAccessibilityDriver.contains("Automatic startup will be checked after installation", in: view))
            XCTAssertFalse(try DesktopAccessibilityDriver.contains("Starts automatically when you sign in", in: view))
            XCTAssertNotNil(try DesktopAccessibilityDriver.element("application-installation-recovery", in: view))
        }
        bridge.onApplicationOwnership?(.init(
            state: .verified,
            codeEpoch: epoch,
            originEpoch: epoch,
            presentation: .installedOrigin,
            installation: .current,
            installationId: "desktop-0000000000000001"
        ))
        XCTAssertTrue(store.requiredSetupReady)
        store.state = DesktopState(
            phase: .ready,
            mode: "home",
            connection: api.connection,
            encrypted: true,
            installationId: "desktop-0000000000000001",
            storageAdmission: .init(state: "blocked", validUntil: deadline),
            remoteRoute: .init(state: "unavailable")
        )
        XCTAssertFalse(store.requiredSetupReady)
        XCTAssertTrue(store.requiredSetupNeedsAction)
        XCTAssertTrue(store.state.canOpenLibrary)
        XCTAssertTrue(store.api === api)
        XCTAssertEqual(DesktopSetupRepair.first(in: store), .storage)
        try await DesktopSnapshotRenderer.render(
            DesktopSetupReadinessView().environment(store),
            name: "setup-storage-and-route-repair",
            size: CGSize(width: 740, height: 760)
        ) { view in
            XCTAssertNotNil(try DesktopAccessibilityDriver.element("setup-review-storage", in: view))
            XCTAssertNotNil(try DesktopAccessibilityDriver.element("setup-review-connection", in: view))
        }
    }

    func testMissingCollectorIdentityCannotClassifyPopulatedRosterAsNoLocalCollection() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        let startup = DesktopAutomaticStartup(read: { .enabled }, register: {})
        let power = DesktopMacServerPowerFlow(probe: { DesktopMacServerPowerObservation(status: .ready) })
        let store = DesktopStore(startRuntime: false, automaticStartup: startup, serverPower: power, nativeOwnerVerified: true)
        store.api = try api()
        let refresh = Task { await store.refreshPrerequisiteMetadata() }
        try await waitForRequests(3)
        for request in StoreRefreshFixtureProtocol.take() {
            request.reply(request.request.url?.path == "/admin/sources" ?
                #"{"items":[{"id":"current","type":"example","accountId":"Fictional notebook","enabled":true,"deviceId":"fixture"}]}"# :
                #"{"items":[]}"#)
        }
        await refresh.value
        XCTAssertTrue(store.sourcesLoaded)
        XCTAssertFalse(store.localCollectionIdentityReady, "Missing current identity must not be confused with no chosen local sources")
        XCTAssertFalse(store.sourceAccessReady, "Missing collector identity cannot prove that no local access is needed")
        XCTAssertFalse(store.requiredSetupReady)
        XCTAssertFalse(store.installationIdentityReady)
    }

    func testLocalPermissionMetadataComesFromSelectedCollectorInsteadOfFleetPairingOrder() async throws {
        for selectedNone in [false, true] {
            _ = StoreRefreshFixtureProtocol.take()
            let store = DesktopStore(startRuntime: false)
            store.api = try api(collectorDeviceId: "fixture")
            let refresh = Task { await store.refreshPrerequisiteMetadata() }
            try await waitForRequests(3)
            for request in StoreRefreshFixtureProtocol.take() {
                switch request.request.url?.path {
                case "/admin/sources":
                    request
                        .reply(
                            #"{"items":[{"id":"source","type":"invented","accountId":"Fictional notebook","enabled":true,"deviceId":"fixture"}]}"#
                        )
                case "/admin/devices":
                    request.reply(#"{"items":[{"id":"fixture","name":"Selected Mac","kind":"collector","online":true}]}"#)
                default:
                    let requirement = selectedNone ? "" : #", "permissionRequirements":[]"#
                    request
                        .reply(
                            #"{"items":[{"id":"invented","name":"Fleet summary","description":"Browse only","hasAuthFlow":true,"hasDiscover":false\#(requirement)}]}"#
                        )
                }
            }
            try await waitForRequests(1)
            let scoped = try XCTUnwrap(StoreRefreshFixtureProtocol.take().first)
            XCTAssertEqual(scoped.request.url?.path, "/admin/sources/descriptors")
            XCTAssertEqual(
                try URLComponents(url: XCTUnwrap(scoped.request.url), resolvingAgainstBaseURL: false)?.queryItems?.first?.value,
                "fixture"
            )
            let requirement = selectedNone ? #", "permissionRequirements":[]"# : ""
            scoped
                .reply(
                    #"{"deviceId":"fixture","items":[{"id":"invented","name":"Actual selected source","description":"Full current schema","hasAuthFlow":false,"hasDiscover":false\#(requirement)}]}"#
                )
            await refresh.value
            XCTAssertTrue(store.sourcesLoaded)
            XCTAssertEqual(store.localDescriptors.first?.name, "Actual selected source")
            XCTAssertEqual(store.localDescriptors.first?.hasAuthFlow, false)
            XCTAssertEqual(store.requiredAccessTargets.isEmpty, selectedNone)
            XCTAssertEqual(store.sourceAccessReady, selectedNone)
            XCTAssertEqual(store.descriptors.first?.name, "Fleet summary", "Fleet data remains only the browsing catalog")
            XCTAssertFalse(store.requiredSetupReady, "File declarations alone do not prove source sign-in or native setup")
        }
    }

    func testUnchangedScopePollKeepsPermissionRevisionWhileActualConfigChangeInvalidatesIt() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        let store = DesktopStore(startRuntime: false)
        store.api = try api()
        var revisions: [Int] = []
        for (index, folder) in ["/tmp/fictional-notes", "/tmp/fictional-notes", "/tmp/changed-notes"].enumerated() {
            let refresh = Task { await store.refreshPrerequisiteMetadata() }
            try await waitForRequests(3)
            for request in StoreRefreshFixtureProtocol.take() {
                switch request.request.url?.path {
                case "/admin/sources":
                    request.reply(
                        #"{"items":[{"id":"current","type":"example","accountId":"Fictional notebook","enabled":true,"deviceId":"fixture","config":{"folder":"FOLDER"},"lastSyncedAt":"2026-01-01T12:00:INDEXZ"}]}"#
                            .replacingOccurrences(of: "FOLDER", with: folder).replacingOccurrences(of: "INDEX", with: "0" + String(index))
                    )
                case "/admin/devices":
                    request
                        .reply(#"{"items":[{"id":"fixture","name":"Example Mac","kind":"collector","online":ONLINE}]}"#
                            .replacingOccurrences(
                                of: "ONLINE",
                                with: index == 0 ? "false" : "true"
                            ))
                default: request.reply(#"{"items":[]}"#)
                }
            }
            await refresh.value
            revisions.append(store.sourceContextRevision)
        }
        XCTAssertEqual(revisions[0], revisions[1], "Presence or sync progress cannot restart an in-flight access check")
        XCTAssertGreaterThan(revisions[2], revisions[1], "Actual selected-folder changes must invalidate scope proof")
    }

    func testOlderSameConnectionMetadataCannotOverwriteNewRosterOrSourceSettings() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        let store = DesktopStore(startRuntime: false)
        store.api = try api()
        let old = Task { await store.refresh(includeHistory: false) }
        try await waitForRequests(3)
        let older = StoreRefreshFixtureProtocol.take()
        let fresh = Task { await store.refresh(includeHistory: false) }
        try await waitForRequests(3)
        for request in StoreRefreshFixtureProtocol.take() {
            request.reply(request.request.url?.path == "/admin/sources" ?
                #"{"items":[{"id":"current","type":"example","accountId":"Current notebook","enabled":true,"deviceId":"fixture"}]}"# :
                #"{"items":[]}"#)
        }
        await fresh.value
        for request in older {
            request.reply(#"{"items":[]}"#)
        }
        await old.value
        XCTAssertEqual(store.sources.map(\.id), ["current"])
        XCTAssertTrue(store.sourcesLoaded)
        XCTAssertNil(store.sourceMetadataFailure)
        XCTAssertEqual(StoreRefreshFixtureProtocol.count, 0, "Recurring metadata must not reload chat history")
    }

    func testConcurrentPrerequisiteRefreshCoalescesAndFailureCannotRetainVerifiedMetadata() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        let store = DesktopStore(startRuntime: false)
        store.api = try api()
        let first = Task { await store.refreshPrerequisiteMetadata() }
        try await waitForRequests(3)
        let second = Task { await store.refreshPrerequisiteMetadata() }
        await Task.yield()
        XCTAssertEqual(StoreRefreshFixtureProtocol.count, 3)
        for request in StoreRefreshFixtureProtocol.take() {
            request.reply(#"{"error":"Fixture unavailable"}"#, status: 503)
        }
        await first.value
        await second.value
        XCTAssertFalse(store.sourcesLoaded)
        XCTAssertFalse(store.sourceAccessReady)
        XCTAssertNotNil(store.sourceMetadataFailure)
        XCTAssertNil(store.failure, "A recurring check must not replace the current screen with a generic error")
    }

    func testOlderHistoryReplyCannotReplaceTheNewerObservedList() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        let store = DesktopStore(startRuntime: false)
        store.api = try api()
        let old = Task { await store.refreshConversationHistory() }
        defer { old.cancel() }
        try await waitForRequests(1)
        let first = try XCTUnwrap(StoreRefreshFixtureProtocol.take().first)
        let new = Task { await store.refreshConversationHistory() }
        defer { new.cancel() }
        try await waitForRequests(1)
        try XCTUnwrap(StoreRefreshFixtureProtocol.take().first).reply(history("Newer observed title"))
        await new.value
        first.reply(history("Obsolete title"))
        await old.value
        XCTAssertEqual(store.conversations.first?.title, "Newer observed title")
    }

    func testLibraryRefreshRetainsSavedHistoryWhenItsHistoryRequestFails() async throws {
        _ = StoreRefreshFixtureProtocol.take()
        let store = DesktopStore(startRuntime: false)
        store.api = try api()
        let page = try JSONDecoder().decode(ConversationListPage.self, from: Data(history("Saved title").utf8))
        store.conversations = page.conversations
        let refresh = Task { await store.refresh() }
        defer { refresh.cancel() }
        try await waitForRequests(3)
        StoreRefreshFixtureProtocol.take().forEach { $0.reply(#"{"items":[]}"#) }
        try await waitForRequests(1)
        try XCTUnwrap(StoreRefreshFixtureProtocol.take().first).reply(#"{"error":"Fixture unavailable"}"#, status: 503)
        await refresh.value
        XCTAssertEqual(store.conversations.first?.title, "Saved title")
        XCTAssertNotNil(store.conversationHistoryFailure)
    }
}
