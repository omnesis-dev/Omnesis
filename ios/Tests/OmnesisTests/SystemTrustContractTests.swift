// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import Security
import XCTest

/// Exercises the platform trust engine behind V4 `system` pairings with a
/// private test CA and two independently issued leaves. This proves hostname,
/// chain, and rotation semantics without depending on the network or a host
/// machine's installed certificates.
final class SystemTrustContractTests: XCTestCase {
    func testSystemTrustAcceptsMatchingHostnameAndSameCARotation() throws {
        try assertTrusted(leaf: Self.leafOne, host: "gateway.example.com")
        try assertTrusted(leaf: Self.leafTwo, host: "gateway.example.com")
    }

    func testSystemTrustRejectsUnknownCAAndHostnameMismatch() throws {
        XCTAssertFalse(try evaluate(leaf: Self.leafOne, host: "gateway.example.com", anchorRoot: false))
        XCTAssertFalse(try evaluate(leaf: Self.leafOne, host: "other.example.com", anchorRoot: true))
    }

    func testPinnedLeafRejectsRotationThatSystemTrustAccepts() throws {
        let first = try certificate(Self.leafOne)
        let secondTrust = try trust(leaf: Self.leafTwo, host: "gateway.example.com", anchorRoot: true)
        assertEvaluates(secondTrust)
        let firstFingerprint = (SecCertificateCopyData(first) as Data).sha256Hex
        XCTAssertFalse(PinnedSession.verifyFingerprint(trust: secondTrust, against: firstFingerprint))
    }

    private func evaluate(leaf: String, host: String, anchorRoot: Bool) throws -> Bool {
        try SecTrustEvaluateWithError(trust(leaf: leaf, host: host, anchorRoot: anchorRoot), nil)
    }

    private func assertTrusted(leaf: String, host: String) throws {
        try assertEvaluates(trust(leaf: leaf, host: host, anchorRoot: true))
    }

    private func assertEvaluates(_ value: SecTrust) {
        var error: CFError?
        XCTAssertTrue(SecTrustEvaluateWithError(value, &error), String(describing: error))
    }

    private func trust(leaf: String, host: String, anchorRoot: Bool) throws -> SecTrust {
        let leafCertificate = try certificate(leaf)
        var result: SecTrust?
        let status = SecTrustCreateWithCertificates(
            leafCertificate,
            SecPolicyCreateSSL(true, host as CFString),
            &result
        )
        guard status == errSecSuccess, let result else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        if anchorRoot {
            let root = try certificate(Self.root)
            XCTAssertEqual(SecTrustSetAnchorCertificates(result, [root] as CFArray), errSecSuccess)
            XCTAssertEqual(SecTrustSetAnchorCertificatesOnly(result, true), errSecSuccess)
        }
        // Keep the fixture test independent of wall-clock time while still
        // evaluating inside both leaves' encoded validity window.
        XCTAssertEqual(
            SecTrustSetVerifyDate(result, Date(timeIntervalSince1970: 1_788_220_800) as CFDate),
            errSecSuccess
        )
        return result
    }

    private func certificate(_ encoded: String) throws -> SecCertificate {
        guard let data = Data(base64Encoded: encoded),
              let certificate = SecCertificateCreateWithData(nil, data as CFData)
        else {
            throw NSError(domain: "SystemTrustContractTests", code: 1)
        }
        return certificate
    }

