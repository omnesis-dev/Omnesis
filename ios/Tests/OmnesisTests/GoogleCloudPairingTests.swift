// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
@testable import Omnesis
import XCTest

final class GoogleCloudPairingTests: XCTestCase {
    private let testNow = 1_793_880_000.0
    private func candidate() throws -> GoogleGatewayBinding {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: Self.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: "cloud-identity-vectors", withExtension: "json", subdirectory: "Fixtures") ??
            bundle.url(forResource: "cloud-identity-vectors", withExtension: "json"))
        struct Root: Decodable { let gateway: GoogleGatewayBinding }
        return try JSONDecoder().decode(Root.self, from: Data(contentsOf: url)).gateway
    }

    func testRemoteApprovalCannotBypassIndependentLocalCodeComparison() throws {
        let challenge = try CloudPairingChallenge(name: "Fictional phone")
        var flow = try CloudPairingConfirmation(challenge: challenge, candidate: candidate(), now: testNow)
        XCTAssertThrowsError(try flow.pairingPayload(now: testNow))
        try flow.receive(
            .init(
                status: "approved",
                verificationCode: flow.verificationCode,
                expiresAt: (testNow + 100) * 1000,
                pairingCode: "SYNTHETIC-CODE"
            ),
            now: testNow
        )
        XCTAssertTrue(flow.approved)
        XCTAssertFalse(flow.compared)
        XCTAssertThrowsError(try flow.pairingPayload(now: testNow))
        flow.confirmComparison()
        let payload = try PairingPayload.decode(from: flow.pairingPayload(now: testNow))
        guard case .v4(let value) = payload,
              case .pinnedKeyStrict(let fingerprint) = value.tls else { return XCTFail("Strict pin required") }
        XCTAssertEqual(fingerprint, flow.spkiFingerprint)
        XCTAssertEqual(value.pairingCode, "SYNTHETIC-CODE")
        XCTAssertThrowsError(try flow.pairingPayload(now: testNow + 100))
    }

    func testLocalComparisonCannotBypassGatewayApproval() throws {
        var flow = try CloudPairingConfirmation(
            challenge: CloudPairingChallenge(name: "Fictional phone"),
            candidate: candidate(),
            now: testNow
        )
        flow.confirmComparison()
        try flow.receive(
            .init(status: "pending", verificationCode: flow.verificationCode, expiresAt: (testNow + 100) * 1000, pairingCode: nil),
            now: testNow
        )
        XCTAssertThrowsError(try flow.pairingPayload(now: testNow))
        for progress in [
            CloudPairingProgress(
                status: "denied",
                verificationCode: flow.verificationCode,
                expiresAt: (testNow + 100) * 1000,
                pairingCode: nil
            ),
            .init(status: "approved", verificationCode: flow.verificationCode, expiresAt: (testNow + 100) * 1000, pairingCode: nil),
            .init(status: "approved", verificationCode: flow.verificationCode, expiresAt: (testNow + 100) * 1000, pairingCode: ""),
            .init(status: "pending", verificationCode: "FAKE-CODE", expiresAt: (testNow + 100) * 1000, pairingCode: nil),
            .init(status: "pending", verificationCode: flow.verificationCode, expiresAt: .nan, pairingCode: nil),
        ] {
            XCTAssertThrowsError(try flow.receive(progress, now: testNow))
        }
        XCTAssertFalse(flow.approved)
    }

    func testFailedExchangeCannotTreatAnOldPairingAsSuccessful() throws {
        var flow = try CloudPairingConfirmation(challenge: CloudPairingChallenge(name: "Phone"), candidate: candidate(), now: testNow)
        let fresh = Pairing(
            url: flow.origin,
            token: "synthetic",
            pairingGeneration: "new-generation",
            accountId: "local",
            deviceId: "fictional-phone",
            gatewayName: "Fictional gateway",
            fingerprint: flow.fingerprint,
            spkiFingerprint: flow.spkiFingerprint,
            tlsMode: .pinnedKeyStrict
        )
        XCTAssertFalse(flow.acceptsCompletedPairing(fresh, previousGeneration: "old-generation"))
        try flow.receive(.init(
            status: "approved",
            verificationCode: flow.verificationCode,
            expiresAt: (testNow + 100) * 1000,
            pairingCode: "SYNTHETIC-CODE"
        ), now: testNow)
        flow.confirmComparison()
        XCTAssertTrue(flow.acceptsCompletedPairing(fresh, previousGeneration: "old-generation"))
        XCTAssertFalse(flow.acceptsCompletedPairing(fresh, previousGeneration: "new-generation"))
        XCTAssertFalse(flow.acceptsCompletedPairing(nil, previousGeneration: nil))
        for (mode, fingerprint, generation, origin) in try [
            (PairingTlsMode.system, flow.spkiFingerprint, "new-generation", flow.origin),
            (.pinnedKeyStrict, String(repeating: "0", count: 64), "new-generation", flow.origin),
            (.pinnedKeyStrict, flow.spkiFingerprint, "", flow.origin),
            (.pinnedKeyStrict, flow.spkiFingerprint, "new-generation", XCTUnwrap(URL(string: "https://other.example.test"))),
        ] {
            let pairing = Pairing(
                url: origin,
                token: "synthetic",
                pairingGeneration: generation,
                accountId: "local",
                deviceId: "fictional-phone",
                gatewayName: "Fictional gateway",
                fingerprint: flow.fingerprint,
                spkiFingerprint: fingerprint,
                tlsMode: mode
            )
            XCTAssertFalse(flow.acceptsCompletedPairing(pairing, previousGeneration: "old-generation"))
        }
    }

    func testSASBindsTheCandidateCertificateAndPrivateChallenge() throws {
        let firstChallenge = try CloudPairingChallenge(
            name: "Phone",
            requestId: "00000000-0000-4000-8000-000000000001",
            secret: String(repeating: "17", count: 32)
        )
        let b = try CloudPairingChallenge(name: "Phone", requestId: firstChallenge.requestId, secret: String(repeating: "18", count: 32))
        let code = try firstChallenge.verificationCode(fingerprint: String(repeating: "a", count: 64))
        XCTAssertEqual(code.count, 24)
        XCTAssertNotEqual(code, try firstChallenge.verificationCode(fingerprint: String(repeating: "b", count: 64)))
        XCTAssertNotEqual(code, try b.verificationCode(fingerprint: String(repeating: "a", count: 64)))
        XCTAssertNotEqual(try firstChallenge.nonce, try b.nonce)
        XCTAssertThrowsError(try firstChallenge.verificationCode(fingerprint: "invalid"))
        XCTAssertThrowsError(try CloudPairingChallenge(name: " "))
        XCTAssertThrowsError(try CloudPairingChallenge(name: "Phone", requestId: "invalid"))
        XCTAssertThrowsError(try CloudPairingChallenge(name: "Phone", secret: "short"))
        XCTAssertEqual(try CloudPairingChallenge(name: "\u{FEFF} Phone \u{00A0}").name, "Phone")
        XCTAssertEqual(try CloudPairingChallenge(name: "\u{0085}Phone\u{0085}").name, "\u{0085}Phone\u{0085}")
        XCTAssertThrowsError(try CloudPairingChallenge(name: String(repeating: "🚀", count: 41)))
    }

    func testEntropyFailureRefusesPairingAndThePlatformProvidesThirtyTwoRandomBytes() throws {
        XCTAssertEqual(try cloudSecureRandomBytes().count, 32)
        XCTAssertThrowsError(try cloudSecureRandomBytes(fill: { _ in -1 })) { error in
            XCTAssertEqual(error as? CloudPairingError, .configuration)
        }
    }

    func testUntrustedDirectoryParsingNeedsNoExpiredGoogleProofButNeverAuthenticatesIt() throws {
        let value = try candidate()
        let stale = GoogleGatewayBinding(
            gatewayId: value.gatewayId,
            publicOrigin: value.publicOrigin,
            certificate: value.certificate,
            identityToken: "expired-or-forged"
        )
        XCTAssertEqual(try stale.candidateFingerprint(now: testNow), try value.candidateFingerprint(now: testNow))
        let flow = try CloudPairingConfirmation(challenge: CloudPairingChallenge(name: "Phone"), candidate: stale, now: testNow)
        XCTAssertFalse(flow.compared)
        XCTAssertFalse(flow.approved)
        XCTAssertThrowsError(try flow.pairingPayload())
        for origin in [
            "https://127.0.0.1",
            "http://gateway.example.test",
            "https://user@gateway.example.test",
            "https://gateway.example.test/path",
        ] {
            XCTAssertThrowsError(try GoogleGatewayBinding(
                gatewayId: value.gatewayId,
                publicOrigin: origin,
                certificate: value.certificate,
                identityToken: "ignored"
            ).candidateFingerprint())
        }
        XCTAssertThrowsError(try GoogleGatewayBinding(
            gatewayId: value.gatewayId,
            publicOrigin: value.publicOrigin,
            certificate: value.certificate + value.certificate,
            identityToken: "ignored"
        )
        .candidateFingerprint())
    }

    func testPKCEUsesGoogleSystemBrowserEndpointAndBoundStateNonceAndCallback() throws {
        let auth = try GoogleNativeAuthorization(clientId: "fictional-ios.apps.googleusercontent.com", nonce: "challenge", now: testNow)
        let parts = try XCTUnwrap(URLComponents(url: auth.url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(parts.host, "accounts.google.com")
        let values = Dictionary(uniqueKeysWithValues: (parts.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(values["code_challenge_method"], "S256")
        XCTAssertEqual(values["code_challenge"], cloudDigestURL(Data(auth.verifier.utf8)))
        XCTAssertEqual(values["nonce"], "challenge")
        XCTAssertEqual(values["scope"], "openid")
        XCTAssertNil(values["client_secret"])
        let callback = try XCTUnwrap(URL(string: "\(auth.redirectURI)?state=\(auth.state)&code=synthetic%2Bcode"))
        let requestData = try auth.tokenRequest(callback: callback, now: testNow)
        let body = try XCTUnwrap(String(bytes: requestData, encoding: .utf8))
        XCTAssertTrue(body.contains("code_verifier=\(auth.verifier)"))
        XCTAssertTrue(body.contains("code=synthetic%2Bcode"))
        XCTAssertThrowsError(try auth.tokenRequest(callback: callback, now: testNow + 300))
        for suffix in [
            "",
            "?state=wrong&code=firstChallenge",
            "?state=\(auth.state)&state=\(auth.state)&code=firstChallenge",
            "?state=\(auth.state)&code=firstChallenge&code=b",
            "?state=\(auth.state)&code=firstChallenge&error=denied",
            "?state=\(auth.state)&code=firstChallenge#fragment",
        ] {
            XCTAssertThrowsError(try auth.tokenRequest(callback: XCTUnwrap(URL(string: auth.redirectURI + suffix)), now: testNow))
        }
        XCTAssertThrowsError(try auth.tokenRequest(
            callback: XCTUnwrap(URL(string: "com.fake:/oauthredirect?state=\(auth.state)&code=firstChallenge")),
            now: testNow
        ))
        XCTAssertThrowsError(try GoogleNativeAuthorization(clientId: "bad", nonce: "firstChallenge"))
        XCTAssertThrowsError(try GoogleNativeAuthorization(clientId: auth.clientId, nonce: ""))
    }
}
