// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
@testable import Omnesis
import XCTest

/// Drives the pure fingerprint-comparison helper exposed on
/// `PinnedSession` without spinning up a real TLS server. Builds an
/// ad-hoc self-signed cert via `SecCertificateCreateWithData`, wraps
/// it in a `SecTrust`, and checks the comparison both with the
/// matching digest and with a deliberately-wrong one.
final class PinnedSessionTests: XCTestCase {
    /// Smoke-test the `Data.sha256Hex` extension that the verify
    /// helper relies on. This guards against any future refactor that
    /// silently changes the hashing path.
    func testSha256HexLowercasedDigest() {
        let input = Data("hello".utf8)
        let expected = SHA256.hash(data: input)
            .map { String(format: "%02x", $0) }
            .joined()
        XCTAssertEqual(input.sha256Hex, expected)
        XCTAssertEqual(input.sha256Hex.count, 64)
        XCTAssertEqual(input.sha256Hex, input.sha256Hex.lowercased())
    }

    /// `verifyFingerprint(trust:against:)` returns true iff the trust's
    /// leaf cert's DER digest matches the supplied fingerprint.
    func testVerifyFingerprintMatchesGeneratedCert() throws {
        guard let (trust, expectedDigest) = Self.makeSelfSignedTrust() else {
            throw XCTSkip("Could not build a self-signed SecTrust on this platform")
        }
        XCTAssertTrue(
            PinnedSession.verifyFingerprint(trust: trust, against: expectedDigest)
        )
        // Mixed-case input still matches — helper lowercases internally.
        XCTAssertTrue(
            PinnedSession.verifyFingerprint(
                trust: trust,
                against: expectedDigest.uppercased()
            )
        )
    }

    func testVerifyFingerprintRejectsWrongDigest() throws {
        guard let (trust, _) = Self.makeSelfSignedTrust() else {
            throw XCTSkip("Could not build a self-signed SecTrust on this platform")
        }
        let wrong = String(repeating: "0", count: 64)
        XCTAssertFalse(
            PinnedSession.verifyFingerprint(trust: trust, against: wrong)
        )
    }

    // MARK: - Verdict

    func testPinnedLeafOnADNSHostThatAlsoVerifiesUnderSystemRootsIsUpgradable() throws {
        let verdict = try PinnedSession.verdict(
            trust: TrustFixtures.servedTrust(TrustFixtures.leafOne),
            fingerprint: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: TrustFixtures.host,
            challengeHost: TrustFixtures.host,
            systemTrust: TrustFixtures.anchoredEvaluator
        )
        XCTAssertEqual(verdict, .pinned(systemTrusted: true))
    }

    func testAHostThatCannotCarryAPublicCertificateNeverRunsTheSystemEvaluation() throws {
        let evaluations = EvaluationLog()
        let trust = try TrustFixtures.servedTrust(TrustFixtures.leafTwo)
        for host in ["192.0.2.10", "[2001:db8::1]", "localhost"] {
            XCTAssertEqual(
                try PinnedSession.verdict(
                    trust: trust,
                    fingerprint: TrustFixtures.fingerprint(TrustFixtures.leafTwo),
                    host: host,
                    challengeHost: host,
                    systemTrust: evaluations.recording(true)
                ),
                .pinned(systemTrusted: false)
            )
            XCTAssertEqual(
                try PinnedSession.verdict(
                    trust: trust,
                    fingerprint: TrustFixtures.fingerprint(TrustFixtures.leafOne),
                    host: host,
                    challengeHost: host,
                    systemTrust: evaluations.recording(true)
                ),
                .rejected,
                "a rotated leaf on \(host) must stay rejected"
            )
        }
        XCTAssertEqual(evaluations.count, 0)
    }

    func testAChallengeForAnotherHostGetsTheStrictPinVerdict() throws {
        let evaluations = EvaluationLog()
        let pinned = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        let rotated = try TrustFixtures.servedTrust(TrustFixtures.leafTwo)
        let fingerprint = try TrustFixtures.fingerprint(TrustFixtures.leafOne)

        let verdicts = [pinned, rotated].map { trust in
            PinnedSession.verdict(
                trust: trust,
                fingerprint: fingerprint,
                host: TrustFixtures.host,
                challengeHost: "other.example.com",
                systemTrust: evaluations.recording(true)
            )
        }

        XCTAssertEqual(verdicts, [.pinned(systemTrusted: false), .rejected])
        XCTAssertEqual(evaluations.count, 0)
    }

