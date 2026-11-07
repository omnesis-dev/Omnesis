// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
import Network
@testable import Omnesis
import XCTest

@MainActor
final class GatewayDirectProbeTests: XCTestCase {
    func testLateVerificationCannotChangeTheCurrentAttemptIdentityVerdict() {
        var state = GatewayProbeAttempt()
        let previous = state.begin()
        let current = state.begin()
        XCTAssertFalse(state.isCurrent(previous))
        XCTAssertTrue(state.isCurrent(current))
        XCTAssertFalse(state.record(current, accepted: false))
        XCTAssertTrue(state.identityRejected)
        XCTAssertFalse(state.record(previous, accepted: true))
        XCTAssertTrue(state.identityRejected)
        let next = state.begin()
        XCTAssertFalse(state.identityRejected)
        XCTAssertTrue(state.record(next, accepted: true))
        XCTAssertFalse(state.record(current, accepted: false))
        XCTAssertFalse(state.identityRejected)
    }

    func testClosedAndSilentCandidatesFallThroughBeforeAnAuthenticatedTLSSelection() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let silent = try SilentProbePeer()
        defer { silent.close() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [
                GatewayDirectCandidate(address: "127.0.0.1", port: peer.info.resetPort),
                GatewayDirectCandidate(address: "127.0.0.1", port: Int(silent.port)),
                GatewayDirectCandidate(address: "127.0.0.1", port: peer.info.targetPort),
            ],
            allowLoopbackForTesting: true
        ))
        let verifier = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: route.host)
        let accepted = await GatewayDirectProbe.reachable(route: route, attemptTimeout: 0.1, totalTimeout: 2) { trust, host in
            verifier.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
        }
        XCTAssertTrue(accepted)
        let expiredBudget = await GatewayDirectProbe.reachable(route: route, attemptTimeout: 0.1, totalTimeout: 0) { _, _ in
            XCTFail("Expired probe attempted TLS verification")
            return true
        }
        XCTAssertFalse(expiredBudget)
        let exhausted = try XCTUnwrap(GatewayDirectRoute(
            origin: route.origin,
            candidates: [
                GatewayDirectCandidate(address: "127.0.0.1", port: Int(silent.port)),
            ],
            allowLoopbackForTesting: true
        ))
        let unreachable = await GatewayDirectProbe.reachable(route: exhausted, attemptTimeout: 0.05, totalTimeout: 0.2) { _, _ in
            XCTFail("Silent peer supplied a certificate")
            return true
        }
        XCTAssertFalse(unreachable)
        let task = Task { await GatewayDirectProbe.reachable(route: exhausted) { _, _ in false } }
        try await Task.sleep(nanoseconds: 20_000_000)
        task.cancel()
        let cancelled = await task.value
        XCTAssertFalse(cancelled)
    }

    func testPromotionRequiresThePinnedKeyCanonicalNameAndCompletedTLSWithoutApplicationData() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [
                GatewayDirectCandidate(address: "127.0.0.1", port: peer.info.targetPort),
            ],
            allowLoopbackForTesting: true
        ))
        let verifier = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: route.host)
        let accepted = await GatewayDirectProbe.reachable(route: route) { trust, host in
            verifier.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
        }
        XCTAssertTrue(accepted)
        let wrong = PinnedSession(spkiFingerprint: String(repeating: "0", count: 64), host: route.host)
        let rejected = await GatewayDirectProbe.reachable(route: route) { trust, host in
            wrong.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
        }
        XCTAssertFalse(rejected)
        let counts = try XCTUnwrap(JSONSerialization
            .jsonObject(with: Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))) as? [String: Int])
        XCTAssertEqual(counts["requests"], 0)
    }

    func testPreCancelledProbesCannotBecomeAnAuthenticatedPath() async throws {
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.invalid")),
            candidates: [
                GatewayDirectCandidate(address: "127.0.0.1", port: 1),
            ],
            allowLoopbackForTesting: true
        ))
        let task = Task {
            await GatewayDirectProbe.reachable(route: route) { _, _ in
                XCTFail("Cancelled probe verified a peer")
                return false
            }
        }
        task.cancel()
        let result = await task.value
        XCTAssertFalse(result)
    }
}

private final class SilentProbePeer: @unchecked Sendable {
    let port: UInt16
    private let listener: NWListener
    private let queue: DispatchQueue
    private let storage: SilentProbeConnections

    init() throws {
        let queue = DispatchQueue(label: "omnesis.test.silent-probe")
        self.queue = queue
        let storage = SilentProbeConnections()
        self.storage = storage
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { connection in
            storage.values.append(connection)
            connection.start(queue: queue)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 2) == .success, let port = listener.port else {
            listener.cancel()
            throw URLError(.cannotConnectToHost)
        }
        self.port = port.rawValue
    }

    func close() {
        queue.sync {
            listener.cancel()
            for connection in storage.values {
                connection.cancel()
            }
            storage.values.removeAll()
        }
    }
}

private final class SilentProbeConnections: @unchecked Sendable {
    /// Accessed only on the owning fixture's serial queue.
    var values: [NWConnection] = []
}
#endif
