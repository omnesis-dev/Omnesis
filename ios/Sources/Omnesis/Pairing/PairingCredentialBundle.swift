// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The complete device pairing stored as one Keychain value.
///
/// One encoded item is the transaction boundary for credentials and TLS trust:
/// replacement can expose the complete old bundle, no bundle, or the complete
/// new bundle, but never a token combined with another pairing's trust mode.
public struct PairingCredentialBundle: Codable, Equatable, Sendable {
    public static let key = "gateway.credential.v1"

    public let url: String
    public let token: String
    /// Gateway token-row id. A fresh value is issued for every pairing,
    /// including a repair that adopts the same durable device row.
    public let pairingGeneration: String?
    public let accountId: String
    public let deviceId: String
    public let name: String
    public let scopes: [String]
    public let tlsMode: String
    public let fingerprint: String?

    public init(
        url: String,
        token: String,
        pairingGeneration: String? = nil,
        accountId: String,
        deviceId: String,
        name: String,
        scopes: [String],
        tlsMode: String,
        fingerprint: String?
    ) {
        self.url = url
        self.token = token
        self.pairingGeneration = pairingGeneration
        self.accountId = accountId
        self.deviceId = deviceId
        self.name = name
        self.scopes = scopes
        self.tlsMode = tlsMode
        self.fingerprint = fingerprint
    }

    public func encoded() throws -> String {
        let data = try JSONEncoder().encode(self)
        guard let raw = String(data: data, encoding: .utf8) else {
            throw EncodingError.invalidValue(
                self,
                .init(codingPath: [], debugDescription: "Pairing credential is not UTF-8")
            )
        }
        return raw
    }

    public static func decode(_ raw: String) throws -> Self {
        guard let data = raw.data(using: .utf8) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: [], debugDescription: "Pairing credential is not UTF-8")
            )
        }
        return try JSONDecoder().decode(Self.self, from: data)
    }
}
