// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
@testable import Omnesis
import XCTest

@MainActor
final class GatewayAdaptiveSocketTests: XCTestCase {
    private let origin = URL(string: "https://gateway.example.test")!
    private let deviceId = "00000000-0000-4000-8000-000000000901"

    func testProductionDedicatedSocketAuthenticatesSameDeviceAndPublishesOnlyVerifiedLocalPath() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let owner = try routing(peer)
        XCTAssertEqual(owner.connectionPath, .reconnecting)
        let verifiedLAN = await owner.directPathAvailable()
        XCTAssertTrue(verifiedLAN)
        XCTAssertEqual(try counters(peer)["requests"], 0)
        let socket = DeviceSocket(gatewayUrl: origin, token: "device-test-token", routingOwner: owner, expectedDeviceId: deviceId)
        await socket.start()
        let connected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(connected)
        XCTAssertEqual(owner.connectionPath, .local)
        XCTAssertTrue(owner.session === owner.session)
        await waitForCounter("pathLocal", value: 1, peer: peer)
        let state = await socket.state()
        XCTAssertEqual(state, .connected(deviceId: deviceId, deviceName: "Synthetic production pairing", scopes: ["read", "admin"]))
        await socket.promoteDirectPath() // already local: no new connection or credential
        XCTAssertEqual(try counters(peer)["hellos"], 1)
        await socket.stop()
        XCTAssertEqual(owner.connectionPath, .reconnecting)
        let probe = await owner.directPathAvailable()
        XCTAssertFalse(probe)
        let retired = owner.session
        do { _ = try await retired.data(from: origin)
            XCTFail("Retired session reopened")
        } catch { XCTAssertTrue(error is URLError) }
    }

    func testTraditionalDirectConnectionNeedsNeitherGoogleNorRelayAndReportsNoInventedPath() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let pin = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: "localhost")
        XCTAssertNil(pin.connectionPath)
        XCTAssertNil(pin.observeRoutePath { _ in })
        pin.removeRoutePathObserver(UUID())
        let session = pin.session
        defer { session.invalidateAndCancel() }
        let socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "https://localhost:\(peer.info.targetPort)")),
            token: "device-test-token",
            session: session,
            expectedDeviceId: deviceId
        )
        await socket.start()
        let connected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(connected)
        XCTAssertEqual(try counters(peer)["hellos"], 1)
        XCTAssertEqual(try counters(peer)["pathLocal"], 0)
        XCTAssertEqual(try counters(peer)["pathRelay"], 0)
        await socket.stop()
    }

    func testRevokedBearerAndWrongDeviceIdentityNeverConnectOrReportPath() async throws {
        for revoked in [false, true] {
            let peer = try CloudPairingSOCKSPeer()
            defer { peer.stop() }
            let owner = try routing(peer)
            let socket = DeviceSocket(
                gatewayUrl: origin,
                token: revoked ? "revoked-synthetic-token" : "device-test-token",
                routingOwner: owner,
                expectedDeviceId: revoked ? deviceId : "wrong-device"
            )
            await socket.start()
            let connected = await socket.waitUntilConnected(timeout: .milliseconds(500))
            XCTAssertFalse(connected)
            XCTAssertEqual(try counters(peer)["pathLocal"], 0)
            XCTAssertEqual(try counters(peer)["pathRelay"], 0)
            await socket.stop()
        }
    }

    func testPromotionReauthenticatesControlSocketAndKeepsIndependentHTTPLeaseAlive() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let actual = try routing(peer)
        let probe = Probe()
        let owner = ControlledRouting(actual: actual, probe: probe)
        let socket = DeviceSocket(gatewayUrl: origin, token: "device-test-token", routingOwner: owner, expectedDeviceId: deviceId)
        await socket.promoteDirectPath() // unauthenticated
        await socket.start()
        let firstConnected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(firstConnected)
        await waitForCounter("pathRelay", value: 1, peer: peer)
        await socket.promoteDirectPath() // verified probe unavailable, retain WS
        XCTAssertEqual(try counters(peer)["hellos"], 1)
        await probe.setResult(true)
        await socket.promoteDirectPath()
        owner.report(.local)
        let reconnected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(reconnected)
        await waitForCounter("pathLocal", value: 1, peer: peer)
        let stale = expectation(description: "Stale relay callback is discarded")
        stale.isInverted = true
        let trace = Task {
            var sawLocal = false
            for await path in socket.pathChanges {
                if sawLocal, path == .relay { stale.fulfill() }
                if path == .local { sawLocal = true }
            }
        }
        await socket.routeChanged(.relay)
        await fulfillment(of: [stale], timeout: 0.1)
        trace.cancel()
        XCTAssertEqual(try counters(peer)["hellos"], 2)
        let independent = try routing(peer)
        let http = independent.session
        defer { independent.retireRouting() }
        await socket.stop()
        let (data, _) = try await http.data(from: origin.appendingPathComponent("probe"))
        XCTAssertFalse(data.isEmpty)
        XCTAssertEqual(independent.connectionPath, .local)
    }

    func testLateProbeAndObserverCannotReconnectAfterUnpairOrAffectAnotherSocket() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let actual = try routing(peer)
        let probe = Probe()
        let owner = ControlledRouting(actual: actual, probe: probe)
        let socket = DeviceSocket(gatewayUrl: origin, token: "device-test-token", routingOwner: owner, expectedDeviceId: deviceId)
        await socket.start()
        let connected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(connected)
        await probe.hold()
        let pending = Task { await socket.promoteDirectPath() }
        await probe.waitUntilHeld()
        await socket.stop()
        owner.report(.local) // stale off-queue path callback
        await probe.release(true)
        await pending.value
        let state = await socket.state()
        XCTAssertEqual(state, .disconnected)
        XCTAssertEqual(try counters(peer)["hellos"], 1)
        XCTAssertEqual(try counters(peer)["pathLocal"], 0)
    }

    func testEarlierProbeCannotReconnectAReauthenticatedSocketWithIdenticalIdentity() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let probe = Probe()
        let owner = try ControlledRouting(actual: routing(peer), probe: probe)
        let socket = DeviceSocket(gatewayUrl: origin, token: "device-test-token", routingOwner: owner, expectedDeviceId: deviceId)
        await socket.start()
        let connected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(connected)
        await probe.hold()
        let stale = Task { await socket.promoteDirectPath() }
        await probe.waitUntilHeld()
        await probe.allowFutureCalls(true)
        await socket.promoteDirectPath()
        let reconnected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(reconnected)
        await waitForCounter("hellos", value: 2, peer: peer)
        XCTAssertEqual(try counters(peer)["hellos"], 2)
        await probe.release(true)
        await stale.value
        let state = await socket.state()
        XCTAssertEqual(state, .connected(deviceId: deviceId, deviceName: "Synthetic production pairing", scopes: ["read", "admin"]))
        XCTAssertEqual(try counters(peer)["hellos"], 2)
        await socket.stop()
    }

    func testPeriodicProbeUsesClockAndCancellationDoesNotKeepReconnecting() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let probe = Probe()
        let owner = try ControlledRouting(actual: routing(peer), probe: probe)
        let clock = ClockGate()
        let socket = DeviceSocket(
            gatewayUrl: origin,
            token: "device-test-token",
            routingOwner: owner,
            expectedDeviceId: deviceId,
            promotionClock: clock
        )
        await socket.start()
        let connected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(connected)
        await clock.waitUntilHeld()
        await clock.tick()
        await clock.waitUntilHeld()
        let probes = await probe.count()
        XCTAssertEqual(probes, 1)
        await socket.stop()
        await clock.tick() // a timer/provider that does not cooperate with cancellation
        let state = await socket.state()
        XCTAssertEqual(state, .disconnected)
        let finalProbes = await probe.count()
        XCTAssertEqual(finalProbes, 1)
    }

    func testPeriodicMetadataRefusalPreservesTheAuthenticatedControlSocket() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let clock = ClockGate()
        let refused = RefusingHintRefresher()
        let owner = try ControlledRouting(actual: routing(peer), probe: Probe())
        let socket = DeviceSocket(
            gatewayUrl: origin,
            token: "device-test-token",
            routingOwner: owner,
            expectedDeviceId: deviceId,
            promotionClock: clock,
            hintRefresher: refused
        )
        await socket.start()
        let connected = await socket.waitUntilConnected(timeout: .seconds(5))
        XCTAssertTrue(connected)
        await clock.waitUntilHeld()
        await clock.tick()
        await clock.waitUntilHeld()
        let calls = await refused.calls
        XCTAssertEqual(calls, 1)
        let state = await socket.state()
        XCTAssertEqual(state, .connected(deviceId: deviceId, deviceName: "Synthetic production pairing", scopes: ["read", "admin"]))
        XCTAssertEqual(try counters(peer)["hellos"], 1)
        await socket.stop()
        await clock.tick()
    }

    func testLatePromotionTimerCannotRetainOrReviveAReleasedSocket() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let clock = ClockGate()
        var socket: DeviceSocket? = try DeviceSocket(
            gatewayUrl: origin,
            token: "device-test-token",
            routingOwner: routing(peer),
            expectedDeviceId: deviceId,
            promotionClock: clock
        )
        weak var released = socket
        await socket?.start()
        let connected = await socket?.waitUntilConnected(timeout: .seconds(5))
        XCTAssertEqual(connected, true)
        await clock.waitUntilHeld()
        await socket?.stop()
        socket = nil
        for _ in 0 ..< 100 where released != nil {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertNil(released)
        await clock.tick() // an already-enqueued OS timer may complete after cancellation and deallocation
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(try counters(peer)["hellos"], 1)
    }

    private actor RefusingHintRefresher: GatewayDirectHintRefreshing {
        var calls = 0
        func refresh(apply: @escaping @Sendable ([GatewayDirectCandidate]) throws -> Void) async throws -> Bool {
            calls += 1
            throw URLError(.serverCertificateUntrusted)
        }
    }

    func testSilentHelloAndMissingPongReconnectWithTheSameDeviceAndCredentials() async throws {
        for missingHello in [true, false] {
            let peer = try CloudPairingSOCKSPeer(ignoreFirstHello: missingHello, ignoreFirstPongs: !missingHello)
            defer { peer.stop() }
            let pin = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: "localhost")
            let socket = try DeviceSocket(
                gatewayUrl: XCTUnwrap(URL(string: "https://localhost:\(peer.info.targetPort)")),
                token: "device-test-token",
                session: pin.session,
                expectedDeviceId: deviceId,
                liveness: .init(
                    helloTimeout: .milliseconds(150),
                    pingInterval: .milliseconds(150),
                    pongTimeout: .milliseconds(100)
                )
            )
            await socket.start()
            await waitForCounter("controlConnections", value: 2, peer: peer)
            let connected = await socket.waitUntilConnected(timeout: .seconds(5))
            XCTAssertTrue(connected)
            if !missingHello { XCTAssertGreaterThanOrEqual(try counters(peer)["pings"] ?? 0, 1) }
            let before = try counters(peer)["controlConnections"]
            try await Task.sleep(for: .milliseconds(600))
            XCTAssertEqual(try counters(peer)["controlConnections"], before, "Healthy pong must keep the replacement connection alive")
            await socket.appDidBecomeActive()
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertEqual(try counters(peer)["controlConnections"], before, "Foreground probes must retain a healthy socket")
            let recovered = await socket.waitUntilConnected(timeout: .seconds(5))
            XCTAssertTrue(recovered)
            await socket.stop()
            await socket.appDidBecomeActive()
            try await Task.sleep(for: .milliseconds(350))
            XCTAssertEqual(try counters(peer)["controlConnections"], before, "Foreground callbacks after unpair cannot reopen a socket")
            let stopped = await socket.state()
            XCTAssertEqual(stopped, .disconnected)
        }
    }

    private func routing(_ peer: CloudPairingSOCKSPeer) throws -> PinnedSession {
        let route = try XCTUnwrap(GatewayDirectRoute(
            origin: origin,
            candidates: [.init(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        return PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: origin.host, directRoute: route)
    }

    private func counters(_ peer: CloudPairingSOCKSPeer) throws -> [String: Int] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))) as? [String: Int])
    }

    private func waitForCounter(_ key: String, value: Int, peer: CloudPairingSOCKSPeer) async {
        for _ in 0 ..< 500 {
            if (try? counters(peer)[key]) == value { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Missing authenticated path telemetry")
    }

    private final class ControlledRouting: GatewaySocketRouting, @unchecked Sendable {
        let actual: PinnedSession
        let probe: Probe
        private let lock = NSLock()
        private var path = GatewayConnectionPath.relay
        private var callback: (@Sendable (GatewayConnectionPath) -> Void)?
        init(actual: PinnedSession, probe: Probe) {
            self.actual = actual
            self.probe = probe
        }

        var session: URLSession {
            actual.session
        }

        var connectionPath: GatewayConnectionPath? {
            lock.lock()
            defer { lock.unlock() }
            return path
        }

        func observeRoutePath(_ callback: @escaping @Sendable (GatewayConnectionPath) -> Void) -> UUID? {
            lock.lock()
            defer { lock.unlock() }
            self.callback = callback
            return UUID()
        }

        func removeRoutePathObserver(_ id: UUID) {}
        func retireRouting() {
            actual.retireRouting()
        }

        func directPathAvailable() async -> Bool {
            await probe.run()
        }

        func verifyRouting() async -> Bool {
            await actual.verifyRouting()
        }

        func updateCandidates(_ candidates: [GatewayDirectCandidate]) throws {
            try actual.updateCandidates(candidates)
        }

        func report(_ path: GatewayConnectionPath) {
            lock.lock()
            self.path = path
            let callback = callback
            lock.unlock()
            callback?(path)
        }
    }

    private actor Probe {
        private var result = false
        private var calls = 0
        private var held = false
        private var continuation: CheckedContinuation<Bool, Never>?
        private var waiter: CheckedContinuation<Void, Never>?
        func count() -> Int {
            calls
        }

        func setResult(_ result: Bool) {
            self.result = result
        }

        func hold() {
            held = true
        }

        func allowFutureCalls(_ result: Bool) {
            held = false
            self.result = result
        }

        func run() async -> Bool {
            calls += 1
            guard held else { return result }
            return await withCheckedContinuation { continuation = $0
                waiter?.resume()
                waiter = nil
            }
        }

        func waitUntilHeld() async {
            if continuation != nil { return }
            await withCheckedContinuation { waiter = $0 }
        }

        func release(_ result: Bool) {
            continuation?.resume(returning: result)
            continuation = nil
        }
    }
}

extension GatewayAdaptiveSocketTests {
    private actor ClockGate: GatewayPromotionWaiting {
        private var continuation: CheckedContinuation<Void, Never>?
        private var waiter: CheckedContinuation<Void, Never>?
        func wait() async throws {
            await withCheckedContinuation { continuation = $0
                waiter?.resume()
                waiter = nil
            }
        }

        func waitUntilHeld() async {
            if continuation != nil { return }
            await withCheckedContinuation { waiter = $0 }
        }

        func tick() {
            continuation?.resume()
            continuation = nil
        }
    }

    func testFreshHintCompositionPersistsFactsWithoutReplacingTheAuthenticatedControlSocket() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let owner = try routing(peer)
        let original = Pairing(
            url: origin,
            token: "device-test-token",
            pairingGeneration: "00000000-0000-4000-8000-000000000902",
            accountId: "local",
            deviceId: deviceId,
            gatewayName: "Synthetic production pairing",
            scopes: ["read", "admin"],
            spkiFingerprint: peer.info.spkiFingerprint,
            directCandidates: [GatewayDirectCandidate(address: "10.0.0.2", port: 8443)],
            tlsMode: .pinnedKeyStrict
        )
        let store = InMemoryStore()
        let bundle = PairingCredentialBundle(original, url: origin, tlsMode: original.tlsMode, fingerprint: nil)
        try store.set(bundle.encoded(), forKey: PairingCredentialBundle.key)
        let service = PairingService(store: store, cloudRelayEnabled: true)
        // Removing stale hints changes future routes while the owned loopback WS keeps running.
        // The synthetic persisted hint is never used as a network endpoint by this fixture.
        let facts: [GatewayDirectCandidate] = []
        let discovery = RefreshedDiscovery(expected: original, facts: facts)
        let refresher = GatewayPairedHintRefresher(expected: original, service: service, discovery: discovery)
        let session = owner.session
        // Metadata composition starts with an established protected transport.
        _ = try await session.data(from: origin.appending(path: "health"))
        let socket = DeviceSocket(
            gatewayUrl: origin,
            token: original.token,
            routingOwner: owner,
            expectedDeviceId: deviceId,
            hintRefresher: refresher
        )
        do {
            await socket.start()
            let connected = await socket.waitUntilConnected(timeout: .seconds(5))
            let state = await socket.state()
            let snapshot = try counters(peer)
            XCTAssertTrue(connected, "Socket state: \(state); path: \(owner.connectionPath); counters: \(snapshot)")
            if !connected { throw URLError(.timedOut) }
            await waitForCounter("pathLocal", value: 1, peer: peer)
            let refreshed = try await socket.refreshRoutingHints()
            XCTAssertTrue(refreshed)
            let persisted = try XCTUnwrap(service.current())
            XCTAssertNil(persisted.directCandidates)
            XCTAssertTrue(persisted.sameAuthority(as: original))
            XCTAssertTrue(owner.session === session)
            await socket.emitEvent(type: "connection.path", payload: ["path": .string("local")])
            await waitForCounter("pathLocal", value: 2, peer: peer)
            XCTAssertEqual(try counters(peer)["hellos"], 1)
            await socket.stop()
            let retiredRefresh = try await socket.refreshRoutingHints()
            XCTAssertFalse(retiredRefresh)
        } catch {
            await socket.stop()
            throw error
        }
    }

    private struct RefreshedDiscovery: GatewayDirectDiscovering {
        let expected: Pairing
        let facts: [GatewayDirectCandidate]
        func fetch(origin: URL, token: String, spkiFingerprint: String) async throws -> [GatewayDirectCandidate] {
            XCTAssertEqual(origin, expected.url)
            XCTAssertEqual(token, expected.token)
            XCTAssertEqual(spkiFingerprint, expected.spkiFingerprint)
            return facts
        }
    }
}
#endif
