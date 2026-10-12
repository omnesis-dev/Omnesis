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
        try assertTrusted(leaf: TrustFixtures.leafOne, host: "gateway.example.com")
        try assertTrusted(leaf: TrustFixtures.leafTwo, host: "gateway.example.com")
    }

    func testSystemTrustRejectsUnknownCAAndHostnameMismatch() throws {
        XCTAssertFalse(try evaluate(leaf: TrustFixtures.leafOne, host: "gateway.example.com", anchorRoot: false))
        XCTAssertFalse(try evaluate(leaf: TrustFixtures.leafOne, host: "other.example.com", anchorRoot: true))
    }

    func testPinnedLeafRejectsRotationThatSystemTrustAccepts() throws {
        let first = try TrustFixtures.certificate(TrustFixtures.leafOne)
        let secondTrust = try trust(leaf: TrustFixtures.leafTwo, host: "gateway.example.com", anchorRoot: true)
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
        let leafCertificate = try TrustFixtures.certificate(leaf)
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
            let root = try TrustFixtures.certificate(TrustFixtures.root)
            XCTAssertEqual(SecTrustSetAnchorCertificates(result, [root] as CFArray), errSecSuccess)
            XCTAssertEqual(SecTrustSetAnchorCertificatesOnly(result, true), errSecSuccess)
        }
        // Keep the fixture test independent of wall-clock time while still
        // evaluating inside both leaves' encoded validity window.
        XCTAssertEqual(SecTrustSetVerifyDate(result, TrustFixtures.verifyDate as CFDate), errSecSuccess)
        return result
    }
}
