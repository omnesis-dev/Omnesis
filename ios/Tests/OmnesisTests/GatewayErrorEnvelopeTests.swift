// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The gateway's `{error, code, detail?}` envelope: read off a
/// `GatewayClient.Error.serverError` body by the `gatewayCode` /
/// `gatewayMessage` accessors, and unwrapped to prose by
/// `GatewayClient.errorMessage(from:)` for the surfaces that render it.
final class GatewayErrorEnvelopeTests: XCTestCase {
    private func message(_ json: String) -> String {
        GatewayClient.errorMessage(from: Data(json.utf8))
    }

    func testParsesCodeAndMessage() {
        let error = GatewayClient.Error.serverError(
            status: 409,
            body: #"{"error":"device \"Old phone\" still hosts 1 source(s)","code":"DEVICE_STILL_HOSTS_SOURCES","sources":["x:y"]}"#
        )
        XCTAssertEqual(error.gatewayCode, "DEVICE_STILL_HOSTS_SOURCES")
        XCTAssertEqual(error.gatewayMessage, "device \"Old phone\" still hosts 1 source(s)")
    }

    func testEnvelopeWithoutACodeStillYieldsTheMessage() {
        let error = GatewayClient.Error.serverError(status: 500, body: #"{"error":"writer busy"}"#)
        XCTAssertNil(error.gatewayCode)
        XCTAssertEqual(error.gatewayMessage, "writer busy")
    }

    func testNonEnvelopeBodyYieldsNothing() {
        let error = GatewayClient.Error.serverError(status: 502, body: "<html>Bad Gateway</html>")
        XCTAssertNil(error.gatewayCode)
        XCTAssertNil(error.gatewayMessage)
        XCTAssertNil(GatewayErrorEnvelope.parse(""))
    }

    func testOtherErrorCasesCarryNoEnvelope() {
        XCTAssertNil(GatewayClient.Error.notFound.gatewayCode)
        XCTAssertNil(GatewayClient.Error.unauthorized.gatewayMessage)
    }

    // MARK: - errorMessage(from:) — what a rendering surface shows

    func testUnwrapsTheMessageFromTheEnvelope() {
        XCTAssertEqual(
            message(#"{"error":"Anthropic API key not configured.","code":"SERVICE_UNAVAILABLE"}"#),
            "Anthropic API key not configured."
        )
    }

    /// The shape that reached a user: an unreachable chat backend, reported
    /// with an embedded quoted backend name, so the JSON escaping is part of
    /// what the naive rendering showed them.
    func testUnwrapsAMessageContainingEscapedQuotes() {
        XCTAssertEqual(
            message(
                #"{"error":"Backend \"fireworks\" is unreachable: The operation was aborted"#
                    + #" due to timeout","code":"SERVICE_UNAVAILABLE"}"#
            ),
            #"Backend "fireworks" is unreachable: The operation was aborted due to timeout"#
        )
    }

    func testKeepsExtraEnvelopeFieldsOutOfTheMessage() {
        XCTAssertEqual(
            message(#"{"error":"Nope.","code":"BAD_REQUEST","detail":{"field":"limit"}}"#),
            "Nope."
        )
    }

    /// Not everything that fails is the gateway — a reverse proxy or a
    /// truncated response can answer with something else entirely. Those pass
    /// through unchanged: no worse than before, and never mistaken for a
    /// curated message.
    func testPassesThroughABodyThatIsNotTheEnvelope() {
        XCTAssertEqual(message("<html>502 Bad Gateway</html>"), "<html>502 Bad Gateway</html>")
        XCTAssertEqual(message(""), "")
        XCTAssertEqual(message(#"{"code":"NO_MESSAGE"}"#), #"{"code":"NO_MESSAGE"}"#)
        XCTAssertEqual(message(#"{"error":"","code":"EMPTY"}"#), #"{"error":"","code":"EMPTY"}"#)
    }

    /// The `String` overload takes the shape a thrown `serverError` carries.
    func testTheStringOverloadUnwrapsTheSameWay() {
        XCTAssertEqual(
            GatewayClient.errorMessage(from: #"{"error":"writer busy","code":"BUSY"}"#),
            "writer busy"
        )
        XCTAssertEqual(GatewayClient.errorMessage(from: "plain"), "plain")
    }
}
