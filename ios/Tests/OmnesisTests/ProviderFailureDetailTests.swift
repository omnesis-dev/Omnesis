// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The machine-readable half of a model failure, end to end on the client:
/// the shared provider-disposition formatter, the decoding of the two optional
/// wire fields that carry it (`agent.error`'s `provider`, the privacy
/// exchange's `failure.detail`), and the per-surface lines composed from them.
///
/// Every field here is invented. All pure, so it runs in the sim-less logic
/// lane.
@available(iOS 17.0, *)
final class ProviderFailureDetailTests: XCTestCase {
    // MARK: - Formatter

    /// The join order and separator are the gateway's, so the same failure
    /// reads identically on every surface that renders it.
    func testFormatsEveryFieldInGatewayOrder() {
        let detail = AgentProviderFailureDetail(
            status: 404,
            type: "invalid_request_error",
            code: "NOT_FOUND",
            param: "model",
            requestId: "req_0a1b2c3d"
        )
        XCTAssertEqual(detail.formatted, "HTTP 404 · NOT_FOUND · param=model · request req_0a1b2c3d")
    }

    /// `code` is the specific one; `type` is the family it belongs to. Showing
    /// both would say the same thing twice at two levels of precision.
    func testCodeWinsOverTypeAndTypeStandsInWhenCodeIsAbsent() {
        XCTAssertEqual(
            AgentProviderFailureDetail(status: 400, type: "invalid_request_error").formatted,
            "HTTP 400 · invalid_request_error"
        )
        XCTAssertEqual(
            AgentProviderFailureDetail(status: 400, type: "invalid_request_error", code: "BAD_MODEL")
                .formatted,
            "HTTP 400 · BAD_MODEL"
        )
    }

    func testOmitsAbsentFields() {
        XCTAssertEqual(AgentProviderFailureDetail(status: 503).formatted, "HTTP 503")
        XCTAssertEqual(AgentProviderFailureDetail(code: "NOT_FOUND").formatted, "NOT_FOUND")
        XCTAssertEqual(AgentProviderFailureDetail(param: "model").formatted, "param=model")
    }

    /// Nothing reported means nothing rendered — a caller must not paint an
    /// empty second line under the failure sentence.
    func testEmptyDetailFormatsToNil() {
        XCTAssertNil(AgentProviderFailureDetail().formatted)
        XCTAssertNil(AgentProviderFailureDetail.format(nil))
        XCTAssertNil(AgentProviderFailureDetail(type: "", code: "", param: "").formatted)
    }

    // MARK: - agent.error decoding

    private func decodeEvent(_ json: String) throws -> AgentEvent {
        try JSONDecoder().decode(AgentEvent.self, from: Data(json.utf8))
    }

    func testErrorEventCarriesProviderDetail() throws {
        let event = try decodeEvent("""
        {"type":"agent.error","payload":{
          "sessionId":"s1","messageId":"m1",
          "code":"http_api_error",
          "message":"The model provider does not have the assigned model.",
          "provider":{"status":404,"type":"invalid_request_error","code":"NOT_FOUND","param":"model"}
        }}
        """)
        guard case .error(let sessionId, _, let code, _, let provider) = event else {
            return XCTFail("expected .error, got \(event)")
        }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(code, "http_api_error")
        XCTAssertEqual(provider?.status, 404)
        XCTAssertEqual(provider?.formatted, "HTTP 404 · NOT_FOUND · param=model")
    }

    /// A gateway that predates the field omits it; the error must still decode.
    func testErrorEventWithoutProviderDecodes() throws {
        let event = try decodeEvent("""
        {"type":"agent.error","payload":{"sessionId":"s1","messageId":null,"code":"cancelled","message":"Cancelled."}}
        """)
        guard case .error(_, let messageId, let code, _, let provider) = event else {
            return XCTFail("expected .error, got \(event)")
        }
        XCTAssertNil(messageId)
        XCTAssertEqual(code, "cancelled")
        XCTAssertNil(provider)
    }

