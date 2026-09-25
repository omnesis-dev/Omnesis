// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The JSON the gateway encodes into the pairing QR code.
///
/// Four wire formats are supported:
///
/// **V4 (current)** — explicit TLS trust. Public HTTPS gateways use
/// `system`; private self-signed gateways use `pinned-leaf`.
///
/// **V3 (legacy)** — TLS-pinned star topology. Adds a SHA-256
/// fingerprint of the gateway's auto-generated leaf cert so the iOS
/// app can pin it via `URLSessionDelegate` instead of relying on
/// system trust. Gateway is HTTPS-by-default.
///
/// ```json
/// {
///   "v": 3,
///   "gatewayUrl": "https://mac.local:7600",
///   "pairingCode": "1A2B-3C4D-5E",
///   "fingerprint": "aabbccdd…<64-hex-chars>"
/// }
/// ```
///
/// **V2 (legacy)** — star-topology rearchitecture without explicit TLS
/// pinning. Kept parseable for HTTPS QR screenshots predating V3.
///
/// ```json
/// { "v": 2, "gatewayUrl": "https://mac.local:7600", "pairingCode": "1A2B-3C4D-5E" }
/// ```
///
/// **V1 (legacy)** — pre-rearchitecture. The QR carried a pre-issued
/// token and accountId directly. Kept for backward compatibility with
/// any old QR files in the wild.
///
/// ```json
/// { "v": 1, "url": "...", "token": "...", "accountId": "...", "name": "..." }
/// ```
///
/// Must stay lock-step with the generator side — bump version numbers
/// on incompatible changes and reject unknown versions loudly.
public enum PairingPayload: Equatable, Sendable {
    case v4(V4)
    /// V3: exchange-code handshake with TLS fingerprint pinning.
    case v3(V3)
    /// V2: exchange-code handshake (legacy, no pinning).
    case v2(V2)
    /// V1: pre-issued token (legacy).
    case v1(V1)

    public struct V4: Codable, Equatable, Sendable {
        public enum TLS: Codable, Equatable, Sendable {
            case system
            case pinnedLeaf(fingerprint: String)

            private enum CodingKeys: String, CodingKey { case mode, fingerprint }
            private enum Mode: String, Codable {
                case system
                case pinnedLeaf = "pinned-leaf"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                switch try container.decode(Mode.self, forKey: .mode) {
                case .system:
                    self = .system
                case .pinnedLeaf:
                    self = try .pinnedLeaf(
                        fingerprint: container.decode(String.self, forKey: .fingerprint)
                    )
                }
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .system:
                    try container.encode(Mode.system, forKey: .mode)
                case .pinnedLeaf(let fingerprint):
                    try container.encode(Mode.pinnedLeaf, forKey: .mode)
                    try container.encode(fingerprint, forKey: .fingerprint)
                }
            }
        }

        public let v: Int
        public let gatewayUrl: String
        public let pairingCode: String
        public let tls: TLS

        public init(gatewayUrl: String, pairingCode: String, tls: TLS) {
            self.v = 4
            self.gatewayUrl = gatewayUrl
            self.pairingCode = pairingCode
            self.tls = tls
        }
    }

    /// V3 payload — adds a SHA-256 fingerprint of the gateway's leaf
    /// cert (lowercase hex, 64 chars) so the iOS app can pin TLS via
    /// `PinnedSession` regardless of system trust.
    public struct V3: Codable, Equatable, Sendable {
        public let v: Int
        public let gatewayUrl: String
        public let pairingCode: String
        public let fingerprint: String

        public init(gatewayUrl: String, pairingCode: String, fingerprint: String) {
            self.v = 3
            self.gatewayUrl = gatewayUrl
            self.pairingCode = pairingCode
            self.fingerprint = fingerprint
        }
    }

    /// V2 payload — the QR carries only URL + pairing code.
    public struct V2: Codable, Equatable, Sendable {
        public let v: Int
        public let gatewayUrl: String
        public let pairingCode: String

        public init(gatewayUrl: String, pairingCode: String) {
            self.v = 2
            self.gatewayUrl = gatewayUrl
            self.pairingCode = pairingCode
        }
    }

    /// Legacy V1 payload. Retained purely for back-compat.
    public struct V1: Codable, Equatable, Sendable {
        public let v: Int
        public let url: String
        public let token: String
        public let accountId: String
        public let name: String

        public init(url: String, token: String, accountId: String, name: String) {
            self.v = 1
            self.url = url
            self.token = token
            self.accountId = accountId
            self.name = name
        }
    }

    /// The version of the highest-supported payload we emit. Readers
    /// should accept this OR any lower supported version.
    public static let currentVersion = 4
}

/// Error kinds surfaced during pairing-QR parsing.
public enum PairingPayloadError: Error, Equatable {
    /// Scanned data wasn't valid JSON.
    case invalidJSON
    /// Payload parsed but doesn't match the expected shape.
    case invalidShape(String)
    /// Version field doesn't match what this build supports.
    case unsupportedVersion(Int)
    /// URL field isn't a parseable URL.
    case invalidURL
    /// One of the required string fields is empty.
    case missingField(String)
    /// `gatewayUrl` (or V1 `url`) was not HTTPS. Omnesis never sends
    /// credentials or personal data over plaintext HTTP.
    case invalidScheme(String)
    /// V3 fingerprint failed the `^[0-9a-f]{64}$` shape check.
    case invalidFingerprint
}

