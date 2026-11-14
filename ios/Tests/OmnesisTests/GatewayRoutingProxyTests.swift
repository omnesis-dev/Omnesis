// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Darwin
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

/// Real Foundation HTTPS and WebSocket tasks through an authenticated opaque SOCKS peer.
@MainActor
final class GatewayRoutingProxyTests: XCTestCase {
    func testClosingOneControlStreamKeepsTheOtherSelectedPathAlive() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let unavailable = try reserveUnavailablePort()
        defer { Darwin.close(unavailable.fd) }
        for relay in [false, true] {
            let route = try XCTUnwrap(try GatewayDirectRoute(
                origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
                candidates: [
                    GatewayDirectCandidate(address: "127.0.0.1", port: relay ? Int(unavailable.port) : peer.info.targetPort),
                ],
                allowLoopbackForTesting: true
            ))
            let limits = GatewayRoutingProxy.Limits(handshake: 1, attempt: 0.1, lanBudget: 1, fallback: 1, idle: 5)
            let proxy = try GatewayRoutingProxy(
                route: route,
                limits: limits,
                listenPort: 0,
                relayEndpoint: .hostPort(
                    host: "127.0.0.1",
                    port: XCTUnwrap(NWEndpoint.Port(rawValue: UInt16(peer.info.targetPort)))
                )
            )
            defer { proxy.close() }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForResource = 5
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
            let first = session.webSocketTask(with: upgrade)
            let second = session.webSocketTask(with: upgrade)
            first.resume()
            second.resume()
            defer { first.cancel(with: .normalClosure, reason: nil)
                second.cancel(with: .normalClosure, reason: nil)
            }
            _ = try await first.receive()
            _ = try await second.receive()
            XCTAssertEqual(proxy.activeStreamCount, 2)
            XCTAssertEqual(proxy.connectionPath, relay ? .relay : .local)
            first.cancel(with: .normalClosure, reason: nil)
            for _ in 0 ..< 100 {
                if proxy.activeStreamCount == 1 { break }
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            XCTAssertEqual(proxy.activeStreamCount, 1)
            XCTAssertEqual(proxy.connectionPath, relay ? .relay : .local)
            second.cancel(with: .normalClosure, reason: nil)
            await waitForClosedStreams(proxy)
            XCTAssertEqual(proxy.activeStreamCount, 0)
            XCTAssertEqual(proxy.connectionPath, .reconnecting)
        }
    }

    func testFallbackReportsRelayAndObserversRetireWithTheSession() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let unavailable = try reserveUnavailablePort()
        defer { Darwin.close(unavailable.fd) }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [
                GatewayDirectCandidate(address: "127.0.0.1", port: Int(unavailable.port)),
            ],
            allowLoopbackForTesting: true
        ))
        let limits = GatewayRoutingProxy.Limits(handshake: 1, attempt: 0.05, lanBudget: 0, fallback: 1, idle: 2)
        let proxy = try GatewayRoutingProxy(
            route: route,
            limits: limits,
            listenPort: 0,
            relayEndpoint: .hostPort(
                host: "127.0.0.1",
                port: XCTUnwrap(NWEndpoint.Port(rawValue: UInt16(peer.info.targetPort)))
            )
        )
        defer { proxy.close() }
        XCTAssertEqual(proxy.connectionPath, .reconnecting)
        let selected = expectation(description: "Relay TCP route selected")
        let observer = proxy.observePath { path in if path == .relay { selected.fulfill() } }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 5
        proxy.configure(configuration)
        let pin = PinnedSession(
            fingerprintHex: peer.info.fingerprint,
            host: route.host,
            systemTrust: { _, _ in false },
            requireCertificateValidity: true
        )
        let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = try URLRequest(url: XCTUnwrap(URL(string: "https://gateway.example.test/probe")))
        request.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: request)
        try assertCanonicalIdentity(data)
        await fulfillment(of: [selected], timeout: 2)
        proxy.removePathObserver(observer)
        proxy.removePathObserver(observer)
        proxy.close()
        XCTAssertEqual(proxy.connectionPath, .reconnecting)
        let closed = expectation(description: "Closed observer receives current state")
        proxy.observePath { path in
            XCTAssertEqual(path, .reconnecting)
            closed.fulfill()
        }
        await fulfillment(of: [closed], timeout: 2)
    }

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
        let limits = GatewayRoutingProxy.Limits(handshake: 1, attempt: 0.2, lanBudget: 1, fallback: 0.1, idle: 0.5)
        let proxy = try GatewayRoutingProxy(route: route, limits: limits, listenPort: 0)
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
        await fulfillment(of: [local, reconnecting], timeout: 3)
        XCTAssertEqual(proxy.activeStreamCount, 0)
    }
}

