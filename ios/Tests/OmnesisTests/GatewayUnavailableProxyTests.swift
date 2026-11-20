// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class GatewayUnavailableProxyTests: XCTestCase {
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
            let socket = ScriptedSocketOperations(failure: stage)
            XCTAssertThrowsError(try GatewayUnavailableProxy(operations: socket.operations)) { error in
                XCTAssertEqual(error as? GatewayRoutingError, .listenerUnavailable)
            }
            XCTAssertEqual(
                socket.calls,
                Array(["open IPv4", "bind 42 127.0.0.1:0", "name 42"].prefix(stage + 1)) + (stage == 0 ? [] : ["close 42"])
            )
            XCTAssertEqual(socket.closed, stage == 0 ? [] : [42])
        }
    }

    func testSuccessfulSocketIsLoopbackBoundAndReleasedOnDeinit() throws {
        let socket = ScriptedSocketOperations()
        var proxy: GatewayUnavailableProxy? = try GatewayUnavailableProxy(operations: socket.operations)
        let configuration = URLSessionConfiguration.ephemeral
        proxy?.configure(configuration)
        XCTAssertEqual(configuration.proxyConfigurations.count, 1)
        XCTAssertEqual(socket.calls, ["open IPv4", "bind 42 127.0.0.1:0", "name 42"])
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
