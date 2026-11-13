// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class AccountPasskeyAssertionTests: XCTestCase {
    func testAssertionUsesStandardUnpaddedBase64URLFields() throws {
        let value = AccountPasskeyAssertion(
            credentialId: Data([255, 254]),
            clientData: Data("client-data".utf8),
            authenticatorData: Data([1, 2, 3]),
            signature: Data([4, 5]),
            userId: Data([6])
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: value.encoded()) as? [String: Any])
        XCTAssertEqual(json["id"] as? String, "__4")
        XCTAssertEqual(json["rawId"] as? String, json["id"] as? String)
        XCTAssertEqual(json["type"] as? String, "public-key")
        XCTAssertEqual((json["clientExtensionResults"] as? [String: String])?.count, 0)
        let response = try XCTUnwrap(json["response"] as? [String: String])
        XCTAssertEqual(response["authenticatorData"], "AQID")
        XCTAssertEqual(response["signature"], "BAU")
        XCTAssertEqual(response["userHandle"], "Bg")
        XCTAssertTrue(response.values.allSatisfy { !$0.contains("=") })
    }

    func testMalformedAndOversizedAssertionFieldsFailBeforeEncoding() {
        for index in 0 ..< 5 {
            for oversized in [false, true] {
                var fields = [Data([1]), Data([2]), Data([3]), Data([4]), Data([5])]
                fields[index] = oversized ? Data(repeating: 1, count: [1025, 16385, 16385, 1025, 65][index]) : Data()
                XCTAssertThrowsError(try AccountPasskeyAssertion(
                    credentialId: fields[0],
                    clientData: fields[1],
                    authenticatorData: fields[2],
                    signature: fields[3],
                    userId: fields[4]
                ).encoded())
            }
        }
    }

    func testChallengeRequiresTheConfiguredRelyingPartyAndUserVerification() throws {
        let valid = AccountPasskeyChallenge(
            rpId: "relay.example.test",
            challenge: String(repeating: "a", count: 43),
            userVerification: "required"
        )
        XCTAssertEqual(try valid.validated(expectedRpId: "relay.example.test").count, 32)
        XCTAssertThrowsError(try valid.validated(expectedRpId: "foreign.example.test"))
        for challenge in ["", "short", String(repeating: "!", count: 43)] {
            XCTAssertThrowsError(try AccountPasskeyChallenge(
                rpId: "relay.example.test",
                challenge: challenge,
                userVerification: "required"
            ).validated(expectedRpId: "relay.example.test"))
        }
        XCTAssertThrowsError(try AccountPasskeyChallenge(
            rpId: "relay.example.test",
            challenge: valid.challenge,
            userVerification: "preferred"
        ).validated(expectedRpId: "relay.example.test"))
    }
}
