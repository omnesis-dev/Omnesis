// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum DesktopAccountIntent: String, CaseIterable, Codable, Sendable {
    case existing, create

    public func parameters(invite: String, termsAccepted: Bool) -> [String: BridgeValue] {
        var result: [String: BridgeValue] = ["intent": .string(rawValue), "termsAccepted": .bool(termsAccepted)]
        if self == .create {
            let code = invite.trimmingCharacters(in: .whitespacesAndNewlines)
            if !code.isEmpty { result["invite"] = .string(code) }
        }
        return result
    }
}

public enum DesktopRelayAddress {
    /// Only the gateway's ready, authorized relay resource is useful to a new
    /// phone or a cloud assistant. A local listener is never its substitute.
    public static func mcp(
        enabled: Bool,
        ready: Bool,
        advertised: String?,
        authorizedResources: [String]
    ) throws
        -> URL {
        guard enabled, ready else { throw Failure.reconnecting }
        guard let advertised, let url = cleanHTTPS(advertised), url.path == "/mcp",
              authorizedResources.contains(where: { cleanHTTPS($0)?.absoluteString == url.absoluteString }) else {
            throw Failure.notAvailable
        }
        return url
    }

    public static func gatewayOrigin(mcp: URL) throws -> URL {
        guard var parts = URLComponents(url: mcp, resolvingAgainstBaseURL: false),
              cleanHTTPS(mcp.absoluteString) != nil, parts.path == "/mcp" else { throw Failure.notAvailable }
        parts.path = ""
        guard let origin = parts.url else { throw Failure.notAvailable }
        return origin
    }

    public static func matchesPhoneAddress(_ candidate: String, gatewayOrigin: URL) -> Bool {
        guard let url = cleanHTTPS(candidate), url.path.isEmpty || url.path == "/",
              let origin = cleanHTTPS(gatewayOrigin.absoluteString) else { return false }
        return url.scheme == origin.scheme && url.host?.lowercased() == origin.host?.lowercased()
            && (url.port ?? 443) == (origin.port ?? 443)
    }

    private static func cleanHTTPS(_ text: String) -> URL? {
        guard let url = URL(string: text), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
        return url
    }

    public enum Failure: LocalizedError {
        case reconnecting, notAvailable
        public var errorDescription: String? {
            switch self {
            case .reconnecting: "Your library is reconnecting to your Omnesis account. Try again when it is connected."
            case .notAvailable: "Your secure Omnesis address is not ready yet. Check your account connection and try again."
            }
        }
    }
}
