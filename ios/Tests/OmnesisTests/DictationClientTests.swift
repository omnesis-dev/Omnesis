// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The wire shape of gateway dictation: the raw-audio upload to
/// `POST /dictation/transcribe`, the opt-in patch, and how the route's
/// refusals are told apart.
final class DictationClientTests: XCTestCase {
    private let base = URL(string: "https://gateway.example.com:7600")!
    private let audio = Data([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])

    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var status = 200
        var body = Data()

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (body, response)
        }
    }

    // MARK: - Request building

    func testTranscribeRequestSendsTheRawAudio() throws {
        let request = try DictationClient.transcribeRequest(
            baseURL: base,
            token: "omn_t",
            audio: audio,
            contentType: "audio/mp4",
            language: "FR"
        )
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/dictation/transcribe")
        XCTAssertEqual(request.url?.query, "language=fr")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "audio/mp4")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertEqual(request.httpBody, audio)
        // A cold model load on the gateway must not time the upload out.
        XCTAssertGreaterThanOrEqual(request.timeoutInterval, 60)
    }

    func testTranscribeRequestOmitsAMissingLanguage() throws {
        let request = try DictationClient.transcribeRequest(
            baseURL: base,
            token: "omn_t",
            audio: audio,
            contentType: "audio/mp4",
            language: nil
        )
        XCTAssertNil(request.url?.query)
    }

    func testOptInPatchesTheGatewayConfig() throws {
        let request = try DictationClient.optInRequest(baseURL: base, token: "omn_t", enabled: true)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/admin/config")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let inference = try XCTUnwrap(json["inference"] as? [String: Any])
        let dictation = try XCTUnwrap(inference["dictation"] as? [String: Any])
        XCTAssertEqual(dictation["transcribeOnGateway"] as? Bool, true)
        XCTAssertEqual(json.count, 1)
        XCTAssertEqual(inference.count, 1)

        let off = try DictationClient.optInRequest(baseURL: base, token: "omn_t", enabled: false)
        let offJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(off.httpBody)) as? [String: Any])
        let offFlag = ((offJSON["inference"] as? [String: Any])?["dictation"] as? [String: Any])?["transcribeOnGateway"]
        XCTAssertEqual(offFlag as? Bool, false)
    }

    // MARK: - Status mapping

    private func mapped(_ status: Int, _ body: String) -> Error {
        DictationClient.error(status: status, body: Data(body.utf8))
    }

    func testRouteRefusalsGetTheirOwnCases() {
        XCTAssertEqual(mapped(404, "Not found") as? DictationTranscribeError, .notOffered)
        XCTAssertEqual(
            mapped(409, #"{"error":"Gateway dictation is switched off.","code":"DICTATION_DISABLED"}"#)
                as? DictationTranscribeError,
            .disabled
        )
        XCTAssertEqual(
            mapped(413, #"{"error":"Audio body too large (max 25 MB)","code":"PAYLOAD_TOO_LARGE"}"#)
                as? DictationTranscribeError,
            .payloadTooLarge
        )
        XCTAssertEqual(
            mapped(503, #"{"error":"No transcriber model is assigned.","code":"TRANSCRIBER_UNAVAILABLE"}"#)
                as? DictationTranscribeError,
            .transcriberUnavailable("No transcriber model is assigned.")
        )
    }

    func testOtherFailuresKeepTheSharedVocabulary() {
        XCTAssertEqual(mapped(401, "") as? GatewayClient.Error, .unauthorized)
        XCTAssertEqual(mapped(403, "") as? GatewayClient.Error, .forbidden)
        XCTAssertEqual(
            mapped(500, #"{"error":"boom"}"#) as? GatewayClient.Error,
            .serverError(status: 500, body: #"{"error":"boom"}"#)
        )
        // A 409 that is not the dictation refusal is not mistaken for one.
        XCTAssertNil(mapped(409, #"{"error":"x","code":"OTHER"}"#) as? DictationTranscribeError)
    }

    // MARK: - Round trip

    func testTranscribeDecodesTheGatewaysText() async throws {
        let session = MockSession()
        session.body = Data(#"{"text":"Book the dentist for Thursday","language":"en","durationSec":2.4}"#.utf8)
        let client = DictationClient(baseURL: base, token: "omn_t", session: session)

        let result = try await client.transcribe(audio: audio, contentType: "audio/mp4", language: "en")

        XCTAssertEqual(result, DictationTranscription(text: "Book the dentist for Thursday", language: "en", durationSec: 2.4))
        XCTAssertEqual(session.requests.first?.httpBody, audio)
    }

    func testTranscribeThrowsTheRouteRefusal() async {
        let session = MockSession()
        session.status = 503
        session.body = Data(#"{"error":"The transcription failed.","code":"TRANSCRIBER_UNAVAILABLE"}"#.utf8)
        let client = DictationClient(baseURL: base, token: "omn_t", session: session)

        do {
            _ = try await client.transcribe(audio: audio, contentType: "audio/mp4", language: nil)
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? DictationTranscribeError, .transcriberUnavailable("The transcription failed."))
        }
    }
}
