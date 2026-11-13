// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation
import Network

struct GatewayUnavailableSocketOperations {
    let open: () -> Int32
    let bind: (Int32, UnsafePointer<sockaddr>, socklen_t) -> Int32
    let name: (Int32, UnsafeMutablePointer<sockaddr>, UnsafeMutablePointer<socklen_t>) -> Int32
    let close: (Int32) -> Void

    static let live = GatewayUnavailableSocketOperations(
        open: { Darwin.socket(AF_INET, SOCK_STREAM, 0) },
        bind: { Darwin.bind($0, $1, $2) },
        name: { Darwin.getsockname($0, $1, $2) },
        close: { _ = Darwin.close($0) }
    )
}

/// Allocates a loopback-only endpoint without advertising or accepting connections.
enum GatewayLoopbackSocket {
    static func releaseEphemeralPort(operations: GatewayUnavailableSocketOperations = .live) throws -> UInt16 {
        let socket = try bind(operations: operations)
        operations.close(socket.descriptor)
        return socket.port
    }

    static func bind(operations: GatewayUnavailableSocketOperations) throws -> (descriptor: Int32, port: UInt16) {
        let descriptor = operations.open()
        guard descriptor >= 0 else { throw GatewayRoutingError.listenerUnavailable }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                operations.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { operations.close(descriptor)
            throw GatewayRoutingError.listenerUnavailable
        }
        var size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let result = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { operations.name(descriptor, $0, &size) }
        }
        guard result == 0 else { operations.close(descriptor)
            throw GatewayRoutingError.listenerUnavailable
        }
        let port = UInt16(bigEndian: address.sin_port)
        guard port > 0 else { operations.close(descriptor)
            throw GatewayRoutingError.listenerUnavailable
        }
        return (descriptor, port)
    }
}

/// One process-owned bound socket never listens. Its port cannot be claimed by
/// another service, and an unavailable lease cannot bypass it through CFNetwork
/// proxy failover (including WebSocket tasks that ignore URLProtocol).
final class GatewayUnavailableProxy: @unchecked Sendable {
    static let shared = try? GatewayUnavailableProxy()
    private let descriptor: Int32
    private let port: UInt16
    private let closeDescriptor: (Int32) -> Void

    init(operations: GatewayUnavailableSocketOperations = .live) throws {
        let socket = try GatewayLoopbackSocket.bind(operations: operations)
        descriptor = socket.descriptor
        port = socket.port
        closeDescriptor = operations.close
    }

    func configure(_ configuration: URLSessionConfiguration) {
        var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!))
        proxy.allowFailover = false
        configuration.proxyConfigurations = [proxy]
    }

    deinit { closeDescriptor(descriptor) }
}

/// Covers HTTP/HTTPS data tasks even if no socket descriptor can be allocated.
/// Supported component WebSocket URLs are always WSS and also reject TLS trust.
class GatewayRejectedURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.secureConnectionFailed))
    }

    override func stopLoading() {}
}

final class GatewayHTTPSOnlyURLProtocol: GatewayRejectedURLProtocol, @unchecked Sendable {
    override static func canInit(with request: URLRequest) -> Bool {
        !["https", "wss"].contains(request.url?.scheme?.lowercased() ?? "")
    }
}
