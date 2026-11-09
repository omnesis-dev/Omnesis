// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import SwiftASN1

/// Hashes the complete DER SubjectPublicKeyInfo, including its algorithm identifier.
/// The platform trust evaluator still authenticates the certificate, dates and hostname;
/// `PinnedSession` alone decides when a lapsed date is acceptable for a pinned key.
enum GatewayKeyFingerprint {
    enum Failure: Error { case invalidCertificate }
    static func spki(_ certificate: Data) throws -> String {
        let (fields, versioned) = try tbsFields(certificate)
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

    /// The moment the certificate stops being valid (its `notAfter`).
    static func expiry(_ certificate: Data) throws -> Date {
        let (fields, versioned) = try tbsFields(certificate)
        let validityIndex = versioned ? 4 : 3
        guard fields.count > validityIndex, fields[validityIndex].identifier == .sequence,
              case .constructed(let validityNodes) = fields[validityIndex].content else { throw Failure.invalidCertificate }
        let validity = Array(validityNodes)
        guard validity.count == 2 else { throw Failure.invalidCertificate }
        var parts = DateComponents()
        if validity[1].identifier == .utcTime {
            let time = try UTCTime(derEncoded: validity[1])
            (parts.year, parts.month, parts.day) = (time.year, time.month, time.day)
            (parts.hour, parts.minute, parts.second) = (time.hours, time.minutes, time.seconds)
        } else {
            let time = try GeneralizedTime(derEncoded: validity[1])
            (parts.year, parts.month, parts.day) = (time.year, time.month, time.day)
            (parts.hour, parts.minute, parts.second) = (time.hours, time.minutes, time.seconds)
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? calendar.timeZone
        guard let date = calendar.date(from: parts) else { throw Failure.invalidCertificate }
        return date
    }

    /// The fields of the certificate's TBSCertificate, and whether they start with an explicit version.
    private static func tbsFields(_ certificate: Data) throws -> (fields: [ASN1Node], versioned: Bool) {
        let root = try DER.parse(Array(certificate))
        guard root.identifier == .sequence, case .constructed(let certificateNodes) = root.content else {
            throw Failure.invalidCertificate
        }
        let outer = Array(certificateNodes)
        guard outer.count == 3, outer[0].identifier == .sequence,
              case .constructed(let tbsNodes) = outer[0].content else { throw Failure.invalidCertificate }
        let fields = Array(tbsNodes)
        let versioned = fields.first.map { $0.identifier.tagClass == .contextSpecific && $0.identifier.tagNumber == 0 } ?? false
        return (fields, versioned)
    }
}