    func testTheChallengeHostMatchesThePairedHostCaseInsensitively() throws {
        let verdict = try PinnedSession.verdict(
            trust: TrustFixtures.servedTrust(TrustFixtures.leafTwo),
            fingerprint: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: TrustFixtures.host,
            challengeHost: TrustFixtures.host.uppercased(),
            systemTrust: TrustFixtures.anchoredEvaluator
        )
        XCTAssertEqual(verdict, .systemOnly)
    }

    func testSelfSignedPinStaysPinnedWithoutSystemTrust() throws {
        let (trust, fingerprint) = try XCTUnwrap(Self.makeSelfSignedTrust())
        let verdict = PinnedSession.verdict(
            trust: trust,
            fingerprint: fingerprint,
            host: TrustFixtures.host,
            challengeHost: TrustFixtures.host,
            systemTrust: TrustFixtures.anchoredEvaluator
        )
        XCTAssertEqual(verdict, .pinned(systemTrusted: false))
    }

    func testRotatedLeafValidForThePairedNameIsSystemOnly() throws {
        let verdict = try PinnedSession.verdict(
            trust: TrustFixtures.servedTrust(TrustFixtures.leafTwo),
            fingerprint: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: TrustFixtures.host,
            challengeHost: TrustFixtures.host,
            systemTrust: TrustFixtures.anchoredEvaluator
        )
        XCTAssertEqual(verdict, .systemOnly)
    }

    func testRotatedLeafValidOnlyForAnotherNameIsRejected() throws {
        let verdict = try PinnedSession.verdict(
            trust: TrustFixtures.servedTrust(TrustFixtures.leafTwo),
            fingerprint: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: "other.example.com",
            challengeHost: "other.example.com",
            systemTrust: TrustFixtures.anchoredEvaluator
        )
        XCTAssertEqual(verdict, .rejected)
    }

    func testRotatedLeafFromAnUnknownRootIsRejected() throws {
        let (unrelated, _) = try XCTUnwrap(Self.makeSelfSignedTrust())
        let unrelatedRoot = try XCTUnwrap((SecTrustCopyCertificateChain(unrelated) as? [SecCertificate])?.first)
        let verdict = try PinnedSession.verdict(
            trust: TrustFixtures.servedTrust(TrustFixtures.leafTwo),
            fingerprint: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: TrustFixtures.host,
            challengeHost: TrustFixtures.host,
            systemTrust: { trust, host in
                PinnedSession.evaluateSystemTrust(
                    trust,
                    host: host,
                    anchors: [unrelatedRoot],
                    verifyDate: TrustFixtures.verifyDate
                )
            }
        )
        XCTAssertEqual(verdict, .rejected)
    }

    func testSystemEvaluationIgnoresExceptionsOnTheServedTrust() throws {
        // The pinned path sets exceptions on the challenge's trust. Build a
        // served trust that fails only on the name, make it pass through its
        // own exceptions, and check the system evaluation still refuses it.
        let host = "other.example.com"
        let root = try TrustFixtures.certificate(TrustFixtures.root)
        var created: SecTrust?
        XCTAssertEqual(
            try SecTrustCreateWithCertificates(
                TrustFixtures.certificate(TrustFixtures.leafTwo),
                SecPolicyCreateSSL(true, host as CFString),
                &created
            ),
            errSecSuccess
        )
        let trust = try XCTUnwrap(created)
        XCTAssertEqual(SecTrustSetAnchorCertificates(trust, [root] as CFArray), errSecSuccess)
        XCTAssertEqual(SecTrustSetAnchorCertificatesOnly(trust, true), errSecSuccess)
        XCTAssertEqual(SecTrustSetVerifyDate(trust, TrustFixtures.verifyDate as CFDate), errSecSuccess)
        XCTAssertFalse(SecTrustEvaluateWithError(trust, nil), "the leaf is not valid for \(host)")

        let exceptions = try XCTUnwrap(SecTrustCopyExceptions(trust))
        XCTAssertTrue(SecTrustSetExceptions(trust, exceptions))
        XCTAssertTrue(SecTrustEvaluateWithError(trust, nil), "the exceptions make the served trust pass")

        XCTAssertFalse(PinnedSession.evaluateSystemTrust(
            trust,
            host: host,
            anchors: [root],
            verifyDate: TrustFixtures.verifyDate
        ))
    }

    func testSystemTrustCallbackFiresOncePerSessionNamingTheHostAndPin() throws {
        let calls = EvaluationLog()
        let fingerprint = try TrustFixtures.fingerprint(TrustFixtures.leafOne)
        let session = PinnedSession(
            fingerprintHex: fingerprint.uppercased(),
            host: TrustFixtures.host,
            onSystemTrustVerified: { calls.report(host: $0, fingerprint: $1) },
            systemTrust: TrustFixtures.anchoredEvaluator
        )
        let pinned = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        let rotated = try TrustFixtures.servedTrust(TrustFixtures.leafTwo)

        XCTAssertEqual(session.resolve(pinned, challengeHost: TrustFixtures.host), .pinned(systemTrusted: true))
        XCTAssertEqual(session.resolve(rotated, challengeHost: TrustFixtures.host), .systemOnly)
        XCTAssertEqual(session.resolve(pinned, challengeHost: TrustFixtures.host), .pinned(systemTrusted: true))
        XCTAssertEqual(calls.reports, [.init(host: TrustFixtures.host, fingerprint: fingerprint)])
    }

