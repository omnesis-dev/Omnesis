// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import Security

/// A private test CA and two leaves it issued for `gateway.example.com`,
/// shared by the trust suites. Both leaves are valid at ``verifyDate``; the
/// root is in no system trust store, so it must be anchored explicitly.
enum TrustFixtures {
    static let host = "gateway.example.com"

    /// Inside both leaves' validity window, so evaluation never depends on
    /// the wall clock.
    static let verifyDate = Date(timeIntervalSince1970: 1_788_220_800)

    static func certificate(_ encoded: String) throws -> SecCertificate {
        guard let data = Data(base64Encoded: encoded),
              let certificate = SecCertificateCreateWithData(nil, data as CFData)
        else {
            throw NSError(domain: "TrustFixtures", code: 1)
        }
        return certificate
    }

    static func fingerprint(_ encoded: String) throws -> String {
        try (SecCertificateCopyData(certificate(encoded)) as Data).sha256Hex
    }

    /// A trust over the chain a server would present: the leaf alone, as the
    /// gateway serves it, under a basic X.509 policy.
    static func servedTrust(_ encoded: String) throws -> SecTrust {
        var trust: SecTrust?
        let status = try SecTrustCreateWithCertificates(certificate(encoded), SecPolicyCreateBasicX509(), &trust)
        guard status == errSecSuccess, let trust else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return trust
    }

    /// Evaluates under the private root at ``verifyDate``, standing in for
    /// the system root store.
    static let anchoredEvaluator: PinnedSession.SystemTrustEvaluator = { trust, host in
        guard let root = try? certificate(TrustFixtures.root) else { return false }
        return PinnedSession.evaluateSystemTrust(trust, host: host, anchors: [root], verifyDate: verifyDate)
    }

