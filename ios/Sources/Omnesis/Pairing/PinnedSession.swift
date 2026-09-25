// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation

/// `URLSession` that pins the gateway's TLS leaf certificate by SHA-256
/// fingerprint. Built once per `Pairing` so re-pair refreshes the pin.
///
/// The fingerprint is `<lowercase-hex-64-chars>` matching the gateway's
/// auto-generated cert (see `packages/gateway/src/tls.ts`). When the
/// `URLSessionDelegate` server-trust challenge fires, we extract the
/// leaf cert's DER-encoded bytes, hash them, and compare to the pinned
/// fingerprint — bypassing system trust entirely. This is the
/// pinning counter-measure — gateway uses a self-signed cert that no
/// public CA would trust, so we *can't* defer
/// to system validation, and we don't want to.
public final class PinnedSession: NSObject, URLSessionDelegate {
    /// Lowercased hex form of the expected SHA-256 leaf-cert digest.
    private let fingerprintHex: String

    /// Lazily-built `URLSession` configured with this object as its
    /// delegate. Lazy because `URLSession(configuration:delegate:…)`
    /// requires `self` to be fully initialised.
    public lazy var session: URLSession = .init(
        configuration: .ephemeral,
        delegate: self,
        delegateQueue: nil
    )

    public init(fingerprintHex: String) {
        self.fingerprintHex = fingerprintHex.lowercased()
        super.init()
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        if PinnedSession.verifyFingerprint(trust: trust, against: fingerprintHex) {
            // We've verified the leaf-cert SHA-256 ourselves; tell iOS to
            // skip its standard re-evaluation of the SecTrust (which would
            // still run hostname matching, chain-to-CA, and revocation
            // checks against the same trust object we're handing back).
            // Without this, self-signed certs whose SAN doesn't include
            // the URL host the iOS client connected to surface as
            // `NSURLErrorSecureConnectionFailed` — iOS aborts before the
            // pin actually takes effect. The gateway auto-cert lists a
            // small fixed set of SANs (localhost / `<host>.local` /
            // 127.0.0.1 / ::1); any user reaching the gateway over a
            // network identity outside that set (LAN, VPN overlay,
            // tunnel, …) would otherwise hit the bypass.
            if let exceptions = SecTrustCopyExceptions(trust) {
                SecTrustSetExceptions(trust, exceptions)
            }
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// Pure helper exposed so unit tests can drive the comparison
    /// without spinning up a real TLS server. Returns `true` iff the
    /// trust's leaf certificate's SHA-256 DER digest matches the
    /// supplied fingerprint (case-insensitive on the input).
    static func verifyFingerprint(trust: SecTrust, against expected: String) -> Bool {
        guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else {
            return false
        }
        let der = SecCertificateCopyData(leaf) as Data
        return der.sha256Hex == expected.lowercased()
    }
}

extension Data {
    /// Lowercase hex SHA-256 digest of the receiver. Centralised here
    /// so other call sites (e.g. tests, future portal-facing code)
    /// don't reinvent it.
    var sha256Hex: String {
        let digest = SHA256.hash(data: self)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
