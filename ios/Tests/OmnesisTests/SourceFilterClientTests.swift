// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessSourceFilterClientTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var body = "{}"
        var status = 200
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
        }
    }

    func testPickerEncodesAccountAndQueryAsSeparateComponents() async throws {
        let session = Session()
        session.body = """
        {"sourceId":"scope-chat:one/account","sourceType":"scope-chat",
        "scopes":{"items":[]},"readiness":[],"items":[],"nextCursor":"next-page"}
        """
        let client = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example")),
            token: "fictional-owner",
            session: session
        )
        let value = try await client.scopeOptions(
            sourceId: "scope-chat:one/account",
            kind: "folder",
            query: "Cedar & archive",
            parentId: "folder/one",
            cursor: "page+two"
        )
        XCTAssertEqual(value.nextCursor, "next-page")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertTrue(try XCTUnwrap(request.url?.absoluteString.contains("scope-chat%3Aone%2Faccount/options")))
        let query = try XCTUnwrap(try URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(query.first { $0.name == "q" }?.value, "Cedar & archive")
        XCTAssertEqual(query.first { $0.name == "parentId" }?.value, "folder/one")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fictional-owner")
    }

    func testPreviewSendsCapturedIdentifiersAndKeepsUnknownCounts() async throws {
        let session = Session()
        session.body = """
        {"sourceId":"scope-chat:one","total":3,"visible":1,"hidden":2,"unknown":1,"items":[],"samples":[],"readiness":[]}
        """
        var policy = ScopePolicy.empty(sourceId: "scope-chat:one", levelId: "new", capability: "answer")
        policy.rules[0].match = [.init(kind: "participant", label: "Maya", identifiers: [.init(type: "phone", value: "+15550100123")])]
        let client = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example")),
            token: "fictional-owner",
            session: session
        )
        let value = try await client.scopePreview(policy)
        XCTAssertEqual(value.hidden, 2)
        XCTAssertEqual(value.unknown, 1)
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertNotNil(body["policy"])
        XCTAssertFalse(try XCTUnwrap(try String(data: XCTUnwrap(request.httpBody), encoding: .utf8)?.contains("personId")))
    }

    func testLevelUpdateCarriesBothPreviousFilterRevisionsIncludingRemovedCapabilities() async throws {
        let session = Session()
        session.status = 409
        session.body = "{\"error\":\"stale-filter-revision\"}"
        let client = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example")),
            token: "fictional-owner",
            session: session
        )
        do {
            _ = try await client.updateLevel(
                id: "level-example",
                name: "Research assistant",
                rules: [.notes],
                expectedRevision: 7,
                expectedFilterRevisions: ["answer": 4, "direct": 2]
            )
            XCTFail("Stale edits must be refused")
        } catch GatewayClient.Error.serverError(let status, _) { XCTAssertEqual(status, 409) }
        let request = try XCTUnwrap(session.requests.first)
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["expectedRevision"] as? Int, 7)
        XCTAssertEqual(body["expectedFilterRevisions"] as? [String: Int], ["answer": 4, "direct": 2])
        XCTAssertEqual(session.requests.count, 1)
    }
}
