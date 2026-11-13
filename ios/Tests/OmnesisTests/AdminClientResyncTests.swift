// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The requests a resync sends: one carrying the mode, or the delete then
/// the sync for a gateway that predates resync modes.
final class AdminClientResyncTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var failingPathSuffix: String?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let failed = failingPathSuffix.map { request.url?.path.hasSuffix($0) == true } ?? false
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: failed ? 500 : 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(#"{"ok":true,"deleted":3}"#.utf8), response)
        }
    }

    private let sourceId = "gmail:maya.reeves@example.org"

    private func client(_ session: MockSession) -> AdminClient {
        AdminClient(baseURL: URL(string: "http://gateway.example.org:7600")!, token: "omn_example", session: session)
    }

    private func paths(_ session: MockSession) -> [String] {
        session.requests.map { $0.url?.path ?? "" }
    }

    func testResyncSourcePostsTheModeToTheResyncRoute() async throws {
        for mode in SourceResyncMode.allCases {
            let session = MockSession()
            try await client(session).resyncSource(sourceId: sourceId, mode: mode)
            XCTAssertEqual(session.requests.count, 1)
            let request = session.requests[0]
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/admin/sources/\(sourceId)/resync")
            let body = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String]
            XCTAssertEqual(body, ["mode": mode.rawValue])
        }
    }

    func testStepsForAGatewayWithModesSendOneRequest() async throws {
        let session = MockSession()
        try await client(session).runResync([.resync(.inPlace)], sourceId: sourceId)
        XCTAssertEqual(paths(session), ["/admin/sources/\(sourceId)/resync"])
    }

    func testStepsForAnOlderGatewayDeleteThenSync() async throws {
        let session = MockSession()
        try await client(session).runResync([.deleteAll, .sync], sourceId: sourceId)
        XCTAssertEqual(paths(session), ["/documents/delete-all/source/\(sourceId)", "/admin/sources/\(sourceId)/sync"])
    }

    func testAFailedDeleteSendsNoSync() async {
        let session = MockSession()
        session.failingPathSuffix = sourceId
        do {
            try await client(session).runResync([.deleteAll, .sync], sourceId: sourceId)
            XCTFail("a failed delete must stop the resync")
        } catch {
            XCTAssertEqual(paths(session), ["/documents/delete-all/source/\(sourceId)"])
        }
    }
}