extension PairingPayloadError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidJSON:
            "The pairing data is not valid JSON."
        case .invalidShape(let detail):
            "The pairing data is incomplete or invalid: \(detail)"
        case .unsupportedVersion(let version):
            "This pairing code uses unsupported version \(version)."
        case .invalidURL:
            "Enter a valid HTTPS gateway URL."
        case .missingField(let field):
            "The pairing data is missing \(field)."
        case .invalidScheme:
            "Omnesis requires an HTTPS gateway."
        case .invalidFingerprint:
            "The gateway certificate fingerprint is invalid."
        }
    }
}

extension PairingPayload {
    /// Decode a pairing payload from raw QR-decoded text. Trims whitespace,
    /// validates invariants, and returns a tagged case.
    public static func decode(from raw: String) throws -> PairingPayload {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8) else {
            throw PairingPayloadError.invalidJSON
        }

        // Peek the version first so we know which schema to match.
        struct VersionPeek: Decodable { let v: Int? }
        let peek: VersionPeek
        do {
            peek = try JSONDecoder().decode(VersionPeek.self, from: data)
        } catch {
            throw PairingPayloadError.invalidJSON
        }

        switch peek.v {
        case 4:
            let v4: V4
            do {
                v4 = try JSONDecoder().decode(V4.self, from: data)
            } catch let error as DecodingError {
                throw PairingPayloadError.invalidShape("\(error)")
            } catch {
                throw PairingPayloadError.invalidJSON
            }
            if v4.gatewayUrl.isEmpty { throw PairingPayloadError.missingField("gatewayUrl") }
            if v4.pairingCode.isEmpty { throw PairingPayloadError.missingField("pairingCode") }
            try validateGatewayOrigin(v4.gatewayUrl)
            switch v4.tls {
            case .system:
                break
            case .pinnedLeaf(let fingerprint):
                if fingerprint.isEmpty {
                    throw PairingPayloadError.missingField("tls.fingerprint")
                }
                try validateFingerprint(fingerprint)
            }
            return .v4(v4)

        case 3:
            let v3: V3
            do {
                v3 = try JSONDecoder().decode(V3.self, from: data)
            } catch let e as DecodingError {
                throw PairingPayloadError.invalidShape("\(e)")
            } catch {
                throw PairingPayloadError.invalidJSON
            }
            if v3.gatewayUrl.isEmpty { throw PairingPayloadError.missingField("gatewayUrl") }
            if v3.pairingCode.isEmpty { throw PairingPayloadError.missingField("pairingCode") }
            if v3.fingerprint.isEmpty { throw PairingPayloadError.missingField("fingerprint") }
            try validateGatewayOrigin(v3.gatewayUrl)
            try validateFingerprint(v3.fingerprint)
            return .v3(v3)

        case 2:
            let v2: V2
            do {
                v2 = try JSONDecoder().decode(V2.self, from: data)
            } catch let e as DecodingError {
                throw PairingPayloadError.invalidShape("\(e)")
            } catch {
                throw PairingPayloadError.invalidJSON
            }
            if v2.gatewayUrl.isEmpty { throw PairingPayloadError.missingField("gatewayUrl") }
            if v2.pairingCode.isEmpty { throw PairingPayloadError.missingField("pairingCode") }
            try validateGatewayOrigin(v2.gatewayUrl)
            return .v2(v2)

        case 1:
            let v1: V1
            do {
                v1 = try JSONDecoder().decode(V1.self, from: data)
            } catch let e as DecodingError {
                throw PairingPayloadError.invalidShape("\(e)")
            } catch {
                throw PairingPayloadError.invalidJSON
            }
            if v1.url.isEmpty { throw PairingPayloadError.missingField("url") }
            if v1.token.isEmpty { throw PairingPayloadError.missingField("token") }
            if v1.accountId.isEmpty { throw PairingPayloadError.missingField("accountId") }
            try validateGatewayOrigin(v1.url)
            return .v1(v1)

        case let n?:
            throw PairingPayloadError.unsupportedVersion(n)

        case nil:
            throw PairingPayloadError.invalidShape("missing version field 'v'")
        }
    }

    /// Require HTTPS for every payload generation. Legacy wire shapes stay
    /// readable, but their historical plaintext transport does not: pairing
    /// credentials and indexed personal data must always be encrypted in
    /// transit.
    private static func validateGatewayOrigin(_ urlString: String) throws {
        guard let components = URLComponents(string: urlString),
              let url = components.url else {
            throw PairingPayloadError.invalidURL
        }
        guard let scheme = url.scheme?.lowercased() else {
            throw PairingPayloadError.invalidScheme("(missing)")
        }
        guard scheme == "https" else {
            throw PairingPayloadError.invalidScheme(scheme)
        }
        guard let host = components.host, !host.isEmpty,
              url.host != nil,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            throw PairingPayloadError.invalidURL
        }
    }

    /// V3 fingerprint must be exactly 64 lowercase hex characters
    /// (a SHA-256 digest, no separators). Anything else (uppercase,
    /// colons, wrong length) is rejected — we'd rather fail fast at
    /// parse time than mis-pin at runtime.
    private static func validateFingerprint(_ fingerprint: String) throws {
        guard fingerprint.count == 64 else {
            throw PairingPayloadError.invalidFingerprint
        }
        for ch in fingerprint {
            switch ch {
            case "0" ... "9", "a" ... "f":
                continue
            default:
                throw PairingPayloadError.invalidFingerprint
            }
        }
    }
}
