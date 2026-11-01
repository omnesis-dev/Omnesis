// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PhoneCaptureClientTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var status = 200
        var body = #"{"route":"ask"}"#

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            return (
                Data(body.utf8),
                HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            )
        }
    }

    private let base = URL(string: "https://gateway.example.com")!

    func testPhoneRoutesThroughAuthenticatedSharedClassifier() async throws {
        let session = Session()
        let client = WatchCaptureClient(baseURL: base, token: "test-token", session: session)
        let route = try await client.route("Where is my bicycle key?")
        XCTAssertEqual(route, .ask)
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.url?.path, "/watch/capture/route")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        let json = try JSONDecoder().decode([String: String].self, from: XCTUnwrap(request.httpBody))
        XCTAssertEqual(json, ["text": "Where is my bicycle key?"])
        session.body = #"{"route":"note"}"#
        let noteRoute = try await client.route("The bicycle key is in the drawer.")
        XCTAssertEqual(noteRoute, .note)
    }

    func testUnavailableOrInvalidDecisionIsAnErrorRatherThanANote() async throws {
        let session = Session()
        let client = WatchCaptureClient(baseURL: base, token: "test-token", session: session)
        for (status, body) in [(503, "{}"), (200, #"{"route":"automatic"}"#), (200, #"{"route":"unknown"}"#)] {
            session.status = status
            session.body = body
            do {
                _ = try await client.route("Where is the key?")
                XCTFail("An unavailable decision must offer manual routing")
            } catch {}
        }
    }

    func testRecordingUsesSharedWatchTranscriptionEndpoint() async throws {
        let session = Session()
        session.body = #"{"available":true,"text":"Where is the key?"}"#
        let client = WatchCaptureClient(baseURL: base, token: "test-token", session: session)
        let audio = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".m4a")
        defer { try? FileManager.default.removeItem(at: audio) }
        try Data([1, 2, 3]).write(to: audio)
        let text = try await client.transcribe(audio, locale: "en_GB")
        XCTAssertEqual(text, "Where is the key?")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.url?.path, "/watch/capture/transcribe")
        XCTAssertEqual(request.url?.query, "language=en")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "audio/mp4")
        XCTAssertEqual(request.httpBody, Data([1, 2, 3]))
        _ = try await client.transcribe(audio, locale: "en_GB", legacyGateway: true)
        XCTAssertEqual(session.requests.last?.url?.path, "/inference/transcribe")
        XCTAssertEqual(session.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
    }

    func testPhoneUsesTheSameActiveWatchGateWithoutPhoneCapability() throws {
        let data = Data(#"{"documents":{"total":0,"bySource":{}},"watchCapture":{"supported":true,"enabled":true,"active":true}}"#.utf8)
        let status = try JSONDecoder().decode(StatusSnapshot.self, from: data)
        XCTAssertTrue(status.captureDecisionGateActive)
        XCTAssertNil(status.capture)
    }

    func testPhoneGateDoesNotDivergeFromWatchGate() throws {
        for active in [true, false] {
            let body = #"""
            {"documents":{"total":0,"bySource":{}},
             "watchCapture":{"supported":true,"enabled":\#(active),"active":\#(active)},
             "capture":{"supported":true,"enabled":\#(!active),"active":\#(!active)}}
            """#
            let status = try JSONDecoder().decode(StatusSnapshot.self, from: Data(body.utf8))
            XCTAssertEqual(status.captureDecisionGateActive, active)
        }
    }

    func testAbsentPartialOrInactiveWatchGateOffersManualChoice() throws {
        for field in ["", #", "watchCapture":{"active":true}"#, #", "watchCapture":{"supported":true,"enabled":false,"active":false}"#] {
            let data = Data((#"{"documents":{"total":0,"bySource":{}}"# + field + "}").utf8)
            let status = try JSONDecoder().decode(StatusSnapshot.self, from: data)
            XCTAssertFalse(status.captureDecisionGateActive)
        }
    }
}
