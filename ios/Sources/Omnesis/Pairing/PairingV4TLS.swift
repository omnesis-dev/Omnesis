// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

private enum PairingV4TLSCodingKeys: String, CodingKey { case mode, fingerprint, spkiFingerprint }
private enum PairingV4TLSMode: String, Codable {
    case system
    case pinnedLeaf = "pinned-leaf"
    case pinnedLeafStrict = "pinned-leaf-strict"
    case pinnedKeyStrict = "pinned-key-strict"
}

public enum PairingV4TLS: Codable, Equatable, Sendable {
    case system
    case pinnedLeaf(fingerprint: String)
    case pinnedLeafStrict(fingerprint: String)
    case pinnedKeyStrict(spkiFingerprint: String)

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: PairingV4TLSCodingKeys.self)
        switch try container.decode(PairingV4TLSMode.self, forKey: .mode) {
        case .system:
            self = .system
        case .pinnedLeaf:
            self = try .pinnedLeaf(
                fingerprint: container.decode(String.self, forKey: .fingerprint)
            )
        case .pinnedKeyStrict:
            self = try .pinnedKeyStrict(spkiFingerprint: container.decode(String.self, forKey: .spkiFingerprint))
        case .pinnedLeafStrict:
            self = try .pinnedLeafStrict(
                fingerprint: container.decode(String.self, forKey: .fingerprint)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: PairingV4TLSCodingKeys.self)
        switch self {
        case .system:
            try container.encode(PairingV4TLSMode.system, forKey: .mode)
        case .pinnedLeaf(let fingerprint):
            try container.encode(PairingV4TLSMode.pinnedLeaf, forKey: .mode)
            try container.encode(fingerprint, forKey: .fingerprint)
        case .pinnedKeyStrict(let spkiFingerprint):
            try container.encode(PairingV4TLSMode.pinnedKeyStrict, forKey: .mode)
            try container.encode(spkiFingerprint, forKey: .spkiFingerprint)
        case .pinnedLeafStrict(let fingerprint):
            try container.encode(PairingV4TLSMode.pinnedLeafStrict, forKey: .mode)
            try container.encode(fingerprint, forKey: .fingerprint)
        }
    }
}