    /// A provider envelope reporting only some of its fields is still worth
    /// keeping — the client renders what arrived.
    func testProviderDetailDecodesPartially() throws {
        let event = try decodeEvent("""
        {"type":"agent.error","payload":{"sessionId":"s1","code":"http_api_error","message":"Gateway timeout.",
          "provider":{"status":504}}}
        """)
        guard case .error(_, _, _, _, let provider) = event else {
            return XCTFail("expected .error, got \(event)")
        }
        XCTAssertEqual(provider?.formatted, "HTTP 504")
        XCTAssertNil(provider?.code)
    }

    /// The terminal message-end failure carries the same structure.
    func testTerminalFailureCarriesProviderDetail() throws {
        let failure = try JSONDecoder().decode(AgentTerminalFailure.self, from: Data("""
        {"code":"http_api_error","message":"No such model.","retryable":false,
         "backend":"openai-compatible","model":"fictional-model",
         "provider":{"status":404,"code":"NOT_FOUND","param":"model"}}
        """.utf8))
        XCTAssertEqual(failure.provider?.formatted, "HTTP 404 · NOT_FOUND · param=model")
    }

    func testTerminalFailureWithoutProviderDecodes() throws {
        let failure = try JSONDecoder().decode(AgentTerminalFailure.self, from: Data("""
        {"code":"output_truncated","message":"Hit the output limit.","retryable":true,
         "backend":"anthropic","model":"fictional-model"}
        """.utf8))
        XCTAssertNil(failure.provider)
        XCTAssertEqual(failure.code, "output_truncated")
    }

    // MARK: - Assistant turn failure line

    func testTurnFailureLineJoinsCodeAndProviderDisposition() {
        let failure = AgentTurnFailure(
            code: "http_api_error",
            message: "The model provider does not have the assigned model.",
            provider: AgentProviderFailureDetail(status: 404, code: "NOT_FOUND", param: "model")
        )
        XCTAssertEqual(failure.detailLine, "http_api_error · HTTP 404 · NOT_FOUND · param=model")
    }

    func testTurnFailureLineIsCodeAloneWithoutProvider() {
        let failure = AgentTurnFailure(code: "backend_unavailable", message: "The stream closed.")
        XCTAssertEqual(failure.detailLine, "backend_unavailable")
    }

    /// Prose with nothing machine-readable behind it renders no quiet line.
    func testTurnFailureLineIsNilWithNeither() {
        XCTAssertNil(AgentTurnFailure(code: nil, message: "Something went wrong.").detailLine)
    }

    // MARK: - Sub-agent card failure line

    func testSubagentCardFailureLine() {
        var card = AgentSubagentCard(
            subagentId: "sess-1.sub.c4",
            specialist: "invoice-sweep",
            title: "Vendor invoice trail",
            task: "Trace the fictional vendor's invoice trail",
            parentToolCallId: "tu_spawn_4",
            status: "failed",
            failureCode: "http_api_error",
            failureProvider: AgentProviderFailureDetail(status: 404, code: "NOT_FOUND", param: "model")
        )
        XCTAssertEqual(card.failureDetailLine, "http_api_error · HTTP 404 · NOT_FOUND · param=model")
        card.failureProvider = nil
        XCTAssertEqual(card.failureDetailLine, "http_api_error")
        card.failureCode = nil
        XCTAssertNil(card.failureDetailLine)
    }

    // MARK: - Privacy exchange failure detail

    private func decodeExchange(_ failureJSON: String) throws -> PrivacyExchangePresentation {
        try JSONDecoder().decode(PrivacyExchangePresentation.self, from: Data("""
        {"taskId":"t1","conversationId":"c1","workflowId":"w1",
         "question":"Which fictional route is shortest?",
         "status":"failed","outcome":"failed","createdAt":1782000030000,
         "failure":\(failureJSON)}
        """.utf8))
    }

    func testPrivacyFailureDetailDecodesAndComposesLine() throws {
        let exchange = try decodeExchange("""
        {"code":"http_api_error","message":"The provider does not have the assigned model.",
         "stage":"answer_generation","detail":"HTTP 404 · NOT_FOUND · param=model"}
        """)
        XCTAssertEqual(exchange.failure?.detail, "HTTP 404 · NOT_FOUND · param=model")
        XCTAssertEqual(
            privacyFailureDetailLine(exchange),
            "http_api_error · HTTP 404 · NOT_FOUND · param=model"
        )
    }