extension GatewayRoutingProxyTests {
    func testAuthenticatedSOCKSPreservesCanonicalTLSAndHTTPIdentityForHTTPAndWebSockets() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 12
        configuration.httpCookieStorage = nil
        var proxy = try ProxyConfiguration(socksv5Proxy: .hostPort(
            host: "127.0.0.1", port: XCTUnwrap(NWEndpoint.Port(rawValue: UInt16(peer.info.proxyPort)))
        ))
        proxy.applyCredential(username: "fixture-proxy", password: "fixture-password")
        proxy.allowFailover = false
        configuration.proxyConfigurations = [proxy]
        let pin = PinnedSession(
            fingerprintHex: peer.info.fingerprint,
            host: "gateway.example.test",
            systemTrust: { _, _ in false },
            requireCertificateValidity: true
        )
        let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = try URLRequest(url: XCTUnwrap(URL(string: "https://gateway.example.test/probe")))
        request.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        try assertCanonicalIdentity(data)
        var upgrade = try URLRequest(url: XCTUnwrap(URL(string: "wss://gateway.example.test/events")))
        upgrade.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: upgrade)
        socket.resume()
        defer { socket.cancel(with: .normalClosure, reason: nil) }
        switch try await socket.receive() {
        case .string(let text): try assertCanonicalIdentity(Data(text.utf8))
        case .data(let bytes): try assertCanonicalIdentity(bytes)
        @unknown default: XCTFail("Unknown WebSocket message")
        }
    }

    func testProductionProxyRoutesRealHTTPSAndWebSocketsAndClosesIrreversibly() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [GatewayDirectCandidate(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let proxy = try GatewayRoutingProxy(route: route)
        defer { proxy.close() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 8
        configuration.httpCookieStorage = nil
        proxy.configure(configuration)
        let pin = PinnedSession(
            fingerprintHex: peer.info.fingerprint,
            host: route.host,
            systemTrust: { _, _ in false },
            requireCertificateValidity: true
        )
        let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = try URLRequest(url: XCTUnwrap(URL(string: "https://gateway.example.test/probe")))
        request.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        try assertCanonicalIdentity(data)
        var upgrade = try URLRequest(url: XCTUnwrap(URL(string: "wss://gateway.example.test/events")))
        upgrade.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: upgrade)
        socket.resume()
        defer { socket.cancel(with: .normalClosure, reason: nil) }
        switch try await socket.receive() {
        case .string(let text): try assertCanonicalIdentity(Data(text.utf8))
        case .data(let bytes): try assertCanonicalIdentity(bytes)
        @unknown default: XCTFail("Unknown WebSocket message")
        }
        XCTAssertGreaterThan(proxy.activeStreamCount, 0)
        proxy.close()
        proxy.close()
        XCTAssertEqual(proxy.activeStreamCount, 0)
        do { _ = try await session.data(for: request)
            XCTFail("Closed proxy reopened or bypassed")
        } catch { XCTAssertTrue(error is URLError) }
    }

    func testProductionProxyRejectsUnauthenticatedAndWrongTargetPeersAndBoundsIdleHandshakes() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [GatewayDirectCandidate(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let limits = GatewayRoutingProxy.Limits(handshake: 0.1, attempt: 0.05, lanBudget: 0.1, fallback: 0.1, idle: 0.1)
        let proxy = try GatewayRoutingProxy(route: route, limits: limits, listenPort: 0)
        defer { proxy.close() }
        for bytes in [Data([5, 1, 0]), Data([4, 1, 2])] {
            let fd = try openLocalSocket(proxy.listeningPort)
            defer { Darwin.close(fd) }
            try sendBytes(bytes, to: fd)
            XCTAssertEqual(try readBytes(2, from: fd), Data([5, 255]))
        }
        let wrong = try openLocalSocket(proxy.listeningPort)
        defer { Darwin.close(wrong) }
        try sendBytes(Data([5, 1, 2]), to: wrong)
        XCTAssertEqual(try readBytes(2, from: wrong), Data([5, 2]))
        try sendBytes(Data([1, 1, 65, 1, 66]), to: wrong)
        XCTAssertEqual(try readBytes(2, from: wrong), Data([1, 1]))
        let silent = try openLocalSocket(proxy.listeningPort)
        defer { Darwin.close(silent) }
        XCTAssertThrowsError(try readBytes(1, from: silent))
        await waitForClosedStreams(proxy)
        XCTAssertEqual(proxy.activeStreamCount, 0)
    }

    func testProductionProxyCapsConcurrentClientsAndReleasesItsListener() async throws {
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [GatewayDirectCandidate(address: "127.0.0.1", port: 1)],
            allowLoopbackForTesting: true
        ))
        let limits = GatewayRoutingProxy.Limits(handshake: 2, attempt: 0.02, lanBudget: 0.03, fallback: 0.05, idle: 0.1)
        var proxy: GatewayRoutingProxy? = try GatewayRoutingProxy(route: route, limits: limits, listenPort: 0)
        let port = try XCTUnwrap(proxy?.listeningPort)
        var sockets: [Int32] = []
        defer { sockets.forEach { Darwin.close($0) }
            proxy?.close()
        }
        for _ in 0 ..< 17 {
            try sockets.append(openLocalSocket(port))
        }
        for _ in 0 ..< 100 {
            if proxy?.activeStreamCount == 16 { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(proxy?.activeStreamCount, 16)
        proxy?.close()
        XCTAssertEqual(proxy?.activeStreamCount, 0)
        proxy = nil
        var released = false
        for _ in 0 ..< 100 {
            do { try Darwin.close(openLocalSocket(port)) } catch { released = true
                break
            }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(released, "Cancelled listener retained its endpoint")
    }

    func testProductionProxyFallsBackOnlyWhileSelectingTCPBeforeAnyTLSBytes() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let unavailable = try reserveUnavailablePort()
        defer { Darwin.close(unavailable.fd) }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [
                GatewayDirectCandidate(address: "127.0.0.1", port: Int(unavailable.port)),
                GatewayDirectCandidate(address: "127.0.0.1", port: peer.info.targetPort),
            ],
            allowLoopbackForTesting: true
        ))
        let limits = GatewayRoutingProxy.Limits(handshake: 1, attempt: 0.05, lanBudget: 1, fallback: 0.1, idle: 1)
        let proxy = try GatewayRoutingProxy(route: route, limits: limits, listenPort: 0)
        defer { proxy.close() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 3
        proxy.configure(configuration)
        let pin = PinnedSession(
            fingerprintHex: peer.info.fingerprint,
            host: route.host,
            systemTrust: { _, _ in false },
            requireCertificateValidity: true
        )
        let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = try URLRequest(url: XCTUnwrap(URL(string: "https://gateway.example.test/probe")))
        request.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: request)
        try assertCanonicalIdentity(data)
    }

    func testInitialRecoveryRequiresAStableNonzeroEndpoint() throws {
        let route = try GatewayDirectRoute.maintained(origin: XCTUnwrap(URL(string: "https://gateway.example.test")), candidates: [])
        XCTAssertThrowsError(try GatewayRoutingProxy(route: route, limits: .production, listenPort: 0, recoverInitialListener: true))
    }

    func testUnreachableRoutesAndOccupiedListenerFailClosedWithinTheirBudgets() async throws {
        let unavailable = try reserveUnavailablePort()
        defer { Darwin.close(unavailable.fd) }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.invalid")),
            candidates: [GatewayDirectCandidate(address: "127.0.0.1", port: Int(unavailable.port))],
            allowLoopbackForTesting: true
        ))
        let limits = GatewayRoutingProxy.Limits(handshake: 1, attempt: 0.03, lanBudget: 0.1, fallback: 0.05, idle: 0.1)
        XCTAssertThrowsError(try GatewayRoutingProxy(route: route, limits: limits, listenPort: unavailable.port))
        let proxy = try GatewayRoutingProxy(route: route, limits: limits, listenPort: 0)
        defer { proxy.close() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 1
        configuration.timeoutIntervalForResource = 2
        proxy.configure(configuration)
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        do { _ = try await session.data(from: XCTUnwrap(URL(string: "https://gateway.example.invalid/probe")))
            XCTFail("Unreachable proxy bypassed")
        } catch { XCTAssertTrue(error is URLError) }
        await waitForClosedStreams(proxy)
        XCTAssertEqual(proxy.activeStreamCount, 0)
    }

    func testProductionProxyDoesNotFallBackAfterTLSIdentityFailure() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [
                GatewayDirectCandidate(address: "127.0.0.1", port: peer.info.targetPort),
                GatewayDirectCandidate(address: "127.0.0.1", port: peer.info.secondTargetPort),
            ],
            allowLoopbackForTesting: true
        ))
        let proxy = try GatewayRoutingProxy(route: route)
        defer { proxy.close() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 3
        proxy.configure(configuration)
        let pin = PinnedSession(
            fingerprintHex: String(repeating: "0", count: 64),
            host: route.host,
            systemTrust: { _, _ in false },
            requireCertificateValidity: true
        )
        let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do { _ = try await session.data(from: XCTUnwrap(URL(string: "https://gateway.example.test/probe")))
            XCTFail("Wrong pin accepted")
        } catch { XCTAssertTrue(error is URLError) }
        await waitForClosedStreams(proxy)
        XCTAssertEqual(proxy.activeStreamCount, 0)
        let counts = try XCTUnwrap(JSONSerialization
            .jsonObject(with: Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))) as? [String: Int])
        XCTAssertGreaterThan(try XCTUnwrap(counts["primary"]), 0)
        XCTAssertEqual(counts["secondary"], 0)
    }

    private func waitForClosedStreams(_ proxy: GatewayRoutingProxy) async {
        for _ in 0 ..< 100 {
            if proxy.activeStreamCount == 0 { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private func reserveUnavailablePort() throws -> (fd: Int32, port: UInt16) {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw URLError(.cannotConnectToHost) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { Darwin.close(fd)
            throw URLError(.cannotConnectToHost)
        }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let inspected = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard inspected == 0 else { Darwin.close(fd)
            throw URLError(.cannotConnectToHost)
        }
        return (fd, address.sin_port.bigEndian)
    }

    private func openLocalSocket(_ port: UInt16) throws -> Int32 {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw URLError(.cannotConnectToHost) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard result == 0 else { Darwin.close(fd)
            throw URLError(.cannotConnectToHost)
        }
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        _ = withUnsafePointer(to: &timeout) { setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, $0, socklen_t(MemoryLayout<timeval>.size)) }
        return fd
    }

    private func sendBytes(_ data: Data, to fd: Int32) throws {
        let sent = data.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, $0.count, 0) }
        guard sent == data.count else { throw URLError(.networkConnectionLost) }
    }

    private func readBytes(_ count: Int, from fd: Int32) throws -> Data {
        var result = Data()
        while result.count < count {
            var bytes = [UInt8](repeating: 0, count: count - result.count)
            let length = bytes.withUnsafeMutableBytes { Darwin.recv(fd, $0.baseAddress, $0.count, 0) }
            guard length > 0 else { throw URLError(.networkConnectionLost) }
            result.append(contentsOf: bytes.prefix(length))
        }
        return result
    }

    private func assertCanonicalIdentity(_ data: Data) throws {
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(result["sni"], "gateway.example.test")
        XCTAssertEqual(result["host"], "gateway.example.test")
        XCTAssertEqual(result["authorization"], "Bearer device-test-token")
        XCTAssertEqual(result["proxyAuthentication"], "verified")
    }
}

