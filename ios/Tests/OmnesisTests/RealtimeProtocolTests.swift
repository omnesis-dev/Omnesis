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

    func testMalformedServerMessageIsIgnored() {
        XCTAssertNil(RealtimeProtocol.event(Data("not JSON".utf8)))
        XCTAssertNil(RealtimeProtocol.event(Data("[]".utf8)))
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

    func testCapabilityUsesAuthenticatedGatewayRequest() async throws {
        let session = Session(body: "{\"available\":true}")
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

    func testDisabledCapabilityHidesVoice() async throws {
        let available = try await RealtimeCapability.available(pairing: pairing, session: Session(body: "{\"available\":false}"))
        XCTAssertFalse(available)
    }

    func testMalformedCapabilityCannotEnableVoice() async throws {
        do {
            _ = try await RealtimeCapability.available(pairing: pairing, session: Session(body: "{}"))
            XCTFail("Missing availability must not enable voice")
        } catch is DecodingError {}
    }
}
