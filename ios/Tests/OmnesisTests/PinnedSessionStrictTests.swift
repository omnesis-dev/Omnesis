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

    /// A gateway whose remote access is off keeps serving its last certificate at home and
    /// cannot renew it. Its pinned key still proves who it is, so the direct path accepts it.
    func testAKeyPinAcceptsAnExpiredCertificateOnlyOnTheDirectPath() throws {
        let der = try SecCertificateCopyData(TrustFixtures.certificate(TrustFixtures.leafOne)) as Data
        let key = try GatewayKeyFingerprint.spki(der)
        let expiry = try GatewayKeyFingerprint.expiry(der)
        XCTAssertGreaterThan(expiry, TrustFixtures.verifyDate)
        let trust = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        let expired = expiry.addingTimeInterval(86400 * 400)
        func verdict(_ served: SecTrust = trust, host: String = TrustFixtures.host, at date: Date, direct: Bool) -> PinnedSession.Verdict {
            PinnedSession.verdict(
                trust: served,
                fingerprint: "",
                host: TrustFixtures.host,
                challengeHost: host,
                systemTrust: { _, _ in true },
                verificationDate: date,
                spkiFingerprint: key,
                expiredAccepted: direct
            )
        }
        // A current certificate is accepted on either path.
        XCTAssertEqual(verdict(at: TrustFixtures.verifyDate, direct: true), .pinned(systemTrusted: false))
        XCTAssertEqual(verdict(at: TrustFixtures.verifyDate, direct: false), .pinned(systemTrusted: false))
        // Expired with the pinned key: the home network accepts it, the relay path does not.
        XCTAssertEqual(verdict(at: expired, direct: true), .pinned(systemTrusted: false))
        XCTAssertEqual(verdict(at: expiry.addingTimeInterval(1), direct: true), .pinned(systemTrusted: false))
        XCTAssertEqual(verdict(at: expired, direct: false), .rejected)
        // Expired with another key is refused wherever it is served.
        let other = try TrustFixtures.servedTrust(TrustFixtures.leafTwo)
        XCTAssertEqual(verdict(other, at: expired, direct: true), .rejected)
        XCTAssertEqual(verdict(other, at: TrustFixtures.verifyDate, direct: true), .rejected)
        // Every other check stays: a certificate not valid yet, and another name.
        XCTAssertEqual(verdict(at: Date(timeIntervalSince1970: 0), direct: true), .rejected)
        XCTAssertEqual(verdict(host: "other.example.com", at: expired, direct: true), .rejected)

        // A leaf pin never gains the allowance, and neither does a session with no home route.
        let leaf = try PinnedSession.verdict(
            trust: trust,
            fingerprint: TrustFixtures.fingerprint(TrustFixtures.leafOne),
            host: nil,
            challengeHost: TrustFixtures.host,
            systemTrust: { _, _ in true },
            requireCertificateValidity: true,
            verificationDate: expired,
            expiredAccepted: true
        )
        XCTAssertEqual(leaf, .rejected)
        let unrouted = PinnedSession(spkiFingerprint: key, host: TrustFixtures.host, verificationDate: expired)
        XCTAssertEqual(unrouted.resolve(trust, challengeHost: TrustFixtures.host), .rejected)
        XCTAssertEqual(unrouted.resolve(trust, challengeHost: TrustFixtures.host, directPath: true), .rejected)
    }
}
