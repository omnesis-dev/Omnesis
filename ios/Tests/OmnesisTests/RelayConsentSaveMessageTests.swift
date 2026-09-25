// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@available(iOS 17.0, macOS 14.0, *)
final class RelayConsentSaveMessageTests: XCTestCase {
    private func envelope(reason: String?) -> String {
        if let reason {
            return "{\"error\":\"refused\",\"code\":\"BAD_REQUEST\",\"detail\":{\"reason\":\"\(reason)\"}}"
        }
        return "{\"error\":\"refused\",\"code\":\"BAD_REQUEST\"}"
    }

    func testRefusalReasonReadsCodedEnvelopes() {
        XCTAssertEqual(
            RelayConsentSaveMessage.refusalReason(in: envelope(reason: "identity-mismatch")),
            "identity-mismatch"
        )
    }

    func testRefusalReasonFallsBackOnOlderGateways() {
        XCTAssertNil(RelayConsentSaveMessage.refusalReason(in: envelope(reason: nil)))
        XCTAssertNil(RelayConsentSaveMessage.refusalReason(in: "not json"))
        XCTAssertNil(RelayConsentSaveMessage.refusalReason(in: "{\"detail\":{}}"))
        XCTAssertNil(RelayConsentSaveMessage.refusalReason(in: ""))
    }

    func testTransportFailuresKeepTheConnectionMessage() {
        XCTAssertEqual(
            RelayConsentSaveMessage.message(for: URLError(.notConnectedToInternet)),
            RelayConsentSaveMessage.connectionIssue
        )
        XCTAssertEqual(
            RelayConsentSaveMessage.message(
                for: PushRegistrationError.unavailable(reasonCode: nil, reason: "down")
            ),
            RelayConsentSaveMessage.connectionIssue
        )
    }

    func testIdentityMismatchSuggestsRepairing() {
        let message = RelayConsentSaveMessage.message(
            for: PushRegistrationError.serverError(status: 400, body: envelope(reason: "identity-mismatch"))
        )
        XCTAssertTrue(message.contains("pair it again"))
        XCTAssertFalse(message.contains("Check the connection"))
    }

    func testRevokedOrUnknownPhonesSuggestRepairing() {
        for status in [403, 404] {
            let message = RelayConsentSaveMessage.message(
                for: PushRegistrationError.serverError(status: status, body: envelope(reason: nil))
            )
            XCTAssertTrue(message.contains("pair it again"), "status \(status)")
        }
    }

    func testOtherRefusalsNameTheStatusInsteadOfBlamingTheConnection() {
        let refused = RelayConsentSaveMessage.message(
            for: PushRegistrationError.serverError(status: 400, body: envelope(reason: nil))
        )
        XCTAssertTrue(refused.contains("error 400"))
        XCTAssertFalse(refused.contains("Check the connection"))

        let failed = RelayConsentSaveMessage.message(
            for: PushRegistrationError.serverError(status: 500, body: "")
        )
        XCTAssertTrue(failed.contains("Try again in a moment"))
    }

    func testChangedPairingSaysSo() {
        XCTAssertTrue(
            RelayConsentSaveMessage.message(for: PushRegistrationError.invalidResponse)
                .contains("Pairing changed")
        )
    }

    func testRetryPolicyCoversBothResponseOrderings() {
        // Race shapes retry regardless of hello state — the wait that
        // follows confirms it either way, so the 400 arriving before or
        // after the hello ack both get exactly one replay.
        XCTAssertTrue(RelayConsentRetryPolicy.shouldRetry(status: 400, body: envelope(reason: nil)))
        XCTAssertTrue(
            RelayConsentRetryPolicy.shouldRetry(status: 400, body: envelope(reason: "identity-mismatch"))
        )
    }

    func testRetryPolicySkipsDeterministicRefusals() {
        XCTAssertFalse(
            RelayConsentRetryPolicy.shouldRetry(status: 400, body: envelope(reason: "direct-coverage"))
        )
        XCTAssertFalse(
            RelayConsentRetryPolicy.shouldRetry(status: 400, body: envelope(reason: "unpublished-app"))
        )
        XCTAssertFalse(
            RelayConsentRetryPolicy.shouldRetry(status: 403, body: envelope(reason: nil))
        )
        XCTAssertFalse(
            RelayConsentRetryPolicy.shouldRetry(status: 404, body: envelope(reason: nil))
        )
        XCTAssertFalse(RelayConsentRetryPolicy.shouldRetry(status: 500, body: ""))
    }

    func testUnclassifiableFailuresKeepTheConnectionMessage() {
        struct Unexpected: Error {}
        XCTAssertEqual(
            RelayConsentSaveMessage.message(for: Unexpected()),
            RelayConsentSaveMessage.connectionIssue
        )
        XCTAssertEqual(
            RelayConsentSaveMessage.message(for: PushRegistrationError.invalidURL),
            RelayConsentSaveMessage.connectionIssue
        )
    }
}
