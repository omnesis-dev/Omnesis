// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation

/// `URLSession` that pins the gateway's TLS leaf certificate by SHA-256
/// fingerprint. Built once per `Pairing` so re-pair refreshes the pin.
///
/// The fingerprint is `<lowercase-hex-64-chars>` matching the gateway's
/// certificate (see `packages/gateway/src/tls.ts`). When the
/// `URLSessionDelegate` server-trust challenge fires, the leaf's DER bytes
/// are hashed and compared to the pinned fingerprint. A match is accepted
/// without system evaluation, because a self-signed gateway certificate
/// chains to no public root.
///
/// A gateway whose certificate is publicly trusted renews it, and the renewed
/// leaf no longer matches the pin. When the paired host is a DNS name
/// (``GatewayTrustPolicy``) and the challenge is for that host, the served
/// chain is therefore also evaluated under the system roots for that exact
/// name. A chain that verifies is accepted even after the leaf changed, and
/// `onSystemTrustVerified` tells the app it can persist system trust in place
/// of the pin. The callback names the host and pin it verified, so the app can
/// refuse an upgrade for a pairing that has since changed, and fires at most
/// once per instance.
public final class PinnedSession: NSObject, URLSessionDelegate {
    /// What a server-trust challenge resolves to.
    public enum Verdict: Equatable, Sendable {
        /// The leaf matches the pin. `systemTrusted` is true when the
        /// challenge is for the paired host and the chain also verifies under
        /// the system roots for it.
        case pinned(systemTrusted: Bool)
        /// The leaf does not match the pin, but the challenge is for the
        /// paired host and the chain verifies under the system roots for it.
        case systemOnly
        case rejected
    }

    /// Decides whether a served chain verifies under the system roots for a
    /// host. Injected so tests can anchor a private root and fix the clock.
    public typealias SystemTrustEvaluator = @Sendable (SecTrust, String) -> Bool

    /// Told the paired host and the pin (lowercase hex) of a session whose
    /// served chain verified under the system roots for that host.
    public typealias SystemTrustVerified = @Sendable (_ host: String, _ fingerprintHex: String) -> Void

    /// The production evaluator: the system root store at the current time.
    public static let systemRoots: SystemTrustEvaluator = { trust, host in
        evaluateSystemTrust(trust, host: host)
    }

    /// Lowercased hex form of the expected SHA-256 leaf-cert digest.
    private let fingerprintHex: String
    /// The paired gateway host; nil keeps the session strictly pinned.
    private let host: String?
    private let onSystemTrustVerified: SystemTrustVerified?
    private let systemTrust: SystemTrustEvaluator
    private let notifyLock = NSLock()
    private var notified = false

    /// Lazily-built `URLSession` configured with this object as its
    /// delegate. Lazy because `URLSession(configuration:delegate:…)`
    /// requires `self` to be fully initialised.
    public lazy var session: URLSession = .init(
        configuration: .ephemeral,
        delegate: self,
        delegateQueue: nil
    )

    public init(
        fingerprintHex: String,
        host: String? = nil,
        onSystemTrustVerified: SystemTrustVerified? = nil,
        systemTrust: @escaping SystemTrustEvaluator = PinnedSession.systemRoots
    ) {
        self.fingerprintHex = fingerprintHex.lowercased()
        self.host = host
        self.onSystemTrustVerified = onSystemTrustVerified
        self.systemTrust = systemTrust
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
        switch resolve(trust, challengeHost: challenge.protectionSpace.host) {
        case .pinned:
            // The leaf-cert SHA-256 is verified; tell iOS to skip its standard
            // re-evaluation of the SecTrust (which would still run hostname
            // matching, chain-to-CA, and revocation checks against the same
            // trust object handed back). Without this, self-signed certs whose
            // SAN doesn't include the URL host the iOS client connected to
            // surface as `NSURLErrorSecureConnectionFailed`: the gateway
            // auto-cert lists a small fixed set of SANs (localhost /
            // `<host>.local` / 127.0.0.1 / ::1), and a user reaching it over
            // another network identity (LAN, VPN overlay, tunnel, …) would
            // otherwise be refused.
            if let exceptions = SecTrustCopyExceptions(trust) {
                SecTrustSetExceptions(trust, exceptions)
            }
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .systemOnly:
            // No exceptions: the platform's own evaluation of this trust
            // must also pass for the connection to proceed.
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .rejected:
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// Computes the verdict for one challenge on `challengeHost` and reports a
    /// system-trusted chain to `onSystemTrustVerified`, once per instance.
    func resolve(_ trust: SecTrust, challengeHost: String) -> Verdict {
        let verdict = Self.verdict(
            trust: trust,
            fingerprint: fingerprintHex,
            host: host,
            challengeHost: challengeHost,
            systemTrust: systemTrust
        )
        if let host, verdict == .systemOnly || verdict == .pinned(systemTrusted: true) {
            notifySystemTrustVerified(host: host)
        }
        return verdict
    }

    /// Pure decision behind the challenge handler. The system evaluation runs
    /// only for a paired host that ``GatewayTrustPolicy`` lets qualify, and
    /// only when the challenge is for that host; any other challenge gets the
    /// strict pin verdict.
    static func verdict(
        trust: SecTrust,
        fingerprint: String,
        host: String?,
        challengeHost: String,
        systemTrust: SystemTrustEvaluator
    )
        -> Verdict {
        let pinMatches = verifyFingerprint(trust: trust, against: fingerprint)
        guard let host,
              host.caseInsensitiveCompare(challengeHost) == .orderedSame,
              GatewayTrustPolicy.systemTrustQualifies(host: host)
        else {
            return pinMatches ? .pinned(systemTrusted: false) : .rejected
        }
        let systemTrusted = systemTrust(trust, host)
        if pinMatches { return .pinned(systemTrusted: systemTrusted) }
        return systemTrusted ? .systemOnly : .rejected
    }

    /// Whether the chain served in `trust` verifies under the system roots
    /// (or `anchors`, when given) as a TLS server certificate for `host`.
    ///
    /// The evaluation runs on a new `SecTrust` built from the served chain,
    /// never on the challenge's own trust, whose exceptions the pinned path
    /// sets and which must not leak into this verdict.
    public static func evaluateSystemTrust(
        _ trust: SecTrust,
        host: String,
        anchors: [SecCertificate]? = nil,
        verifyDate: Date? = nil
    )
        -> Bool {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], !chain.isEmpty else {
            return false
        }
        var copy: SecTrust?
        let policy = SecPolicyCreateSSL(true, host as CFString)
        guard SecTrustCreateWithCertificates(chain as CFArray, policy, &copy) == errSecSuccess,
              let copy
        else { return false }
        if let anchors {
            guard SecTrustSetAnchorCertificates(copy, anchors as CFArray) == errSecSuccess,
                  SecTrustSetAnchorCertificatesOnly(copy, true) == errSecSuccess
            else { return false }
        }
        if let verifyDate, SecTrustSetVerifyDate(copy, verifyDate as CFDate) != errSecSuccess {
            return false
        }
        return SecTrustEvaluateWithError(copy, nil)
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

    private func notifySystemTrustVerified(host: String) {
        notifyLock.lock()
        let first = !notified
        notified = true
        notifyLock.unlock()
        if first { onSystemTrustVerified?(host, fingerprintHex) }
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
