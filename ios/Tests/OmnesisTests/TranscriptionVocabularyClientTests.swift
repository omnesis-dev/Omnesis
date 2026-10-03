// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class TranscriptionVocabularyClientTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        let status: Int
        let body: String
        init(status: Int, body: String = "{}") {
            self.status = status
            self.body = body
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }

    private let base = URL(string: "https://gateway.example.com")!

    func testAuthenticatedSelfContextAndLocaleNormalization() throws {
        let request = try TranscriptionVocabularyClient.request(baseURL: base, token: "fixture-token", locale: "fr_FR")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/inference/transcription-vocabulary")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
        let body = try XCTUnwrap(request.httpBody)
        let context = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(context["purpose"] as? String, "dictation")
        XCTAssertEqual((context["speaker"] as? [String: Bool])?["isSelf"], true)
        XCTAssertEqual(context["languageHints"] as? [String], ["fr-FR"])
        let invalid = try TranscriptionVocabularyClient.request(baseURL: base, token: "fixture-token", locale: "invalid@locale")
        let invalidBody = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(invalid.httpBody)) as? [String: Any])
        XCTAssertEqual(invalidBody["languageHints"] as? [String], [])
    }

    func testSnapshotAndAuthorizationMapping() async throws {
        let client = TranscriptionVocabularyClient(baseURL: base, token: "fixture-token", session: Session(status: 200, body: """
        {"enabled":true,"entries":[{"text":"Zuvrento","score":3}],"refreshAfterSeconds":1800,"expiresAfterSeconds":86400}
        """))
        let snapshot = try await client.fetch(locale: "en")
        XCTAssertTrue(snapshot.enabled)
        XCTAssertEqual(snapshot.phrases, ["Zuvrento"])
        for (status, expected) in [(401, GatewayClient.Error.unauthorized), (403, .forbidden)] {
            do {
                _ = try await TranscriptionVocabularyClient(baseURL: base, token: "fixture-token", session: Session(status: status))
                    .fetch(locale: "en")
                XCTFail("Authorization failure must throw")
            } catch {
                XCTAssertEqual(error as? GatewayClient.Error, expected)
            }
        }
    }

    func testStatusDefaultsOffAndDecodesOptIn() throws {
        for (extra, enabled) in [("", false), (",\"transcriptionVocabulary\":true", true), (",\"transcriptionVocabulary\":false", false)] {
            let data = Data("{\"documents\":{\"total\":0,\"bySource\":{}}\(extra)}".utf8)
            XCTAssertEqual(try JSONDecoder().decode(StatusSnapshot.self, from: data).transcriptionVocabulary, enabled)
        }
    }
}
