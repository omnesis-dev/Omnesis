// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class GatewayExtensionCredentialPolicyTests: XCTestCase {
    func testWidgetKeyPolicyAndRouteFactsPreserveRenderedAuthority() throws {
        let first = try credential("pinned-key-strict", key: String(repeating: "a", count: 64))
        XCTAssertTrue(first.isSecure)
        XCTAssertEqual(first.directRoute?.candidates, [])
        let hints = [GatewayDirectCandidate(address: "10.0.0.2", port: 9443)]
        let refreshed = try credential("pinned-key-strict", key: first.spkiFingerprint, hints: hints)
        XCTAssertEqual(first.authorityID, refreshed.authorityID)
        XCTAssertEqual(refreshed.directRoute?.candidates, hints)
        XCTAssertNotEqual(first.authorityID, try credential("pinned-key-strict", key: String(repeating: "b", count: 64)).authorityID)
        for missing in [nil, "short", String(repeating: "z", count: 64)] as [String?] {
            XCTAssertFalse(try credential("pinned-key-strict", key: missing).isSecure)
            XCTAssertFalse(try credential("pinned-leaf-strict", leaf: missing).isSecure)
        }
        for mode in ["pinned-leaf", "pinned-leaf-strict"] {
            XCTAssertTrue(try credential(mode, leaf: String(repeating: "a", count: 64)).isSecure)
        }
        XCTAssertNotNil(try credential("pinned-leaf-strict", hints: hints).directRoute)
        XCTAssertNil(try credential("pinned-leaf-strict").directRoute)
        XCTAssertNil(try credential("pinned-leaf-strict", hints: []).directRoute)
        XCTAssertNil(try credential("pinned-leaf-strict", hints: [.init(address: "203.0.113.8", port: 443)]).directRoute)
        XCTAssertNil(try credential("pinned-key-strict", origin: "https://localhost").directRoute)
        for mode in ["legacy", "system", "pinned-leaf", "unknown"] {
            XCTAssertNil(try credential(mode, hints: hints).directRoute)
        }
        XCTAssertTrue(try credential("system").isSecure)
        XCTAssertFalse(try credential("unknown").isSecure)
        XCTAssertFalse(try credential("system", origin: "http://gateway.example.test").isSecure)
        XCTAssertFalse(try credential("system", token: "").isSecure)
    }

    func testStrictNotificationProvisioningRejectsInvalidAuthorityBeforeAnyHTTPRequest() async throws {
        let url = try XCTUnwrap(URL(string: "https://gateway.example.test"))
        let invalidPairs = [
            Pairing(
                url: url,
                token: "device-test-token",
                accountId: "local",
                deviceId: "device-test",
                gatewayName: "Test",
                tlsMode: .pinnedLeafStrict
            ),
            Pairing(
                url: url,
                token: "device-test-token",
                accountId: "local",
                deviceId: "device-test",
                gatewayName: "Test",
                fingerprint: "short",
                tlsMode: .pinnedLeafStrict
            ),
            Pairing(
                url: url,
                token: "device-test-token",
                accountId: "local",
                deviceId: "device-test",
                gatewayName: "Test",
                fingerprint: String(repeating: "z", count: 64),
                tlsMode: .pinnedLeafStrict
            ),
        ]
        for pairing in invalidPairs {
            let store = InMemoryStore()
            let provisioner = NotificationClaimCredentialProvisioner(pairing: pairing, store: store) { _ in
                XCTFail("Invalid strict authority attempted token minting")
                throw URLError(.badServerResponse)
            }
            do { try await provisioner.ensure()
                XCTFail("Invalid strict pin accepted")
            } catch { XCTAssertEqual(error as? NotificationClaimCredentialError, .insecurePairing) }
            XCTAssertNil(try NotificationClaimCredentials.stored(keychain: store))
        }
    }

    private func credential(
        _ mode: String,
        key: String? = nil,
        leaf: String? = nil,
        origin: String = "https://gateway.example.test",
        token: String = "widget-test-token",
        hints: [GatewayDirectCandidate]? = nil
    ) throws
        -> TaskWidgetCredential {
        try TaskWidgetCredential(
            url: XCTUnwrap(URL(string: origin)),
            token: token,
            deviceId: "widget-device",
            tlsMode: mode,
            fingerprint: leaf,
            spkiFingerprint: key,
            directCandidates: hints
        )
    }
}