    static let root = """
    MIIDGTCCAgGgAwIBAgIUUDfXcdAiEqrOedH8POD0O68AnEYwDQYJKoZIhvcNAQEL
    BQAwHDEaMBgGA1UEAwwRT21uZXNpcyBUZXN0IFJvb3QwHhcNMjYwODI0MTM0MzA3
    WhcNMzYwODIxMTM0MzA3WjAcMRowGAYDVQQDDBFPbW5lc2lzIFRlc3QgUm9vdDCC
    ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAK7ifP0I2O3K0AQLT77F70ZI
    eIAG0mgyX6+OG/lt4bO7hGVgBQL0GVPt/2XSlHHAwUmxHEBKnjrdOFVZ2JLDQiGs
    bZzN0JPZrxK3LvpigIciDe+4OiRDcNMTTLw39TmFND5ry3qlNErwh9bo6Dzi/s71
    HMMaeUtdgJgSg8p8gTti3PVFcmftLZCJF852IMeHaaAG1Qzo6QPOiMQYk1PEoDeQ
    d7mZvSLplF/hYnIOeQzNmZtjrPn7aZflCW9DaQtG/7asJInUZPNzkSgE/SEoZGv+
    at/SFK0xAk/6zbuVF9L0In9rSTDdevu6RtF4zA1elxkN3q2lAN9I79Y+2mhLKU8C
    AwEAAaNTMFEwHQYDVR0OBBYEFKopDGrwBH3f3PsbglELV1e73deYMB8GA1UdIwQY
    MBaAFKopDGrwBH3f3PsbglELV1e73deYMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
    hvcNAQELBQADggEBABuULtNHwwwlErHgKUetW/LGkdp6jUq9iZajM37Fk/G6C1ht
    8J0xOprhrlqwGV2p8nWfpXbDBZ4QHCTyjgc9h03TfHdzyHLNjdNbMi2XQ06BRw6V
    uGBc5KB6UYCmRXxXIiDVUD9RQl5uy9+eKjl4xPp3W5fy0Z1T0njK1rUp+SeNANlh
    sfFgAKFSAEO3XaEn2g1UorlJHnErkdnjV3qcuGKgDoNzlncPnWKarxduxkB0a/Kv
    F6vepswaSSrIErgQR/eQFQooVg/R4OtBGHRpeeHmNr28Bj3dwjxCNocKxEdjvgxb
    +SYR7CtJQzipqKJKabmnP3RxR2c1LHbtaxhJn5k=
    """.replacingOccurrences(of: "\n", with: "")
    static let leafOne = """
    MIIDWTCCAkGgAwIBAgIUB5HsTI6xS1Xbn8TTcJG1PsC7l10wDQYJKoZIhvcNAQEL
    BQAwHDEaMBgGA1UEAwwRT21uZXNpcyBUZXN0IFJvb3QwHhcNMjYwODI0MTM0MzA4
    WhcNMjcwODI0MTM0MzA4WjAeMRwwGgYDVQQDDBNnYXRld2F5LmV4YW1wbGUuY29t
    MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu3xdkyV6O0SlzFGMjlt6
    uzXzvEX+0RC0H0g7AblrSsvPIxoGFHBQ2VRvmn7ffoF1AdeILnC9eo51fRrAESAh
    uy8dt7r3vhf3GbgkL+h4d5l+S9LpszERd+KagpKr8ph/9de75ThM2ZnaAwq7JgPy
    2dYnxl1o0Ku11V/eOMgaZsI7CRcEsS5PRrMPgSEf1f85es/n28Tm0VQFvuoZf4RO
    TecJFOFaRrqN+B21Uud1HPhP0pgUqPnVKBAco0R2MrhU0LBzGj8982UwjqcQqggn
    N2BU8MrVYZjU0yJ0QodoenGzRb1gq6/5fp2qOgEOs7BYIricC4X1FjG8XrIM7L1n
    DwIDAQABo4GQMIGNMB4GA1UdEQQXMBWCE2dhdGV3YXkuZXhhbXBsZS5jb20wCQYD
    VR0TBAIwADALBgNVHQ8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0O
    BBYEFFuUFET/O4qSXXp/SrUOlsa64QUcMB8GA1UdIwQYMBaAFKopDGrwBH3f3Psb
    glELV1e73deYMA0GCSqGSIb3DQEBCwUAA4IBAQBh8875CrUazAhLtmosBH/tyJXE
    6Kcv5tL/HAgpmAOh7iblQjdmXmSx62A0BQ9b7vxhVTw6ZIWFYemhQ3n/3oC6FztF
    pyDQLiJtpDf1++dFSGKmrIiwvaafGYLJXa5NOBV1kZq579g0VDswNX6FShXtyD02
    kijWvUVKtAiKF5Dt2M3KF5SO8BrnHY3TIuyhKBRtn/cAYmjFW+eu4+3f3cNL8ZRu
    DnGcR69VHr+lBXLcgdX2ClFLhGgKtqMzeVb3V4Q4ilvyZgtVxOsXZjCrdug5DtDG
    G/A/NeYqvSESKmDsntbrmYzirD4CyEt5AoojCl3wsNUW8PcLCUcX0wsqXaxp
    """.replacingOccurrences(of: "\n", with: "")
    static let leafTwo = """
    MIIDWTCCAkGgAwIBAgIUB5HsTI6xS1Xbn8TTcJG1PsC7l14wDQYJKoZIhvcNAQEL
    BQAwHDEaMBgGA1UEAwwRT21uZXNpcyBUZXN0IFJvb3QwHhcNMjYwODI0MTM0MzA4
    WhcNMjcwODI0MTM0MzA4WjAeMRwwGgYDVQQDDBNnYXRld2F5LmV4YW1wbGUuY29t
    MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArVAVbKPc4jgCqOzCA7Xi
    buBSq6A4DDw/oG7GHjey1l4vfG197vX5wkASXJiesrDKz0Ci4lXXdSHu1nAhbEOG
    HKJe4NS2Ey6u4presj6uux2EjQoh1RPhp23MrZfniLnNc1nuimKH+w7lOykqw6kB
    4QL70C2GUoKw18l3x76B5n/hR0hnr4R6qWhvR88T/MGpo909ESw051fj0pAgaJkh
    i216a4nfWzWC98lds8c8f37mGMNOdkqMl8zWRZRS3EKMAgHuAamIUvgaIWXLtA1c
    ZBSXkTlLNtJLgZsQUZS/Iax/JSnpfG0Ot+nwDWNbs+w0bPwnhaHSKQEqb+y8sFrM
    JQIDAQABo4GQMIGNMB4GA1UdEQQXMBWCE2dhdGV3YXkuZXhhbXBsZS5jb20wCQYD
    VR0TBAIwADALBgNVHQ8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0O
    BBYEFBzlAwwWbgos2pyEjrzYgcLE6Xj6MB8GA1UdIwQYMBaAFKopDGrwBH3f3Psb
    glELV1e73deYMA0GCSqGSIb3DQEBCwUAA4IBAQAVcCGhwAwjc220Ms3B94bSXCuA
    sZhK1J+RGRso27RgPcVS/gjvx2KkuotD+rXcL8TiY7yxguxGAPb6+l7IkRKrDBzB
    LbbUXAIPZU/sbEJ3WukpxvhLzWeawzSPlSAKgefupeqr7tHnvvokDyTYCGtvSjdB
    76pPoIJjSE6tAWoVLY1jOv1NYq/HS3yoKEuioSf2o/Rz59FYiVQU0uSnH+RHfAPz
    h8ZNYd9cIkEuzk37/pAcNU9X6BhbVik7443Lkhb5mz+kfxXVWImX9rRZIdIgQv2n
    5GeKVFDDWc4weQc7CA/YIS0eY6v1GWN8wyEtB7WqyeblPcxTVXX6nBP/plic
    """.replacingOccurrences(of: "\n", with: "")
}

/// Counts evaluations or callbacks across the `@Sendable` closures under test,
/// keeping the host and pin each system-trust report named.
final class EvaluationLog: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    private var reported: [Report] = []

    struct Report: Equatable {
        let host: String
        let fingerprint: String
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return calls
    }

    var reports: [Report] {
        lock.lock()
        defer { lock.unlock() }
        return reported
    }

    func record() {
        lock.lock()
        calls += 1
        lock.unlock()
    }

    /// Records a system-trust report; pass as `onSystemTrustVerified`.
    func report(host: String, fingerprint: String) {
        lock.lock()
        calls += 1
        reported.append(Report(host: host, fingerprint: fingerprint))
        lock.unlock()
    }

    func recording(_ answer: Bool) -> PinnedSession.SystemTrustEvaluator {
        { [self] _, _ in
            record()
            return answer
        }
    }
}
