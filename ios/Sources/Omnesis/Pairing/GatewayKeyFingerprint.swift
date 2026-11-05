// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import SwiftASN1

/// Hashes the complete DER SubjectPublicKeyInfo, including its algorithm identifier.
/// The platform trust evaluator still authenticates the certificate, dates and hostname.
enum GatewayKeyFingerprint {
    enum Failure: Error { case invalidCertificate }
    static func spki(_ certificate: Data) throws -> String {
        let root = try DER.parse(Array(certificate))
        guard root.identifier == .sequence, case .constructed(let certificateNodes) = root.content else {
            throw Failure.invalidCertificate
        }
        let outer = Array(certificateNodes)
        guard outer.count == 3, outer[0].identifier == .sequence,
              case .constructed(let tbsNodes) = outer[0].content else { throw Failure.invalidCertificate }
        let fields = Array(tbsNodes)
        let versioned = fields.first.map { $0.identifier.tagClass == .contextSpecific && $0.identifier.tagNumber == 0 } ?? false
        let keyIndex = versioned ? 6 : 5
        guard fields.count > keyIndex, fields[keyIndex].identifier == .sequence,
              case .constructed(let keyNodes) = fields[keyIndex].content else { throw Failure.invalidCertificate }
        let key = Array(keyNodes)
        guard key.count == 2, key[0].identifier == .sequence, key[1].identifier == .bitString else {
            throw Failure.invalidCertificate
        }
        var serializer = DER.Serializer()
        serializer.serialize(fields[keyIndex])
        return SHA256.hash(data: Data(serializer.serializedBytes)).map { String(format: "%02x", $0) }.joined()
    }
}
