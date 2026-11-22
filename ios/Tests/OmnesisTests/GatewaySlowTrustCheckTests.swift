// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
import Network
@testable import Omnesis
import XCTest

/// A LAN hint's key check can take as long as the platform's trust evaluation takes. Its candidate
/// deadline must still move on while the check is outstanding, over real TLS handshakes.
@MainActor
final class GatewaySlowTrustCheckTests: XCTestCase {
    func testRoutingProxyFallsBackToTheRelayWhileAWrongKeyCheckIsOutstanding() async throws {
        let gateway = try CloudPairingSOCKSPeer(), unrelated = try CloudPairingSOCKSPeer()
        defer { gateway.stop()
            unrelated.stop()
        }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [.init(address: "127.0.0.1", port: unrelated.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let pin = PinnedSession(spkiFingerprint: gateway.info.spkiFingerprint, host: route.host)
        let hold = HeldTrustCheck(), clock = ScriptedGatewayClock()
        let proxy = try GatewayRoutingProxy(
            route: route,
            limits: .production,
            listenPort: 0,
            relayEndpoint: .hostPort(host: "127.0.0.1", port: XCTUnwrap(NWEndpoint.Port(rawValue: UInt16(gateway.info.targetPort)))),
            clock: clock.clock,
            verifyTrust: { trust, host in
                hold.wait()
                return pin.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
            }
        )
        defer { proxy.close() }
        defer { hold.release() }
        let relay = expectation(description: "The relay is selected while the key check is outstanding")
        let observer = proxy.observePath { path in if path == .relay { relay.fulfill() } }
        defer { proxy.removePathObserver(observer) }
        let configuration = URLSessionConfiguration.ephemeral
        proxy.configure(configuration)
        let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var probe = URLRequest(url: route.origin.appendingPathComponent("probe"))
        probe.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let request = probe
        let response = Task { try await session.data(for: request).0 }
        await fulfillment(of: [hold.entered], timeout: 10)
        // The candidate's deadline is due while its key check has not returned. Expiring it waits on
        // the proxy's queue, so it runs apart from the test: a queue the check holds never answers.
        clock.advance(GatewayRoutingProxy.Limits.production.attempt)
        Task.detached { clock.expireDue() }
        await fulfillment(of: [relay], timeout: 10)
        hold.release()
        let body = try await response.value
        let identity = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(identity["sni"], "gateway.example.test")
        XCTAssertEqual(identity["proxyAuthentication"], "verified")
        XCTAssertEqual(try stats(unrelated)["requests"], 0)
        XCTAssertEqual(try stats(gateway)["requests"], 1)
    }

    func testDirectProbeGivesUpOnItsDeadlineWhileAKeyCheckIsOutstanding() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [.init(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let pin = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: route.host)
        let hold = HeldTrustCheck(), clock = ScriptedGatewayClock()
        defer { hold.release() }
        let finished = expectation(description: "The probe ends on its deadline while the key check is outstanding")
        let probe = Task {
            let reachable = await GatewayDirectProbe.reachable(
                route: route,
                attemptTimeout: 0.75,
                totalTimeout: 5,
                connectTLS: GatewayTLSNetworkConnection.make,
                clock: clock.clock
            ) { trust, host in
                hold.wait()
                return pin.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
            }
            finished.fulfill()
            return reachable
        }
        await fulfillment(of: [hold.entered], timeout: 10)
        clock.advance(0.75)
        Task.detached { clock.expireDue() }
        await fulfillment(of: [finished], timeout: 10)
        hold.release()
        let reachable = await probe.value
        XCTAssertFalse(reachable, "A key check that returns after the deadline cannot select the address")
    }

    private func stats(_ peer: CloudPairingSOCKSPeer) throws -> [String: Int] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))) as? [String: Int])
    }
}

/// Holds every trust check until released, as a stalled trust evaluation does.
private final class HeldTrustCheck: @unchecked Sendable {
    let entered: XCTestExpectation = {
        let entered = XCTestExpectation(description: "A key check started")
        entered.assertForOverFulfill = false
        return entered
    }()

    private let released = DispatchSemaphore(value: 0)

    /// The bound only keeps a broken proxy from wedging the test process.
    func wait() {
        entered.fulfill()
        _ = released.wait(timeout: .now() + 60)
        released.signal()
    }

    func release() {
        released.signal()
    }
}
#endif
