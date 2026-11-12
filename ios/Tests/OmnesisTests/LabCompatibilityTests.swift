// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class LabCompatibilityTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let data = Data(#"""
            {"experimental":true,"features":[
              {"id":"future/feature","name":"Future feature","description":"New experiment.","enabled":false}
            ]}
            """#.utf8)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (data, response)
        }
    }

    func testCatalogAcceptsFutureExperimentAndEscapesItsIdentifier() async throws {
        let session = Session()
        let client = try AdminClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "omn_example", session: session)
        let snapshot = try await client.getLab()
        XCTAssertEqual(snapshot.features.first?.id, "future/feature")
        _ = try await client.setLabFeature("future/feature", enabled: true)
        XCTAssertEqual(session.requests.last?.url?.absoluteString, "https://gateway.example.com/admin/lab/future%2Ffeature")
    }

    func testFlagsDefaultEachMissingKeyToFalse() throws {
        let empty = try JSONDecoder().decode(LabFlags.self, from: Data("{}".utf8))
        XCTAssertFalse(empty.brain)
        XCTAssertFalse(empty.tasks)
        XCTAssertFalse(empty.watches)
        let partial = try JSONDecoder().decode(LabFlags.self, from: Data(#"{"tasks":true,"future":true}"#.utf8))
        XCTAssertFalse(partial.brain)
        XCTAssertTrue(partial.tasks)
        XCTAssertFalse(partial.watches)
    }
}
