// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class PinnedSessionStrictTests: XCTestCase {
    func testStrictMatchingPinChecksCertificateValidityAndExactChallengeHostname() throws {
        let trust = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        let pin = try TrustFixtures.fingerprint(TrustFixtures.leafOne)
        let valid = PinnedSession(fingerprintHex: pin, requireCertificateValidity: true, verificationDate: TrustFixtures.verifyDate)
        XCTAssertEqual(valid.resolve(trust, challengeHost: TrustFixtures.host), .pinned(systemTrusted: false))
        XCTAssertEqual(valid.resolve(trust, challengeHost: "other.example.com"), .rejected)
        for date in [Date(timeIntervalSince1970: 0), Date(timeIntervalSince1970: 2_100_000_000)] {
            let strict = PinnedSession(fingerprintHex: pin, requireCertificateValidity: true, verificationDate: date)
            XCTAssertEqual(strict.resolve(trust, challengeHost: TrustFixtures.host), .rejected)
            let legacy = PinnedSession(fingerprintHex: pin, verificationDate: date)
            XCTAssertEqual(legacy.resolve(trust, challengeHost: TrustFixtures.host), .pinned(systemTrusted: false))
        }
    }

    func testStrictPairingCannotAdoptAReplacementCertificateThroughSystemTrust() throws {
        let pin = try TrustFixtures.fingerprint(TrustFixtures.leafOne)
        let session = OmnesisURLSession.resolveSession(
            tlsMode: "pinned-leaf-strict",
            fingerprint: pin,
            host: TrustFixtures.host,
            systemTrust: { _, _ in true }
        )
        defer { session.invalidateAndCancel() }
        let delegate = try XCTUnwrap(session.delegate as? PinnedSession)
        let replacement = try TrustFixtures.servedTrust(TrustFixtures.leafTwo)
        XCTAssertEqual(delegate.resolve(replacement, challengeHost: TrustFixtures.host), .rejected)
    }
}
