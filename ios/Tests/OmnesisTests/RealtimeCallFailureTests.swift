// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class RealtimeCallFailureTests: XCTestCase {
    func testCreditExhaustionIsActionableWithoutProviderText() throws {
        let failure = RealtimeCallFailure.server(["error": [
            "code": "quota_exhausted",
            "message": "private request contents",
            "retryable": false,
            "fatal": true,
        ]])
        XCTAssertEqual(failure.title, "OpenAI credit or quota limit")
        XCTAssertTrue(try XCTUnwrap(failure.errorDescription?.contains("billing")))
        XCTAssertFalse(try XCTUnwrap(failure.errorDescription?.contains("private request")))
        XCTAssertTrue(failure.fatal)
        XCTAssertFalse(failure.retryable)
    }

    func testLegacyMessageOnlyDefaultsFatalAndDoesNotExposeContents() throws {
        let known = RealtimeCallFailure.server(["error": ["message": "Your credit balance is too low"]])
        XCTAssertEqual(known.code, "quota_exhausted")
        XCTAssertTrue(known.fatal)
        let unknown = RealtimeCallFailure.server(["error": ["message": "secret@example.com"]])
        XCTAssertFalse(try XCTUnwrap(unknown.errorDescription?.contains("secret")))
        XCTAssertTrue(unknown.fatal)
    }

    func testRecoverableFutureErrorsRemainSafeAndNonfatal() throws {
        let failure = RealtimeCallFailure.server(["error": ["code": "future_error", "message": "unsafe contents", "fatal": false]])
        XCTAssertFalse(failure.fatal)
        XCTAssertEqual(failure.title, "Reply interrupted")
        XCTAssertFalse(try XCTUnwrap(failure.errorDescription?.contains("unsafe")))
    }

    func testUpgradeRejectionAndTypedFailurePrecedence() {
        for (status, code) in [
            (400, "protocol_error"),
            (401, "pairing_rejected"),
            (403, "pairing_rejected"),
            (404, "unavailable"),
            (429, "rate_limited"),
            (503, "connection_error"),
        ] {
            XCTAssertEqual(RealtimeCallFailure.local(URLError(.badServerResponse), httpStatus: status).code, code)
        }
        let typed = RealtimeCallFailure(code: "quota_exhausted", fatal: true, retryable: false)
        XCTAssertEqual(RealtimeCallFailure.local(typed, httpStatus: 503), typed)
    }

    func testLocalFailuresHaveSpecificRecovery() {
        XCTAssertEqual(RealtimeCallFailure.local(URLError(.timedOut)).code, "timeout")
        XCTAssertEqual(RealtimeCallFailure.local(URLError(.serverCertificateUntrusted)).code, "certificate_error")
        XCTAssertEqual(RealtimeCallFailure.local(NSError(domain: "RealtimeCall", code: 4)).code, "microphone_failed")
        XCTAssertEqual(RealtimeCallFailure.local(NSError(domain: "RealtimeCall", code: 6)).code, "protocol_error")
    }

    func testSharedConversationHandoffErrorsKeepTheirRecovery() throws {
        XCTAssertEqual(RealtimeCallFailure.local(GatewayClient.Error.forbidden).code, "pairing_rejected")
        XCTAssertEqual(RealtimeCallFailure.local(GatewayClient.Error.notFound).code, "session_not_found")
        XCTAssertEqual(RealtimeCallFailure.local(GatewayClient.Error.serverError(status: 409, body: "private")).code, "session_busy")
        let failure = RealtimeCallFailure.local(GatewayClient.Error.serverError(status: 500, body: "private"))
        XCTAssertFalse(try XCTUnwrap(failure.errorDescription?.contains("private")))
    }

    func testKnownBillingLimitsRetainDistinctActions() throws {
        for (code, action) in [
            ("credit_balance_exhausted", "Add credit"),
            ("project_spend_limit_exceeded", "project's limit"),
            ("organization_spend_limit_exceeded", "organization's billing"),
            ("organization_usage_limit_exceeded", "usage allowance"),
        ] {
            let failure = RealtimeCallFailure.server(["error": ["code": code]])
            XCTAssertEqual(failure.code, code)
            XCTAssertTrue(try XCTUnwrap(failure.errorDescription?.contains(action)))
        }
    }
}