    func testRejectedStrictlyPinnedAndOtherHostChallengesNeverFireTheCallback() throws {
        let calls = EvaluationLog()
        let strict = try PinnedSession(
            fingerprintHex: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: "192.0.2.10",
            onSystemTrustVerified: { calls.report(host: $0, fingerprint: $1) },
            systemTrust: { _, _ in true }
        )
        XCTAssertEqual(
            try strict.resolve(TrustFixtures.servedTrust(TrustFixtures.leafOne), challengeHost: "192.0.2.10"),
            .pinned(systemTrusted: false)
        )
        let rejecting = try PinnedSession(
            fingerprintHex: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: TrustFixtures.host,
            onSystemTrustVerified: { calls.report(host: $0, fingerprint: $1) },
            systemTrust: { _, _ in false }
        )
        XCTAssertEqual(
            try rejecting.resolve(TrustFixtures.servedTrust(TrustFixtures.leafTwo), challengeHost: TrustFixtures.host),
            .rejected
        )
        let elsewhere = try PinnedSession(
            fingerprintHex: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: TrustFixtures.host,
            onSystemTrustVerified: { calls.report(host: $0, fingerprint: $1) },
            systemTrust: { _, _ in true }
        )
        XCTAssertEqual(
            try elsewhere.resolve(TrustFixtures.servedTrust(TrustFixtures.leafOne), challengeHost: "other.example.com"),
            .pinned(systemTrusted: false)
        )
        XCTAssertEqual(calls.count, 0)
    }

    // MARK: - Challenge dispositions

    func testChallengeDispositionsFollowTheVerdict() throws {
        let fingerprint = try TrustFixtures.fingerprint(TrustFixtures.leafOne)
        let accepting = PinnedSession(fingerprintHex: fingerprint, host: TrustFixtures.host, systemTrust: { _, _ in true })
        let rotated = try TrustFixtures.servedTrust(TrustFixtures.leafTwo)
        XCTAssertEqual(disposition(of: accepting, for: rotated), .useCredential)

        let refusing = PinnedSession(fingerprintHex: fingerprint, host: TrustFixtures.host, systemTrust: { _, _ in false })
        XCTAssertEqual(disposition(of: refusing, for: rotated), .cancelAuthenticationChallenge)

        let pinned = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        XCTAssertEqual(disposition(of: refusing, for: pinned), .useCredential)
    }

    func testAChallengeForAnotherHostIsNeverAcceptedOnSystemTrustAlone() throws {
        let calls = EvaluationLog()
        let accepting = try PinnedSession(
            fingerprintHex: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: TrustFixtures.host,
            onSystemTrustVerified: { calls.report(host: $0, fingerprint: $1) },
            systemTrust: { _, _ in true }
        )
        let rotated = try TrustFixtures.servedTrust(TrustFixtures.leafTwo)

        XCTAssertEqual(disposition(of: accepting, for: rotated, host: "other.example.com"), .cancelAuthenticationChallenge)
        XCTAssertEqual(calls.count, 0)
    }

    private func disposition(
        of pinned: PinnedSession,
        for trust: SecTrust,
        host: String = TrustFixtures.host
    )
        -> URLSession.AuthChallengeDisposition? {
        let challenge = URLAuthenticationChallenge(
            protectionSpace: ServerTrustProtectionSpace(trust: trust, host: host),
            proposedCredential: nil,
            previousFailureCount: 0,
            failureResponse: nil,
            error: nil,
            sender: NoopChallengeSender()
        )
        var result: URLSession.AuthChallengeDisposition?
        pinned.urlSession(pinned.session, didReceive: challenge) { disposition, _ in result = disposition }
        return result
    }

    // MARK: - Test cert helper