extension GatewayRoutingProxyTests {
    func testInitialListenerFailureAndReadinessTimeoutHealThePublishedSession() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [.init(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        for stalled in [false, true] {
            let factory = RepairableLiveListenerFactory(initialFailures: stalled ? 0 : 1, stallFirst: stalled, holdStartup: true)
            let port = try GatewayLoopbackSocket.releaseEphemeralPort()
            let pin = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: route.host)
            let proxy = try GatewayRoutingProxy(
                route: route,
                limits: .production,
                listenPort: port,
                recoverInitialListener: true,
                transport: factory.transport,
                clock: ScriptedGatewayClock().clock,
                verifyTrust: { trust, host in pin.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false) }
            )
            defer { proxy.close() }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForResource = 10
            proxy.configure(configuration)
            let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            var unavailable = URLRequest(url: route.origin.appendingPathComponent("probe"))
            unavailable.timeoutInterval = 2
            unavailable.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
            do { _ = try await session.data(for: unavailable)
                XCTFail("Unavailable listener completed HTTP")
            } catch { XCTAssertTrue(error is URLError) }
            unavailable.url = try XCTUnwrap(URL(string: "wss://gateway.example.test/events"))
            let interrupted = session.webSocketTask(with: unavailable)
            interrupted.resume()
            do { _ = try await interrupted.receive()
                XCTFail("Unavailable listener completed WebSocket")
            } catch { XCTAssertTrue(error is URLError) }
            interrupted.cancel(with: .goingAway, reason: nil)
            factory.allowStartup()
            let deadline = ContinuousClock.now + .seconds(8)
            while !proxy.isListening, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertTrue(proxy.isListening)
            XCTAssertEqual(proxy.listeningPort, port)
            var request = URLRequest(url: route.origin.appendingPathComponent("probe"))
            request.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
            let (data, _) = try await session.data(for: request)
            try assertCanonicalIdentity(data)
            request.url = try XCTUnwrap(URL(string: "wss://gateway.example.test/events"))
            let socket = session.webSocketTask(with: request)
            socket.resume()
            _ = try await socket.receive()
            socket.cancel(with: .goingAway, reason: nil)
            XCTAssertEqual(factory.count, stalled ? 2 : 1)
        }
    }

    func testWrongKeyLANHintFallsBackToRelayWithoutApplicationBytes() async throws {
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
        let proxy = try GatewayRoutingProxy(
            route: route,
            limits: .production,
            listenPort: 0,
            relayEndpoint: .hostPort(host: "127.0.0.1", port: XCTUnwrap(NWEndpoint.Port(rawValue: UInt16(gateway.info.targetPort)))),
            verifyTrust: { trust, host in pin.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false) }
        )
        defer { proxy.close() }
        let selected = expectation(description: "Wrong-key LAN hint falls back to relay")
        let observer = proxy.observePath { path in if path == .relay { selected.fulfill() } }
        defer { proxy.removePathObserver(observer) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 10
        proxy.configure(configuration)
        let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: route.origin.appendingPathComponent("probe"))
        request.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: request)
        try assertCanonicalIdentity(data)
        // The HTTP peer closes its connection after replying, so the proxy can
        // already be reconnecting when URLSession delivers the response.
        await fulfillment(of: [selected], timeout: 2)
        let rejected = try stats(unrelated)
        XCTAssertGreaterThan(rejected["primary"] ?? 0, 0)
        XCTAssertEqual(rejected["requests"], 0)
        XCTAssertEqual(try stats(gateway)["requests"], 1)
    }

    func testAuthenticatedLANPreflightDoesNotReplaceApplicationTLSVerification() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [.init(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let proxy = try GatewayRoutingProxy(route: route, verifyTrust: { _, _ in true })
        defer { proxy.close() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 5
        proxy.configure(configuration)
        let rejected = PinnedSession(spkiFingerprint: String(repeating: "0", count: 64), host: route.host)
        let session = URLSession(configuration: configuration, delegate: rejected, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: route.origin.appendingPathComponent("probe"))
        request.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        do { _ = try await session.data(for: request)
            XCTFail("Preflight bypassed the application pin")
        } catch { XCTAssertTrue(error is URLError) }
        XCTAssertEqual(try stats(peer)["requests"], 0)
    }

    func testFaultedListenerRecoversHTTPAndWebSocketOnTheSameSessionAndEndpoint() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let route = try XCTUnwrap(try GatewayDirectRoute(
            origin: XCTUnwrap(URL(string: "https://gateway.example.test")),
            candidates: [.init(address: "127.0.0.1", port: peer.info.targetPort)],
            allowLoopbackForTesting: true
        ))
        let factory = RepairableLiveListenerFactory()
        let pin = PinnedSession(spkiFingerprint: peer.info.spkiFingerprint, host: route.host)
        // Candidate deadlines run on a scripted clock: a verification slower than the attempt budget, as on a
        // busy runner, must still select the loopback candidate, since the relay name resolves nowhere here.
        let stall = FirstTrustStall()
        let proxy = try GatewayRoutingProxy(
            route: route,
            limits: .production,
            listenPort: 0,
            transport: factory.transport,
            clock: ScriptedGatewayClock().clock,
            verifyTrust: { trust, host in
                stall.once()
                return pin.resolve(trust, challengeHost: host) == .pinned(systemTrusted: false)
            }
        )
        defer { proxy.close() }
        let endpoint = proxy.listeningPort
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 10
        proxy.configure(configuration)
        let session = URLSession(configuration: configuration, delegate: pin, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: route.origin.appendingPathComponent("probe"))
        request.setValue("Bearer device-test-token", forHTTPHeaderField: "Authorization")
        let (first, _) = try await session.data(for: request)
        try assertCanonicalIdentity(first)
        var upgrade = request
        upgrade.url = try XCTUnwrap(URL(string: "wss://gateway.example.test/events"))
        let old = session.webSocketTask(with: upgrade)
        old.resume()
        _ = try await old.receive()
        factory.cancelCurrent()
        do { _ = try await old.receive()
            XCTFail("Faulted listener retained an old control stream")
        } catch { /* The retired control stream must fail. */ }
        old.cancel(with: .goingAway, reason: nil)
        let deadline = ContinuousClock.now + .seconds(5)
        while !proxy.isListening || factory.count < 2, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(proxy.isListening)
        XCTAssertEqual(factory.count, 2)
        XCTAssertEqual(proxy.listeningPort, endpoint)
        let (second, _) = try await session.data(for: request)
        try assertCanonicalIdentity(second)
        let replacement = session.webSocketTask(with: upgrade)
        replacement.resume()
        _ = try await replacement.receive()
        replacement.cancel(with: .goingAway, reason: nil)
        XCTAssertEqual(try stats(peer)["requests"], 4)
    }

    private func stats(_ peer: CloudPairingSOCKSPeer) throws -> [String: Int] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))) as? [String: Int])
    }
}

