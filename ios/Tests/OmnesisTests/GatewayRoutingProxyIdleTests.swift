// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
import Network
@testable import Omnesis
import XCTest

private final class PathObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var seenLocal = false
    func markLocal() {
        lock.lock()
        seenLocal = true
        lock.unlock()
    }

    var hasSeenLocal: Bool {
        lock.lock()
        defer { lock.unlock() }
        return seenLocal
    }
}

/// The routing proxy retires a quiet stream after its idle limit and tells its observers.
@MainActor
final class GatewayRoutingProxyIdleTests: XCTestCase {
    func testLocalObserversSeeIdleSocketRetirement() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [
                GatewayDirectCandidate(address: "127.0.0.1", port: peer.info.targetPort),
            ],
            allowLoopbackForTesting: true
        ))
        // Every deadline runs on a scripted clock, so a runner slower than the attempt budget still selects the
        // loopback candidate; the test then moves time past the idle limit itself. Only the idle limit is short,
        // so moving the clock never reaches another deadline.
        let clock = ScriptedGatewayClock()
        let limits = GatewayRoutingProxy.Limits(handshake: 60, attempt: 60, lanBudget: 60, fallback: 60, idle: 0.5)
        let proxy = try GatewayRoutingProxy(route: route, limits: limits, listenPort: 0, clock: clock.clock)
        defer { proxy.close() }
        let local = expectation(description: "Local selection")
        let reconnecting = expectation(description: "Idle connection retired")
        let observed = PathObservation()
        proxy.observePath { path in
            if path == .local { observed.markLocal()
                local.fulfill()
            }
            if path == .reconnecting, observed.hasSeenLocal { reconnecting.fulfill() }
        }
        let configuration = URLSessionConfiguration.ephemeral
        proxy.configure(configuration)
        let pin = PinnedSession(
            fingerprintHex: peer.info.fingerprint,
            host: route.host,
            systemTrust: { _, _ in false },
            requireCertificateValidity: true
        )
        let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var upgrade = try URLRequest(url: XCTUnwrap(URL(string: "wss://gateway.example.test/events")))
        upgrade.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: upgrade)
        socket.resume()
        defer { socket.cancel(with: .normalClosure, reason: nil) }
        _ = try await socket.receive()
        await fulfillment(of: [local], timeout: 5)
        // The idle timer is armed once the stream goes quiet; keep moving the clock and firing what fell due until
        // the proxy retires the stream.
        let retired = Task {
            while !Task.isCancelled {
                clock.advance(0.1)
                clock.expireDue()
                try await Task.sleep(for: .milliseconds(20))
            }
        }
        defer { retired.cancel() }
        await fulfillment(of: [reconnecting], timeout: 5)
        XCTAssertEqual(proxy.activeStreamCount, 0)
    }
}
#endif
