// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Wire-shape coverage for the Siri-ask additions to `AgentClient`:
/// the `profile` / `resumeFromId` keys on the session-create body, the
/// `notifyAfterMs` key on the `/messages` body, and the optional
/// `conversationId` on the session-create response.
final class SiriAskWireTests: XCTestCase {
    private func decodeBody(_ body: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    func testCreateSessionBodyCarriesBothKeys() throws {
        let body = try AgentClient.createSessionBody(
            profile: "voice",
            resumeFromId: "conv-1",
            timeZone: "Asia/Tokyo",
            encoder: JSONEncoder()
        )
        let json = try decodeBody(body)
        XCTAssertEqual(json["profile"] as? String, "voice")
        XCTAssertEqual(json["resumeFromId"] as? String, "conv-1")
        XCTAssertEqual(json["timeZone"] as? String, "Asia/Tokyo")
        XCTAssertEqual(json.count, 3)
    }

    func testCreateSessionBodyProfileOnly() throws {
        let body = try AgentClient.createSessionBody(
            profile: "voice",
            resumeFromId: nil,
            timeZone: nil,
            encoder: JSONEncoder()
        )
        let json = try decodeBody(body)
        XCTAssertEqual(json["profile"] as? String, "voice")
        XCTAssertNil(json["resumeFromId"])
        XCTAssertNil(json["timeZone"])
        XCTAssertEqual(json.count, 1)
    }

    func testCreateSessionBodyResumeOnly() throws {
        let body = try AgentClient.createSessionBody(
            profile: nil,
            resumeFromId: "conv-1",
            timeZone: nil,
            encoder: JSONEncoder()
        )
        let json = try decodeBody(body)
        XCTAssertNil(json["profile"])
        XCTAssertEqual(json["resumeFromId"] as? String, "conv-1")
        XCTAssertEqual(json.count, 1)
    }

    /// A resumed ask takes the session and none of its transcript.
    /// Uncapped, the resume returns the thread's entire history — every
    /// tool result of every prior turn — which the ask spends its answer
    /// budget downloading and then never reads.
    func testResumedAskAsksForNoTranscript() {
        XCTAssertEqual(
            AgentClient.createSessionPath(transcriptLimit: SiriAskRunner.resumeTranscriptLimit),
            "/agent/sessions?transcriptLimit=0"
        )
    }

    /// A fresh session has no transcript to cap, so it sends the bare path
    /// — byte-identical to a build that predates the knob.
    func testFreshSessionPathCarriesNoQuery() {
        XCTAssertEqual(AgentClient.createSessionPath(transcriptLimit: nil), "/agent/sessions")
    }

    /// Every optional key is dropped when nil, so a body with none of them
    /// set encodes as an empty object.
    func testCreateSessionBodyEmptyWhenAllNil() throws {
        let body = try AgentClient.createSessionBody(
            profile: nil,
            resumeFromId: nil,
            timeZone: nil,
            encoder: JSONEncoder()
        )
        XCTAssertEqual(String(bytes: body, encoding: .utf8), "{}")
    }

    /// A plain new conversation still carries the device's zone — that is the
    /// whole point of the field, and the ordinary chat path is where a
    /// mis-rendered wall-clock time actually reaches the user.
    func testCreateSessionBodyCarriesTimeZoneAlone() throws {
        let body = try AgentClient.createSessionBody(
            profile: nil,
            resumeFromId: nil,
            timeZone: "Europe/London",
            encoder: JSONEncoder()
        )
        let json = try decodeBody(body)
        XCTAssertEqual(json["timeZone"] as? String, "Europe/London")
        XCTAssertEqual(json.count, 1)
    }

    /// The device's own zone must be what actually ships — encoding a zone
    /// correctly is worth nothing if `createSession` never reads one. Drives the
    /// real client through a stub `URLProtocol` and inspects the body it sent.
    func testCreateSessionSendsTheDeviceTimeZone() async throws {
        StubSessionCreateProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubSessionCreateProtocol.self]
        let client = try AgentClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")),
            token: "t",
            session: URLSession(configuration: config)
        )

        _ = try await client.createSession()

