// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Security

/// First contact with a proposed gateway: a certificate the relay proposes should also be
/// publicly trusted and logged. A failure never stops pairing; the device asks for the
/// human comparison instead.
enum GatewayPublicCertificateCheck {
    /// DER of the embedded SCT list extension's OID, 1.3.6.1.4.1.11129.2.4.2.
    private static let sctExtensionOID = Data([0x06, 0x0A, 0x2B, 0x06, 0x01, 0x04, 0x01, 0xD6, 0x79, 0x02, 0x04, 0x02])

    static func passes(
        trust: SecTrust,
        host: String,
        systemTrust: PinnedSession.SystemTrustEvaluator = PinnedSession.systemRoots
    )
        -> Bool {
        guard systemTrust(trust, host), let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else { return false }
        return containsEmbeddedSCT(SecCertificateCopyData(leaf) as Data)
    }

    /// In an X.509 extension the OID is followed by the optional `critical` BOOLEAN or the value's OCTET STRING.
    static func containsEmbeddedSCT(_ certificate: Data) -> Bool {
        guard let match = certificate.range(of: sctExtensionOID), match.upperBound < certificate.endIndex else { return false }
        return [0x01, 0x04].contains(certificate[match.upperBound])
    }
}

/// A gateway transport that can say whether the certificate it was served passes
/// `GatewayPublicCertificateCheck`. Nothing observed reads as not passing.
public protocol CloudPairingPublicCertificateReporting: Sendable {
    func publicCertificateVerified(host: String) -> Bool
}