    /// Builds a `SecTrust` over a self-signed cert and returns the
    /// matching SHA-256 fingerprint. Returns nil if the platform
    /// can't generate one (e.g. headless CI without keychain access).
    /// Uses a tiny pre-baked DER blob so we don't depend on Security
    /// framework's cert-generation APIs that vary across iOS versions.
    static func makeSelfSignedTrust() -> (SecTrust, String)? {
        // Synthesise a minimal "DER blob" from arbitrary bytes — we
        // don't need it to parse as a real cert for the fingerprint
        // path because `SecCertificateCreateWithData` accepts any
        // structurally-valid DER. We do need real DER though — easiest
        // is to use a known-good self-signed cert generated once and
        // checked in as base64.
        guard let der = testCertDER() else { return nil }
        guard let cert = SecCertificateCreateWithData(nil, der as CFData) else {
            return nil
        }
        var trust: SecTrust?
        let status = SecTrustCreateWithCertificates(
            cert, SecPolicyCreateBasicX509(), &trust
        )
        guard status == errSecSuccess, let trust else { return nil }
        let fingerprint = der.sha256Hex
        return (trust, fingerprint)
    }

    /// A real, throwaway self-signed RSA-2048 cert (DER). Generated
    /// once with:
    ///   openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
    ///     -subj /CN=omnesis-test -keyout /dev/null -out cert.pem
    ///   openssl x509 -in cert.pem -outform der | base64
    /// Embedded as base64 so the test doesn't shell out at runtime.
    private static func testCertDER() -> Data? {
        let base64 = """
        MIIDETCCAfmgAwIBAgIUNpJvwCSa5k0yKM2eIe/s0mcPkOkwDQYJKoZIhvcNAQEL\
        BQAwFzEVMBMGA1UEAwwMb21uZXNpcy10ZXN0MCAXDTI2MDUwODA4NDI0NloYDzIx\
        MjYwNDE0MDg0MjQ2WjAXMRUwEwYDVQQDDAxvbW5lc2lzLXRlc3QwggEiMA0GCSqG\
        SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCkdk0SdW1Jluhj3+Bd8KdDeDsDn8xLylqc\
        OBMkXYyKIfEQOk+sLOhCNo0VsIvcHjiXFeKW68Z+5zf5iVQMFO6xv5VZNp/4+3W3\
        vJy/Jvp+yWtiCvktGEAK0pF857QCRsSk4H6c1Fpzshf8Rr1X6tYFYSSkh/njfrGN\
        4PwciXUsoWgnYmDEi+5WFeyvXkKOy0Sd6wUVRyEZrgGid6uruIyy3vbMOEfw5caq\
        ql+Q0d0LGMnZ0F2OLmooBnSlFp5KKkdLdG2ZkCTUOxvU9Z2MyyD7GYHdclnC2+5n\
        Z1TQY35NcklRsC6fu21OOnX93j2ZQ0UCYfxWLC4M+j68gYXLiwsHAgMBAAGjUzBR\
        MB0GA1UdDgQWBBTJlnOkc8ZTWLD0Mm5KyIOSQT+J4zAfBgNVHSMEGDAWgBTJlnOk\
        c8ZTWLD0Mm5KyIOSQT+J4zAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA\
        A4IBAQA4O3wX5cyNd+c1L6tnyV9GVz/MHDqGpBiPh2gq6oBBvbbsXw6PHEZn+jlJ\
        qFVJHQUBbGs4JtcvhWFSaa3qvvo+wO930Zofa0RpuvuNeD0GJUJZP+Hm0OEHvfoh\
        S1Y28AOQ/NSy7zJLA+JxXWWiCCzHMQhoqqN0HQ4xJhRtRsOq31Bff2UC/5q0qhHP\
        oaDh5usoCAc5aJZfc7h7Q2MUVN7/ydfQzITNI8FTvbMnXJX8dI//eSNCa2F9+dWM\
        53Z3iBUbTeTywQWYce55UJWqg4Fi5lhs/7rR+mQVu6kxGm+211Uaa2CcjhpeR1Fw\
        +E/QS1iw5HmH7GbDZVRAV99txusD
        """
        let stripped = base64
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: " ", with: "")
        return Data(base64Encoded: stripped)
    }
}

/// A server-trust protection space carrying a chosen `SecTrust`, so the
/// delegate's challenge handler can run without a TLS handshake.
private final class ServerTrustProtectionSpace: URLProtectionSpace, @unchecked Sendable {
    private let trust: SecTrust

    init(trust: SecTrust, host: String) {
        self.trust = trust
        super.init(
            host: host,
            port: 443,
            protocol: NSURLProtectionSpaceHTTPS,
            realm: nil,
            authenticationMethod: NSURLAuthenticationMethodServerTrust
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("not coded")
    }

    override var serverTrust: SecTrust? {
        trust
    }
}

private final class NoopChallengeSender: NSObject, URLAuthenticationChallengeSender {
    func use(_: URLCredential, for _: URLAuthenticationChallenge) {}
    func continueWithoutCredential(for _: URLAuthenticationChallenge) {}
    func cancel(_: URLAuthenticationChallenge) {}
}
