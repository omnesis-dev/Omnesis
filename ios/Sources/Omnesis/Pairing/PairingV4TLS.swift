// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum PairingV4TLS: Codable, Equatable, Sendable {
    case system
    case pinnedLeaf(fingerprint: String)
    case pinnedLeafStrict(fingerprint: String)
    case pinnedKeyStrict(spkiFingerprint: String)

    // Nested and named as before the strict modes existed: a decoding error prints these
    // type names, and the scan error shows that text.
    private enum CodingKeys: String, CodingKey { case mode, fingerprint, spkiFingerprint }
    private enum Mode: String, Codable {
        case system
        case pinnedLeaf = "pinned-leaf"
        case pinnedLeafStrict = "pinned-leaf-strict"
        case pinnedKeyStrict = "pinned-key-strict"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let mode = try container.decode(Mode.self, forKey: .mode)
        switch mode {
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
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .system:
            try container.encode(Mode.system, forKey: .mode)
        case .pinnedLeaf(let fingerprint):
            try container.encode(Mode.pinnedLeaf, forKey: .mode)
            try container.encode(fingerprint, forKey: .fingerprint)
        case .pinnedKeyStrict(let spkiFingerprint):
            try container.encode(Mode.pinnedKeyStrict, forKey: .mode)
            try container.encode(spkiFingerprint, forKey: .spkiFingerprint)
        case .pinnedLeafStrict(let fingerprint):
            try container.encode(Mode.pinnedLeafStrict, forKey: .mode)
            try container.encode(fingerprint, forKey: .fingerprint)
        }
    }
}
