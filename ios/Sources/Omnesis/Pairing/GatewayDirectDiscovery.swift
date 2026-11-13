// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public protocol GatewayDirectDiscovering: Sendable {
    func fetch(origin: URL, token: String, spkiFingerprint: String) async throws -> [GatewayDirectCandidate]
}

/// Only a newly issued device bearer over the already authenticated canonical key can obtain LAN facts.
public struct GatewayDirectDiscovery: GatewayDirectDiscovering {
    private struct Reply: Decodable { let version: Int
        let candidates: [GatewayDirectCandidate]
    }

    private let transports: any CloudPairingKeyTransportFactory
    public init(transports: any CloudPairingKeyTransportFactory = CloudPairingHTTPFactory()) {
        self.transports = transports
    }

    public func fetch(origin: URL, token: String, spkiFingerprint: String) async throws -> [GatewayDirectCandidate] {
        guard origin.scheme?.lowercased() == "https", let host = origin.host, !host.isEmpty,
              origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
              ["", "/"].contains(origin.path), origin.port.map({ (1 ... 65535).contains($0) }) ?? true,
              !token.isEmpty, token.utf8.count <= 8192,
              spkiFingerprint.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw CloudPairingError.configuration }
        let transport = transports.pinnedKey(spkiFingerprint, host: host)
        defer { transport.close() }
        let data = try await transport.requestData(
            url: origin.appendingPathComponent("devices/direct-candidates"),
            method: "GET",
            body: nil,
            bearer: token,
            form: false
        )
        guard data.count <= 65536 else { throw CloudPairingError.response }
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        guard reply.version == 1 else { throw CloudPairingError.response }
        _ = try GatewayDirectRoute(origin: origin, candidates: reply.candidates)
        return reply.candidates
    }

    public static func isTemporary(_ error: Error) -> Bool {
        if let cloud = error as? CloudPairingError, case .httpStatus(let code) = cloud {
            return code == 404 || code == 429 || (500 ... 599).contains(code)
        }
        guard let error = error as? URLError else { return false }
        switch error.code {
        case .timedOut, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .networkConnectionLost, .notConnectedToInternet:
            return true
        default: return false
        }
    }
}
