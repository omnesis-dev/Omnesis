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

#endif
