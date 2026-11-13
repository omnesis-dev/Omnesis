// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
@testable import Omnesis
import XCTest

/// Pure presentation decisions; actual controls are driven by CloudPairingInteractionUITests.
@available(iOS 17.0, *)
@MainActor
final class CloudPairingPresentationTests: XCTestCase {
    func testTrustDescriptionsDistinguishKeyRenewalFromLeafAndSystemTrust() throws {
        XCTAssertNil(GatewayTrustDescription.message(for: nil))
        XCTAssertTrue(try XCTUnwrap(GatewayTrustDescription.message(for: .system)).contains("system HTTPS verification"))
        let key = try XCTUnwrap(GatewayTrustDescription.message(for: .pinnedKeyStrict))
        XCTAssertTrue(key.contains("public key and HTTPS hostname"))
        XCTAssertTrue(key.contains("Certificates can renew automatically"))
        for mode in [PairingTlsMode.pinnedLeaf, .pinnedLeafStrict] {
            XCTAssertTrue(try XCTUnwrap(GatewayTrustDescription.message(for: mode)).contains("certificate-pinned"))
        }
        XCTAssertTrue(try XCTUnwrap(GatewayTrustDescription.message(for: .legacy)).contains("Re-pair to upgrade"))
    }

    func testUITestCandidateUsesRealHostnameDateAndSPKIValidation() throws {
        struct Fixture: Decodable { let clock: Double
            let gateway: GoogleGatewayBinding
        }
        let bundle = Bundle(for: Self.self)
        let file = try XCTUnwrap(bundle.url(forResource: "cloud-ui-gateway", withExtension: "json", subdirectory: "Fixtures") ?? bundle.url(
            forResource: "cloud-ui-gateway",
            withExtension: "json"
        ))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: file))
        let flow = try CloudPairingConfirmation(
            challenge: CloudPairingChallenge(name: "Test new phone"),
            candidate: fixture.gateway,
            now: fixture.clock
        )
        XCTAssertEqual(flow.origin.absoluteString, "https://gateway.localhost:9")
        XCTAssertEqual(flow.spkiFingerprint.count, 64)
        XCTAssertFalse(flow.approved)
        XCTAssertFalse(flow.compared)
        XCTAssertThrowsError(try flow.pairingPayload(now: fixture.clock))
    }
}
#endif
