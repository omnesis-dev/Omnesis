// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation
@testable import Omnesis
import XCTest

final class GatewayUnavailableProxyTests: XCTestCase {
    func testEphemeralReservationIsReleasedBeforeItsPortIsHandedToAListener() throws {
        let socket = UnavailableSocketScript()
        let port = try GatewayLoopbackSocket.releaseEphemeralPort(operations: socket.operations)
        XCTAssertGreaterThan(port, 0)
        XCTAssertEqual(socket.closed, [42])
        XCTAssertEqual(socket.calls, ["open", "bind", "name", "close"])
        for stage in 0 ... 2 {
            let failed = UnavailableSocketScript(failure: stage)
            XCTAssertThrowsError(try GatewayLoopbackSocket.releaseEphemeralPort(operations: failed.operations))
            XCTAssertEqual(failed.closed, stage == 0 ? [] : [42])
        }
    }

    func testAZeroAssignedPortIsRejectedAndItsDescriptorReleased() {
        let socket = UnavailableSocketScript()
        socket.assignedPort = 0
        XCTAssertThrowsError(try GatewayLoopbackSocket.releaseEphemeralPort(operations: socket.operations))
        XCTAssertEqual(socket.closed, [42])
    }

    func testLiveSocketCanBeAllocatedConfiguredAndReleasedWithoutListening() throws {
        var proxy: GatewayUnavailableProxy? = try GatewayUnavailableProxy()
        let configuration = URLSessionConfiguration.ephemeral
        proxy?.configure(configuration)
        XCTAssertEqual(configuration.proxyConfigurations.count, 1)
        proxy = nil
        XCTAssertNotNil(GatewayUnavailableProxy.shared)
    }

    func testSocketFailuresReleaseOnlyOwnedDescriptorsExactlyOnce() {
        for stage in 0 ... 2 {
            let socket = UnavailableSocketScript(failure: stage)
            XCTAssertThrowsError(try GatewayUnavailableProxy(operations: socket.operations)) { error in
                XCTAssertEqual(error as? GatewayRoutingError, .listenerUnavailable)
            }
            XCTAssertEqual(socket.calls, Array(["open", "bind", "name"].prefix(stage + 1)) + (stage == 0 ? [] : ["close"]))
            XCTAssertEqual(socket.closed, stage == 0 ? [] : [42])
        }
    }

    func testSuccessfulSocketIsLoopbackBoundAndReleasedOnDeinit() throws {
        let socket = UnavailableSocketScript()
        var proxy: GatewayUnavailableProxy? = try GatewayUnavailableProxy(operations: socket.operations)
        let configuration = URLSessionConfiguration.ephemeral
        proxy?.configure(configuration)
        XCTAssertEqual(configuration.proxyConfigurations.count, 1)
        XCTAssertEqual(socket.calls, ["open", "bind", "name"])
        XCTAssertTrue(socket.closed.isEmpty)
        proxy = nil
        XCTAssertEqual(socket.closed, [42])
    }

    func testRejectingProtocolsPreserveCanonicalRequestAndReportOnlySecureFailure() throws {
        var request = try URLRequest(url: XCTUnwrap(URL(string: "https://gateway.example.test/data?x=1")))
        request.httpMethod = "POST"
        request.httpBody = Data("payload".utf8)
        request.setValue("Bearer fixture-token", forHTTPHeaderField: "Authorization")
        XCTAssertTrue(GatewayRejectedURLProtocol.canInit(with: request))
        XCTAssertEqual(GatewayRejectedURLProtocol.canonicalRequest(for: request), request)
        let client = RejectedProtocolClient()
        let protocolInstance = GatewayRejectedURLProtocol(request: request, cachedResponse: nil, client: client)
        protocolInstance.stopLoading()
        XCTAssertTrue(client.errors.isEmpty)
        protocolInstance.startLoading()
        protocolInstance.stopLoading()
        XCTAssertEqual(client.errors.map { ($0 as? URLError)?.code }, [.secureConnectionFailed])
        XCTAssertEqual(client.otherCallbacks, 0)
        // URLProtocol may also be constructed without a client while cancellation retires its owner.
        GatewayRejectedURLProtocol(request: request, cachedResponse: nil, client: nil).startLoading()
    }

    func testHTTPSOnlyProtocolRejectsEveryPlaintextOrMissingSchemeAndPassesSecureSchemes() throws {
        for value in ["https://gateway.example.test", "wss://gateway.example.test", "HTTPS://gateway.example.test"] {
            XCTAssertFalse(try GatewayHTTPSOnlyURLProtocol.canInit(with: URLRequest(url: XCTUnwrap(URL(string: value)))))
        }
        for value in ["http://gateway.example.test", "ws://gateway.example.test", "file:///fixture", "/relative"] {
            XCTAssertTrue(try GatewayHTTPSOnlyURLProtocol.canInit(with: URLRequest(url: XCTUnwrap(URL(string: value)))))
        }
    }
}

private final class UnavailableSocketScript {
    let failure: Int?
    var assignedPort: UInt16 = 49152
    var calls: [String] = []
    var closed: [Int32] = []
    init(failure: Int? = nil) {
        self.failure = failure
    }

    var operations: GatewayUnavailableSocketOperations {
        GatewayUnavailableSocketOperations(
            open: { self.calls.append("open")
                return self.failure == 0 ? -1 : 42
            },
            bind: { descriptor, address, size in
                self.calls.append("bind")
                XCTAssertEqual(descriptor, 42)
                XCTAssertEqual(size, socklen_t(MemoryLayout<sockaddr_in>.size))
                address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
                    XCTAssertEqual($0.pointee.sin_family, sa_family_t(AF_INET))
                    XCTAssertEqual($0.pointee.sin_addr.s_addr, inet_addr("127.0.0.1"))
                    XCTAssertEqual($0.pointee.sin_port, 0)
                }
                return self.failure == 1 ? -1 : 0
            },
            name: { descriptor, address, size in
                self.calls.append("name")
                XCTAssertEqual(descriptor, 42)
                XCTAssertEqual(size.pointee, socklen_t(MemoryLayout<sockaddr_in>.size))
                address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_port = self.assignedPort.bigEndian }
                return self.failure == 2 ? -1 : 0
            },
            close: { self.calls.append("close")
                self.closed.append($0)
            }
        )
    }
}

private final class RejectedProtocolClient: NSObject, URLProtocolClient, @unchecked Sendable {
    var errors: [Error] = []
    var otherCallbacks = 0
    func urlProtocol(_ protocol: URLProtocol, didFailWithError error: Error) {
        errors.append(error)
    }

    func urlProtocol(_ protocol: URLProtocol, wasRedirectedTo request: URLRequest, redirectResponse: URLResponse) {
        otherCallbacks += 1
    }

    func urlProtocol(_ protocol: URLProtocol, cachedResponseIsValid cachedResponse: CachedURLResponse) {
        otherCallbacks += 1
    }

    func urlProtocol(_ protocol: URLProtocol, didReceive response: URLResponse, cacheStoragePolicy policy: URLCache.StoragePolicy) {
        otherCallbacks += 1
    }

    func urlProtocol(_ protocol: URLProtocol, didLoad data: Data) {
        otherCallbacks += 1
    }

    func urlProtocolDidFinishLoading(_ protocol: URLProtocol) {
        otherCallbacks += 1
    }

    func urlProtocol(_ protocol: URLProtocol, didReceive challenge: URLAuthenticationChallenge) {
        otherCallbacks += 1
    }

    func urlProtocol(_ protocol: URLProtocol, didCancel challenge: URLAuthenticationChallenge) {
        otherCallbacks += 1
    }
}