private final class RepairableLiveListenerFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var listeners: [any GatewayByteListener] = []
    private var initialFailures: Int
    private let stallFirst: Bool
    private var holdStartup: Bool
    init(initialFailures: Int = 0, stallFirst: Bool = false, holdStartup: Bool = false) {
        self.initialFailures = initialFailures
        self.stallFirst = stallFirst
        self.holdStartup = holdStartup
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return listeners.count
    }

    func allowStartup() {
        lock.lock()
        holdStartup = false
        lock.unlock()
    }

    func cancelCurrent() {
        lock.lock()
        let listener = listeners.last
        lock.unlock()
        listener?.cancel()
    }

    var transport: GatewayNetworkTransport {
        GatewayNetworkTransport(makeConnection: GatewayNetworkTransport.live.makeConnection, makeListener: { parameters in
            self.lock.lock()
            if self.initialFailures > 0 || (self.holdStartup && (!self.stallFirst || !self.listeners.isEmpty)) {
                self.initialFailures = max(0, self.initialFailures - 1)
                self.lock.unlock()
                throw GatewayRoutingError.listenerUnavailable
            }
            let stall = self.stallFirst && self.listeners.isEmpty
            self.lock.unlock()
            let listener = try GatewayNetworkTransport.live.makeListener(parameters)
            let wrapped = StalledLiveListener(listener, stall: stall)
            self.lock.lock()
            self.listeners.append(wrapped)
            self.lock.unlock()
            return wrapped
        })
    }
}

/// Holds the first trust verification past the production per-candidate budget, as a stalled runner can.
private final class FirstTrustStall: @unchecked Sendable {
    private let lock = NSLock()
    private var stalled = false
    func once() {
        lock.lock()
        defer { lock.unlock() }
        guard !stalled else { return }
        stalled = true
        Thread.sleep(forTimeInterval: GatewayRoutingProxy.Limits.production.attempt + 0.25)
    }
}

private final class StalledLiveListener: GatewayByteListener {
    private let wrapped: any GatewayByteListener
    private let stall: Bool
    init(_ wrapped: any GatewayByteListener, stall: Bool) {
        self.wrapped = wrapped
        self.stall = stall
    }

    var port: UInt16? {
        wrapped.port
    }

    func onState(_ handler: @escaping (NWListener.State) -> Void) {
        wrapped.onState { state in
            if self.stall, case .ready = state { return }
            handler(state)
        }
    }

    func onConnection(_ handler: @escaping (any GatewayByteConnection) -> Void) {
        wrapped.onConnection(handler)
    }

    func start(queue: DispatchQueue) {
        wrapped.start(queue: queue)
    }

    func cancel() {
        wrapped.cancel()
    }
}
#endif