    private static let root = "MIIDGTCCAgGgAwIBAgIUUDfXcdAiEqrOedH8POD0O68AnEYwDQYJKoZIhvcNAQELBQAwHDEaMBgGA1UEAwwRT21uZXNpcyBUZXN0IFJvb3QwHhcNMjYwODI0MTM0MzA3WhcNMzYwODIxMTM0MzA3WjAcMRowGAYDVQQDDBFPbW5lc2lzIFRlc3QgUm9vdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAK7ifP0I2O3K0AQLT77F70ZIeIAG0mgyX6+OG/lt4bO7hGVgBQL0GVPt/2XSlHHAwUmxHEBKnjrdOFVZ2JLDQiGsbZzN0JPZrxK3LvpigIciDe+4OiRDcNMTTLw39TmFND5ry3qlNErwh9bo6Dzi/s71HMMaeUtdgJgSg8p8gTti3PVFcmftLZCJF852IMeHaaAG1Qzo6QPOiMQYk1PEoDeQd7mZvSLplF/hYnIOeQzNmZtjrPn7aZflCW9DaQtG/7asJInUZPNzkSgE/SEoZGv+at/SFK0xAk/6zbuVF9L0In9rSTDdevu6RtF4zA1elxkN3q2lAN9I79Y+2mhLKU8CAwEAAaNTMFEwHQYDVR0OBBYEFKopDGrwBH3f3PsbglELV1e73deYMB8GA1UdIwQYMBaAFKopDGrwBH3f3PsbglELV1e73deYMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBABuULtNHwwwlErHgKUetW/LGkdp6jUq9iZajM37Fk/G6C1ht8J0xOprhrlqwGV2p8nWfpXbDBZ4QHCTyjgc9h03TfHdzyHLNjdNbMi2XQ06BRw6VuGBc5KB6UYCmRXxXIiDVUD9RQl5uy9+eKjl4xPp3W5fy0Z1T0njK1rUp+SeNANlhsfFgAKFSAEO3XaEn2g1UorlJHnErkdnjV3qcuGKgDoNzlncPnWKarxduxkB0a/KvF6vepswaSSrIErgQR/eQFQooVg/R4OtBGHRpeeHmNr28Bj3dwjxCNocKxEdjvgxb+SYR7CtJQzipqKJKabmnP3RxR2c1LHbtaxhJn5k="
    private static let leafOne = "MIIDWTCCAkGgAwIBAgIUB5HsTI6xS1Xbn8TTcJG1PsC7l10wDQYJKoZIhvcNAQELBQAwHDEaMBgGA1UEAwwRT21uZXNpcyBUZXN0IFJvb3QwHhcNMjYwODI0MTM0MzA4WhcNMjcwODI0MTM0MzA4WjAeMRwwGgYDVQQDDBNnYXRld2F5LmV4YW1wbGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu3xdkyV6O0SlzFGMjlt6uzXzvEX+0RC0H0g7AblrSsvPIxoGFHBQ2VRvmn7ffoF1AdeILnC9eo51fRrAESAhuy8dt7r3vhf3GbgkL+h4d5l+S9LpszERd+KagpKr8ph/9de75ThM2ZnaAwq7JgPy2dYnxl1o0Ku11V/eOMgaZsI7CRcEsS5PRrMPgSEf1f85es/n28Tm0VQFvuoZf4ROTecJFOFaRrqN+B21Uud1HPhP0pgUqPnVKBAco0R2MrhU0LBzGj8982UwjqcQqggnN2BU8MrVYZjU0yJ0QodoenGzRb1gq6/5fp2qOgEOs7BYIricC4X1FjG8XrIM7L1nDwIDAQABo4GQMIGNMB4GA1UdEQQXMBWCE2dhdGV3YXkuZXhhbXBsZS5jb20wCQYDVR0TBAIwADALBgNVHQ8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFFuUFET/O4qSXXp/SrUOlsa64QUcMB8GA1UdIwQYMBaAFKopDGrwBH3f3PsbglELV1e73deYMA0GCSqGSIb3DQEBCwUAA4IBAQBh8875CrUazAhLtmosBH/tyJXE6Kcv5tL/HAgpmAOh7iblQjdmXmSx62A0BQ9b7vxhVTw6ZIWFYemhQ3n/3oC6FztFpyDQLiJtpDf1++dFSGKmrIiwvaafGYLJXa5NOBV1kZq579g0VDswNX6FShXtyD02kijWvUVKtAiKF5Dt2M3KF5SO8BrnHY3TIuyhKBRtn/cAYmjFW+eu4+3f3cNL8ZRuDnGcR69VHr+lBXLcgdX2ClFLhGgKtqMzeVb3V4Q4ilvyZgtVxOsXZjCrdug5DtDGG/A/NeYqvSESKmDsntbrmYzirD4CyEt5AoojCl3wsNUW8PcLCUcX0wsqXaxp"
    private static let leafTwo = "MIIDWTCCAkGgAwIBAgIUB5HsTI6xS1Xbn8TTcJG1PsC7l14wDQYJKoZIhvcNAQELBQAwHDEaMBgGA1UEAwwRT21uZXNpcyBUZXN0IFJvb3QwHhcNMjYwODI0MTM0MzA4WhcNMjcwODI0MTM0MzA4WjAeMRwwGgYDVQQDDBNnYXRld2F5LmV4YW1wbGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArVAVbKPc4jgCqOzCA7XibuBSq6A4DDw/oG7GHjey1l4vfG197vX5wkASXJiesrDKz0Ci4lXXdSHu1nAhbEOGHKJe4NS2Ey6u4presj6uux2EjQoh1RPhp23MrZfniLnNc1nuimKH+w7lOykqw6kB4QL70C2GUoKw18l3x76B5n/hR0hnr4R6qWhvR88T/MGpo909ESw051fj0pAgaJkhi216a4nfWzWC98lds8c8f37mGMNOdkqMl8zWRZRS3EKMAgHuAamIUvgaIWXLtA1cZBSXkTlLNtJLgZsQUZS/Iax/JSnpfG0Ot+nwDWNbs+w0bPwnhaHSKQEqb+y8sFrMJQIDAQABo4GQMIGNMB4GA1UdEQQXMBWCE2dhdGV3YXkuZXhhbXBsZS5jb20wCQYDVR0TBAIwADALBgNVHQ8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFBzlAwwWbgos2pyEjrzYgcLE6Xj6MB8GA1UdIwQYMBaAFKopDGrwBH3f3PsbglELV1e73deYMA0GCSqGSIb3DQEBCwUAA4IBAQAVcCGhwAwjc220Ms3B94bSXCuAsZhK1J+RGRso27RgPcVS/gjvx2KkuotD+rXcL8TiY7yxguxGAPb6+l7IkRKrDBzBLbbUXAIPZU/sbEJ3WukpxvhLzWeawzSPlSAKgefupeqr7tHnvvokDyTYCGtvSjdB76pPoIJjSE6tAWoVLY1jOv1NYq/HS3yoKEuioSf2o/Rz59FYiVQU0uSnH+RHfAPzh8ZNYd9cIkEuzk37/pAcNU9X6BhbVik7443Lkhb5mz+kfxXVWImX9rRZIdIgQv2n5GeKVFDDWc4weQc7CA/YIS0eY6v1GWN8wyEtB7WqyeblPcxTVXX6nBP/plic"
}
