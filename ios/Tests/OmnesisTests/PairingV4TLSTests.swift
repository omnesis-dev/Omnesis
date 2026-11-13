// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class PairingV4TLSTests: XCTestCase {
    func testAllExplicitTrustModesRoundTripWithoutReinterpretingKeyAndLeafPins() throws {
        let digest = String(repeating: "ab", count: 32)
        let modes: [(PairingV4TLS, String)] = [
            (.system, "system"),
            (.pinnedLeaf(fingerprint: digest), "pinned-leaf"),
            (.pinnedLeafStrict(fingerprint: digest), "pinned-leaf-strict"),
            (.pinnedKeyStrict(spkiFingerprint: digest), "pinned-key-strict"),
        ]
        for (trust, name) in modes {
            let payload = PairingPayload.V4(gatewayUrl: "https://gateway.example.test", pairingCode: "TEST-CODE", tls: trust)
            let data = try JSONEncoder().encode(payload)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let tls = try XCTUnwrap(object["tls"] as? [String: String])
            XCTAssertEqual(tls["mode"], name)
            let field = name == "pinned-key-strict" ? "spkiFingerprint" : "fingerprint"
            XCTAssertEqual(Set(tls.keys), name == "system" ? ["mode"] : ["mode", field])
            if name != "system" { XCTAssertEqual(tls[field], digest) }
            let decoded = try PairingPayload.decode(from: XCTUnwrap(String(data: data, encoding: .utf8)), cloudRelayEnabled: true)
            XCTAssertEqual(decoded, .v4(payload))
        }
    }

    func testEmptyRequiredFieldsFailBeforeAnyPairingExchange() throws {
        let templates: [(String, String)] = [
            (#"""
            {"v":4,
            "gatewayUrl":"",
            "pairingCode":"CODE",
            "tls":{"mode":"system"}}
            """#, "gatewayUrl"),
            (#"""
            {"v":4,
            "gatewayUrl":"https://gateway.example.test",
            "pairingCode":"",
            "tls":{"mode":"system"}}
            """#, "pairingCode"),
            (#"""
            {"v":4,
            "gatewayUrl":"https://gateway.example.test",
            "pairingCode":"CODE",
            "tls":{"mode":"pinned-key-strict",
            "spkiFingerprint":""}}
            """#, "tls.spkiFingerprint"),
            (#"""
            {"v":4,
            "gatewayUrl":"https://gateway.example.test",
            "pairingCode":"CODE",
            "tls":{"mode":"pinned-leaf-strict",
            "fingerprint":""}}
            """#, "tls.fingerprint"),
        ]
        for (raw, field) in templates {
            XCTAssertThrowsError(try PairingPayload.decode(from: raw, cloudRelayEnabled: true)) {
                XCTAssertEqual($0 as? PairingPayloadError, .missingField(field))
            }
        }
    }
}
