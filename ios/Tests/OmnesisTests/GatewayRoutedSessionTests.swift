// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
@testable import Omnesis
import XCTest

@MainActor
final class GatewayRoutedSessionTests: XCTestCase {
    private let origin = URL(string: "https://gateway.example.test")!

    func testListenerFailureAndInvalidRouteAuthorityCannotOpenDirectOrPublicFallback() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(GatewayDirectRoute(
            origin: origin,
            candidates: [.init(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let owners = [
            PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: origin.host, directRoute: route, proxyFactory: FailedFactory()),
            PinnedSession(fingerprintHex: peer.info.fingerprint, directRoute: route), // legacy pins cannot enable the proxy
            PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: "different.example.test", directRoute: route),
            PinnedSession(spkiFingerprint: "malformed", directRoute: route),
        ]
        for owner in owners {
            let session = owner.session
            do { _ = try await session.data(from: origin)
                XCTFail("Invalid routed configuration released a request")
            } catch { XCTAssertTrue(error is URLError) }
            XCTAssertEqual(owner.connectionPath, .reconnecting)
            let available = await owner.directPathAvailable()
            XCTAssertFalse(available)
            XCTAssertNil(owner.observeRoutePath { _ in })
            owner.removeRoutePathObserver(UUID())
            owner.retireRouting()
        }
        let stats = try XCTUnwrap(JSONSerialization
            .jsonObject(with: Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))) as? [String: Int])
        XCTAssertEqual(stats["primary"], 0)
        XCTAssertEqual(stats["requests"], 0)
    }

    func testUnavailableAndRetiredLeasesRejectOwnedHTTPAndWebSocketTargetsWithoutCrashing() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(GatewayDirectRoute(
            origin: origin,
            candidates: [.init(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let failed = PinnedSession(
            spkiFingerprint: peer.info.spkiFingerprint,
            host: origin.host,
            directRoute: route,
            proxyFactory: FailedFactory()
        )
        let retiredBeforeCreation = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: origin.host, directRoute: route)
        retiredBeforeCreation.retireRouting()
        let retiredAfterCreation = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: origin.host, directRoute: route)
        let oldSession = retiredAfterCreation.session
        retiredAfterCreation.retireRouting()
        for (index, session) in [failed.session, retiredBeforeCreation.session, oldSession, retiredAfterCreation.session].enumerated() {
            var request = try URLRequest(url: XCTUnwrap(URL(string: "http://127.0.0.1:\(peer.info.plainPort)/private")))
            request.setValue("Bearer test-token", forHTTPHeaderField: "Authorization")
            do { _ = try await session.data(for: request)
                XCTFail("Retired lease released HTTP bytes")
            } catch { XCTAssertTrue(error is URLError) }
            for scheme in ["ws", "wss"] {
                var upgrade = request
                upgrade.url = try XCTUnwrap(URL(string: "\(scheme)://127.0.0.1:\(peer.info.plainPort)/private"))
                let socket = session.webSocketTask(with: upgrade)
                socket.resume()
                do { _ = try await socket.receive()
                    XCTFail("Retired lease released WebSocket bytes")
                } catch { XCTAssertTrue(error is URLError) }
                socket.cancel(with: .goingAway, reason: nil)
                let snapshot = try XCTUnwrap(JSONSerialization
                    .jsonObject(with: Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))) as? [String: Int])
                XCTAssertEqual(snapshot["plaintext"], 0, "Application request escaped lease \(index), scheme \(scheme)")
            }
        }
        let stats = try XCTUnwrap(JSONSerialization
            .jsonObject(with: Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))) as? [String: Int])
        XCTAssertEqual(stats["plaintext"], 0)
        XCTAssertEqual(stats["requests"], 0)
        failed.retireRouting()
        retiredBeforeCreation.retireRouting()
    }

    func testStrictLeafAndInferredCanonicalKeyHostKeepTheirOwnAuthorityAndRetirement() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(GatewayDirectRoute(
            origin: origin,
            candidates: [.init(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let key = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, directRoute: route)
        let leaf = PinnedSession(fingerprintHex: peer.info.fingerprint, requireCertificateValidity: true, directRoute: route)
        for owner in [key, leaf] {
            let session = owner.session
            let (data, _) = try await session.data(from: origin.appendingPathComponent("probe"))
            XCTAssertFalse(data.isEmpty)
            owner.retireRouting()
            owner.retireRouting()
            let next = owner.session
            do { _ = try await next.data(from: origin)
                XCTFail("Retired proxy reopened")
            } catch { XCTAssertTrue(error is URLError) }
        }
    }

    func testValidatedFutureRouteSnapshotsAndEmptyHintsKeepOneLiveSessionUntilRetirement() async throws {
        let route = try GatewayDirectRoute.maintained(origin: origin, candidates: [])
        let owner = PinnedSession(spkiFingerprint: String(repeating: "ab", count: 32), host: origin.host, directRoute: route)
        let empty = await owner.directPathAvailable()
        XCTAssertFalse(empty)
        let facts = [GatewayDirectCandidate(address: "10.0.0.2", port: 8443)]
        try owner.updateCandidates(facts)
        let session = owner.session // Starts an owned listener; does not dial any candidate.
        try owner.updateCandidates([])
        XCTAssertTrue(owner.session === session)
        let cleared = await owner.directPathAvailable()
        XCTAssertFalse(cleared)
        let trust = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        XCTAssertEqual(owner.resolve(trust, challengeHost: "different.example.test"), .rejected)
        owner.retireRouting()
        XCTAssertEqual(try owner.resolve(trust, challengeHost: XCTUnwrap(origin.host)), .rejected)
        XCTAssertThrowsError(try owner.updateCandidates(facts))
        let failed = PinnedSession(
            spkiFingerprint: String(repeating: "ab", count: 32),
            host: origin.host,
            directRoute: route,
            proxyFactory: FailedFactory()
        )
        _ = failed.session
        XCTAssertThrowsError(try failed.updateCandidates(facts))
        failed.retireRouting()
        let unrouted = PinnedSession(spkiFingerprint: String(repeating: "ab", count: 32), host: origin.host)
        XCTAssertThrowsError(try unrouted.updateCandidates(facts))
    }

    func testRetiringTheLeaseCancelsAnOpenOwnedWebSocketWithoutInvalidatingItsSession() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(GatewayDirectRoute(
            origin: origin,
            candidates: [.init(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let owner = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: origin.host, directRoute: route)
        let session = owner.session
        var request = try URLRequest(url: XCTUnwrap(URL(string: "wss://gateway.example.test/events")))
        request.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: request)
        socket.resume()
        _ = try await socket.receive()
        owner.retireRouting()
        do { _ = try await socket.receive()
            XCTFail("Retired WebSocket remained usable")
        } catch {
            // Foundation may surface either URL loading failure or the underlying
            // socket reset when the byte-forwarding lease closes. Both terminate receive.
        }
        socket.cancel(with: .goingAway, reason: nil)
        // The SDK object remains valid for callers still holding it; transport refuses new I/O normally.
        let task = session.dataTask(with: origin)
        task.cancel()
    }

    func testPromotionClockWaitsAndHonorsCancellation() async throws {
        try await GatewayPromotionClock(interval: .milliseconds(1)).wait()
        let task = Task { try await GatewayPromotionClock().wait() }
        task.cancel()
        do { try await task.value
            XCTFail("Cancelled clock completed")
        } catch is CancellationError {}
    }

    private struct FailedFactory: GatewayRoutingProxyCreating {
        func create(route: GatewayDirectRoute, verifyTrust: @escaping GatewayDirectProbe.TrustVerifier) throws -> GatewayRoutingProxy {
            throw GatewayRoutingError.listenerUnavailable
        }
    }
}
#endif
