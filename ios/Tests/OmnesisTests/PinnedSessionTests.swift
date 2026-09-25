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