        let body = try XCTUnwrap(StubSessionCreateProtocol.lastBody)
        let json = try decodeBody(body)
        XCTAssertEqual(json["timeZone"] as? String, TimeZone.current.identifier)
    }

    func testSendBodyCarriesNotifyAfterMs() throws {
        let body = try AgentClient.sendMessageBody(
            text: "what's on my calendar tomorrow",
            deepResearch: false,
            notifyAfterMs: 20000,
            encoder: JSONEncoder()
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["text"] as? String, "what's on my calendar tomorrow")
        XCTAssertEqual(json["notifyAfterMs"] as? Int, 20000)
        XCTAssertNil(json["deepResearch"])
    }

    func testDefaultSendOmitsNotifyAfterMs() throws {
        let body = try AgentClient.sendMessageBody(
            text: "hello",
            deepResearch: false,
            encoder: JSONEncoder()
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertNil(json["notifyAfterMs"])
        XCTAssertNil(json["viewingForMs"])
    }

    func testSendBodyCarriesBoundedViewingWindow() throws {
        let body = try AgentClient.sendMessageBody(
            text: "what changed since yesterday",
            deepResearch: false,
            viewingForMs: 55000,
            encoder: JSONEncoder()
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["viewingForMs"] as? Int, 55000)
        XCTAssertNil(json["notifyAfterMs"])
        XCTAssertNil(json["deepResearch"])
    }

    func testCreateSessionResponseDecodesConversationId() throws {
        let raw = Data("""
        {
          "sessionId": "s1",
          "conversationId": "conv-s1",
          "model": "test-model",
          "backend": "test-backend"
        }
        """.utf8)
        let session = try JSONDecoder().decode(CreateSessionResponse.self, from: raw)
        XCTAssertEqual(session.conversationId, "conv-s1")
    }

    func testCreateSessionResponseToleratesMissingConversationId() throws {
        let raw = Data("""
        {
          "sessionId": "s1",
          "model": "test-model",
          "backend": "test-backend"
        }
        """.utf8)
        let session = try JSONDecoder().decode(CreateSessionResponse.self, from: raw)
        XCTAssertNil(session.conversationId)
    }

    func testCreateSessionResponseDecodesTerminalContextFailure() throws {
        let raw = Data(#"""
        {
          "sessionId":"s1",
          "model":"fictional-model",
          "backend":"openai-compatible",
          "terminalFailure":{
            "code":"context_window_exceeded",
            "message":"This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
            "retryable":false,
            "backend":"openai-compatible",
            "model":"fictional-model",
            "failedAt":"2026-07-29T12:00:00.000Z",
            "context":{
              "measurement":"provider_reported",
              "limitSource":"provider",
              "requestIteration":1
            }
          }
        }
        """#.utf8)

        let session = try JSONDecoder().decode(CreateSessionResponse.self, from: raw)
        XCTAssertEqual(session.terminalFailure?.code, "context_window_exceeded")
        XCTAssertEqual(session.terminalFailure?.context?.measurement, "provider_reported")
    }
}

/// In-process `URLProtocol` that answers `POST /agent/sessions` with a minimal
/// success body and records the request body, so the real `AgentClient` can be
/// driven without a live gateway.
final class StubSessionCreateProtocol: URLProtocol {
    nonisolated(unsafe) static var lastBody: Data?
    private static let lock = NSLock()

    static func reset() {
        lock.lock()
        lastBody = nil
        lock.unlock()
    }

    // URLProtocol's overrides must be class funcs (they override class
    // methods), so `static` isn't possible here.
    // swiftlint:disable:next static_over_final_class
    override class func canInit(with _: URLRequest) -> Bool {
        true
    }

    // swiftlint:disable:next static_over_final_class
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        // `URLProtocol` strips httpBody from the request it hands us, so the
        // body has to be read back off the stream.
        var captured = Data()
        if let stream = request.httpBodyStream {
            stream.open()
            let size = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: size)
            defer {
                buffer.deallocate()
                stream.close()
            }
            while stream.hasBytesAvailable {
                let read = stream.read(buffer, maxLength: size)
                if read <= 0 { break }
                captured.append(buffer, count: read)
            }
        } else if let body = request.httpBody {
            captured = body
        }
        Self.lock.lock()
        Self.lastBody = captured
        Self.lock.unlock()

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(
            self,
            didLoad: Data(#"{"sessionId":"s1","model":"m","backend":"b"}"#.utf8)
        )
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
