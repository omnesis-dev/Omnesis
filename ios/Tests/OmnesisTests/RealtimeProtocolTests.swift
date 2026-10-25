// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class RealtimeProtocolTests: XCTestCase {
    func testWebsocketUsesGatewayHostAndRealtimePath() throws {
        let base = try XCTUnwrap(URL(string: "https://gateway.example.com:7443"))
        let url = try XCTUnwrap(RealtimeProtocol.socketURL(base, conversationID: "chat/example", timeZone: "Europe/Paris"))
        let parts = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(parts.scheme, "wss")
        XCTAssertEqual(parts.host, "gateway.example.com")
        XCTAssertEqual(parts.port, 7443)
        XCTAssertEqual(parts.path, "/agent/realtime/ws")
        XCTAssertEqual(parts.queryItems?.first { $0.name == "conversationId" }?.value, "chat/example")
        XCTAssertEqual(parts.queryItems?.first { $0.name == "timeZone" }?.value, "Europe/Paris")
    }

    func testUnencryptedGatewayIsRefused() throws {
        XCTAssertNil(try RealtimeProtocol.socketURL(XCTUnwrap(URL(string: "http://gateway.example.com"))))
    }

    func testUnsupportedSchemeIsRefused() throws {
        XCTAssertNil(try RealtimeProtocol.socketURL(XCTUnwrap(URL(string: "file:///tmp/example"))))
    }

    func testAudioFramePreservesPCMBytes() {
        let pcm = Data([0, 0, 255, 127, 0, 128])
        let event = RealtimeProtocol.audioAppend(pcm)
        XCTAssertEqual(event["type"], "input_audio_buffer.append")
        XCTAssertEqual(event["audio"].flatMap { Data(base64Encoded: $0) }, pcm)
    }

    func testRecoverableErrorsAreExplicitlyOptedInForOlderClientCompatibility() throws {
        let pairing = try Pairing(
            url: XCTUnwrap(URL(string: "https://gateway.example.com")),
            token: "test-token",
            accountId: "test-account",
            deviceId: "test-device",
            gatewayName: "Example gateway"
        )
        let request = try XCTUnwrap(RealtimeProtocol.socketRequest(pairing: pairing))
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Omnesis-Realtime-Recoverable-Errors"), "1")
    }

    func testMalformedServerMessageIsIgnored() {
        XCTAssertNil(RealtimeProtocol.event(Data("not JSON".utf8)))
        XCTAssertNil(RealtimeProtocol.event(Data("[]".utf8)))
    }

    func testReadyMustConfirmNegotiatedVersionBeforeConversationOrCaptureStarts() throws {
        XCTAssertNoThrow(try RealtimeProtocol.validateReady(["protocolVersion": 2, "futureField": true]))
        let invalid: [[String: Any]] = [[:], ["protocolVersion": 1], ["protocolVersion": 3], ["protocolVersion": "2"]]
        for event in invalid {
            XCTAssertThrowsError(try RealtimeProtocol.validateReady(event))
        }
    }
}

final class RealtimeCapabilityTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        let status: Int
        let body: String
        var request: URLRequest?
        init(status: Int = 200, body: String) {
            self.status = status
            self.body = body
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            self.request = request
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }

    private var pairing: Pairing {
        Pairing(
            url: URL(string: "https://gateway.example.com")!,
            token: "test-token",
            accountId: "test-account",
            deviceId: "test-device",
            gatewayName: "Example gateway"
        )
    }

    func testAudioSocketRequestsCanonicalSSEWithoutLegacyToolMirroring() throws {
        let request = try XCTUnwrap(RealtimeProtocol.socketRequest(pairing: pairing, conversationID: "same-thread"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Omnesis-Realtime-Version"), "2")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Omnesis-Realtime-Events"))
        let url = try XCTUnwrap(request.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.queryItems?.first(where: { $0.name == "conversationId" })?.value, "same-thread")
    }

    func testCapabilityUsesAuthenticatedGatewayRequest() async throws {
        let session = Session(body: """
        {"available":true,"directAgentTools":true,"canonicalAgentEvents":true,"protocol":{"min":1,"max":2},"futureField":42}
        """)
        let available = try await RealtimeCapability.available(pairing: pairing, session: session)
        XCTAssertTrue(available)
        XCTAssertEqual(session.request?.url?.path, "/agent/realtime")
        XCTAssertEqual(session.request?.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
    }

    func testOlderGatewayWithoutCapabilityHidesVoice() async throws {
        let session = Session(status: 404, body: "Not found")
        let available = try await RealtimeCapability.available(pairing: pairing, session: session)
        XCTAssertFalse(available)
    }

    func testLegacyAudioCapabilityCannotEnableCanonicalVoice() async throws {
        for body in [
            "{\"available\":true}",
            "{\"available\":true,\"directAgentTools\":true}",
            "{\"available\":true,\"canonicalAgentEvents\":true}",
            "{\"available\":true,\"directAgentTools\":false,\"canonicalAgentEvents\":true}",
        ] {
            let withProtocol = String(body.dropLast()) + ",\"protocol\":{\"min\":1,\"max\":2}}"
            let available = try await RealtimeCapability.available(pairing: pairing, session: Session(body: withProtocol))
            XCTAssertFalse(available)
        }
    }

    func testDisabledCapabilityHidesVoice() async throws {
        let body = "{\"available\":false,\"directAgentTools\":true,\"canonicalAgentEvents\":true,\"protocol\":{\"min\":1,\"max\":2}}"
        let available = try await RealtimeCapability.available(pairing: pairing, session: Session(body: body))
        XCTAssertFalse(available)
    }

    func testMalformedCapabilityCannotEnableVoice() async throws {
        let available = try await RealtimeCapability.available(pairing: pairing, session: Session(body: "{}"))
        XCTAssertFalse(available)
    }

    func testGatewayWithoutMediaProtocolRangeKeepsVoiceHidden() async throws {
        let body = "{\"available\":true,\"directAgentTools\":true,\"canonicalAgentEvents\":true}"
        let available = try await RealtimeCapability.available(pairing: pairing, session: Session(body: body))
        XCTAssertFalse(available)
    }

    func testOnlyOverlappingMediaProtocolRangesEnableVoice() async throws {
        for (range, expected) in [
            ("{\"min\":1,\"max\":2}", true),
            ("{\"min\":2,\"max\":3}", true),
            ("{\"min\":1,\"max\":1}", false),
            ("{\"min\":3,\"max\":4}", false),
            ("{\"min\":3,\"max\":2}", false),
            ("{\"min\":0,\"max\":2}", false),
            ("{\"min\":2}", false),
            ("{\"min\":\"2\",\"max\":3}", false),
            ("null", false),
        ] {
            let body = "{\"available\":true,\"directAgentTools\":true,\"canonicalAgentEvents\":true,\"protocol\":\(range)}"
            let available = try await RealtimeCapability.available(pairing: pairing, session: Session(body: body))
            XCTAssertEqual(available, expected, range)
        }
    }
}