    /// An older gateway omits `detail` entirely; the failure must still decode
    /// and the line falls back to the code alone.
    func testPrivacyFailureWithoutDetailDecodes() throws {
        let exchange = try decodeExchange("""
        {"code":"agent_unavailable","message":"The answer could not be drafted.","stage":"answer_generation"}
        """)
        XCTAssertNil(exchange.failure?.detail)
        XCTAssertEqual(privacyFailureDetailLine(exchange), "agent_unavailable")
    }

    /// An optional field arriving with the wrong JSON type costs that field,
    /// never the failure the client already understands.
    func testPrivacyFailureToleratesMisshapenOptionalFields() throws {
        let exchange = try decodeExchange("""
        {"code":"http_api_error","message":"The provider rejected the request.","stage":42,"detail":[1,2]}
        """)
        XCTAssertEqual(exchange.failure?.code, "http_api_error")
        XCTAssertNil(exchange.failure?.stage)
        XCTAssertNil(exchange.failure?.detail)
        XCTAssertEqual(privacyFailureDetailLine(exchange), "http_api_error")
    }

    func testPrivacyFailureDetailLineIsNilWithoutAFailure() throws {
        let exchange = try JSONDecoder().decode(PrivacyExchangePresentation.self, from: Data("""
        {"taskId":"t1","conversationId":"c1","workflowId":"w1","question":"q",
         "status":"failed","outcome":"failed","createdAt":1782000030000}
        """.utf8))
        XCTAssertNil(privacyFailureDetailLine(exchange))
    }

    // MARK: - Spoken failure

    /// Siri speaks the condition the gateway named, as one sentence. The code
    /// and the provider disposition never reach the utterance — they are for
    /// eyes, not ears.
    func testSpokenFailureSpeaksTheNamedCondition() {
        let spoken = SiriAskDialog.text(
            for: .failed(
                reason: "The model provider does not have the assigned model — check the model assignment (HTTP 404)."
            )
        )
        XCTAssertEqual(
            spoken,
            "Sorry — The model provider does not have the assigned model — check the model assignment (HTTP 404)."
        )
        XCTAssertFalse(spoken.contains("http_api_error"))
        XCTAssertFalse(spoken.contains("NOT_FOUND"))
    }

    func testSpokenFailureAddsAFullStopWhenTheMessageLacksOne() {
        XCTAssertEqual(
            SiriAskDialog.text(for: .failed(reason: "The model backend closed the stream")),
            "Sorry — The model backend closed the stream."
        )
    }

    func testSpokenFailureFallsBackWhenNothingNamedTheCondition() {
        XCTAssertEqual(
            SiriAskDialog.text(for: .failed(reason: nil)),
            SiriAskDialog.unexplainedFailure
        )
        XCTAssertEqual(
            SiriAskDialog.text(for: .failed(reason: "   ")),
            SiriAskDialog.unexplainedFailure
        )
    }

    /// A paragraph is not a sentence; speech has no way to skim one.
    func testSpokenFailureFallsBackOnAWallOfText() {
        let wall = String(repeating: "the request was rejected ", count: 20)
        XCTAssertEqual(
            SiriAskDialog.text(for: .failed(reason: wall)),
            SiriAskDialog.unexplainedFailure
        )
    }

    /// A multi-line message speaks its first line only, so a stack trace
    /// appended below a perfectly good sentence costs nothing.
    func testSpokenFailureUsesTheFirstLineOnly() {
        XCTAssertEqual(
            SiriAskDialog.text(for: .failed(reason: "The gateway timed out.\nat Backend.send (line 12)")),
            "Sorry — The gateway timed out."
        )
    }

    /// The reason survives the WatchConnectivity hop, so a watch ask fails
    /// with the same sentence the phone would have spoken.
    func testFailureReasonRoundTripsOverTheWatchRelay() {
        let reply = SiriAskWire.reply(for: .failed(reason: "The gateway timed out."))
        XCTAssertEqual(SiriAskWire.outcome(from: reply), .failed(reason: "The gateway timed out."))

        let bare = SiriAskWire.reply(for: .failed(reason: nil))
        XCTAssertEqual(SiriAskWire.outcome(from: bare), .failed(reason: nil))
    }
}
