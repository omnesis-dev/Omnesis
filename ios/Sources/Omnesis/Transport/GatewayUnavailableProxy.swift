// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation
import Network

struct GatewayUnavailableSocketOperations {
    /// Opens a TCP socket of the address family; an IPv6 socket accepts IPv6 only.
    let open: (Int32) -> Int32
    let bind: (Int32, UnsafePointer<sockaddr>, socklen_t) -> Int32
    let name: (Int32, UnsafeMutablePointer<sockaddr>, UnsafeMutablePointer<socklen_t>) -> Int32
    let close: (Int32) -> Void
    /// The `errno` of the call that just failed.
    let lastError: () -> Int32

    static let live = GatewayUnavailableSocketOperations(
        open: { family in
            let descriptor = Darwin.socket(family, SOCK_STREAM, 0)
            guard family == AF_INET6, descriptor >= 0 else { return descriptor }
            var only: Int32 = 1
            guard setsockopt(descriptor, IPPROTO_IPV6, IPV6_V6ONLY, &only, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
                _ = Darwin.close(descriptor)
                return -1
            }
            return descriptor
        },
        bind: { Darwin.bind($0, $1, $2) },
        name: { Darwin.getsockname($0, $1, $2) },
        close: { _ = Darwin.close($0) },
        lastError: { errno }
    )
}

/// Allocates endpoints without advertising or accepting connections.
enum GatewayLoopbackSocket {
    /// How many port numbers `releaseEphemeralPort` tries before it gives up.
    static let portCandidates = 16

    /// A port number no socket holds on any local address, in either address family, released
    /// for a loopback listener to bind.
    ///
    /// A loopback `NWListener` fails with `EADDRINUSE` while any socket holds its port number,
    /// whatever that socket's address or family. When the kernel picks an ephemeral port it skips
    /// only the ports of sockets that would conflict with the one being bound, so a port picked by
    /// binding 127.0.0.1 can be the local end of another app's connection on a network address,
    /// or be bound on `::1`. Picking on the IPv4 wildcard address skips every IPv4 holder, and an
    /// IPv6 wildcard bind of the same number fails while any IPv6 socket holds it. A refused
    /// number stays bound until the search ends, so the next pick is a different one.
    static func releaseEphemeralPort(operations: GatewayUnavailableSocketOperations = .live) throws -> UInt16 {
        var picked: [Int32] = []
        defer {
            for descriptor in picked {
                operations.close(descriptor)
            }
        }
        for _ in 0 ..< portCandidates {
            let candidate = try bind(address: INADDR_ANY, operations: operations)
            picked.append(candidate.descriptor)
            if isFreeForIPv6(candidate.port, operations: operations) { return candidate.port }
        }
        throw GatewayRoutingError.listenerUnavailable
    }

    /// Whether no IPv6 socket holds `port`. A system that cannot open or bind an IPv6 socket for
    /// another reason has no IPv6 holder to find.
    private static func isFreeForIPv6(_ port: UInt16, operations: GatewayUnavailableSocketOperations) -> Bool {
        let descriptor = operations.open(AF_INET6)
        guard descriptor >= 0 else { return true }
        defer { operations.close(descriptor) }
        var address = sockaddr_in6()
        address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
        address.sin6_family = sa_family_t(AF_INET6)
        address.sin6_addr = in6addr_any
        address.sin6_port = port.bigEndian
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                operations.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in6>.size))
            }
        }
        return bound == 0 || operations.lastError() != EADDRINUSE
    }

    /// Binds a new IPv4 socket to an ephemeral port on `address`, without listening.
    static func bind(
        address host: in_addr_t = inet_addr("127.0.0.1"), operations: GatewayUnavailableSocketOperations
    ) throws
        -> (descriptor: Int32, port: UInt16) {
        let descriptor = operations.open(AF_INET)
        guard descriptor >= 0 else { throw GatewayRoutingError.listenerUnavailable }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: host)
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
