// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network

public struct GatewayDirectCandidate: Codable, Equatable, Hashable, Sendable {
    public let address: String
    public let port: Int

    public init(address: String, port: Int) {
        self.address = address
        self.port = port
    }
}

public enum GatewayRoutingError: Error, Equatable {
    case invalidRoute
    case invalidCandidates
    case listenerUnavailable
}

/// TCP hints never change the canonical HTTPS identity or confer certificate trust.
public struct GatewayDirectRoute: Equatable, Sendable {
    public let origin: URL
    public let host: String
    public let port: UInt16
    public let candidates: [GatewayDirectCandidate]

    public init?(origin: URL, candidates: [GatewayDirectCandidate]) throws {
        try self.init(origin: origin, candidates: candidates, allowLoopbackForTesting: false)
    }

    init?(origin: URL, candidates: [GatewayDirectCandidate], allowLoopbackForTesting: Bool) throws {
        guard !candidates.isEmpty else { return nil }
        try self.init(validating: origin, candidates: candidates, allowLoopbackForTesting: allowLoopbackForTesting)
    }

    /// Retains a validated identity while authenticated discovery has no LAN hints yet.
    /// Later candidate updates can activate LAN without replacing an existing HTTP session.
    public static func maintained(origin: URL, candidates: [GatewayDirectCandidate]) throws -> GatewayDirectRoute {
        try GatewayDirectRoute(validating: origin, candidates: candidates, allowLoopbackForTesting: false)
    }

    private init(validating origin: URL, candidates: [GatewayDirectCandidate], allowLoopbackForTesting: Bool) throws {
        guard origin.scheme?.lowercased() == "https", origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil, ["", "/"].contains(origin.path),
              let rawHost = origin.host else { throw GatewayRoutingError.invalidRoute }
        let host = rawHost.lowercased()
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard host.utf8.count <= 253, labels.count > 1,
              labels.allSatisfy({ label in
                  let bytes = Array(label.utf8)
                  return !bytes.isEmpty && bytes.count <= 63 &&
                      bytes.allSatisfy { (97 ... 122).contains($0) || (48 ... 57).contains($0) || $0 == 45 } &&
                      bytes.first != 45 && bytes.last != 45
              }), IPv4Address(host) == nil, IPv6Address(host) == nil,
              let port = UInt16(exactly: origin.port ?? 443), port > 0
        else { throw GatewayRoutingError.invalidRoute }
        guard candidates.count <= 8, Set(candidates).count == candidates.count,
              candidates.allSatisfy({ candidate in
                  (1 ... 65535).contains(candidate.port) &&
                      Self.privateAddress(candidate.address, allowLoopbackForTesting: allowLoopbackForTesting)
              }) else { throw GatewayRoutingError.invalidCandidates }
        self.origin = origin
        self.host = host
        self.port = port
        self.candidates = candidates
    }

    static func privateAddress(_ address: String, allowLoopbackForTesting: Bool = false) -> Bool {
        guard !address.contains("%") else { return false }
        if let ipv6 = IPv6Address(address) {
            return ipv6.rawValue[0] & 0xFE == 0xFC
        }
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let bytes = parts.compactMap { UInt8($0) }
        guard bytes.count == 4, zip(parts, bytes).allSatisfy({ String($0.1) == $0.0 }) else { return false }
        return bytes[0] == 10 || (bytes[0] == 172 && (16 ... 31).contains(bytes[1])) ||
            (bytes[0] == 192 && bytes[1] == 168) || (allowLoopbackForTesting && bytes[0] == 127)
    }
}
