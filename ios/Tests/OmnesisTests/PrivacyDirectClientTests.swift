// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Direct half of the audit boundary: transcript sessions, their tool-call
/// events, the single-event payload read, and session deletion.
final class PrivacyDirectClientTests: PrivacyClientTestCase {
    func testListDirectSessionsDecodesSummaries() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"sessions":[
                {"id":"direct_1","ownerId":"owner_1","principalId":"principal_1",
                "principalName":"Atlas",
                "credentialId":"credential_1","grantId":"grant_1",
                "explicitKey":"conversation:conv_1",
                "heuristicKey":"principal_1|credential_1",
                "createdAt":1000,"lastEventAt":2000,"eventCount":3},
                {"id":"direct_2","ownerId":"owner_1","principalId":"principal_1",
                "principalName":null,
                "credentialId":"credential_2","grantId":"grant_1",
                "explicitKey":null,
                "heuristicKey":"principal_1|credential_2",
                "createdAt":500,"lastEventAt":600,"eventCount":1}]}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let sessions = try await client.listDirectSessions(limit: 50)

        XCTAssertEqual(sessions.count, 2)
        XCTAssertEqual(sessions[0].principalName, "Atlas")
        XCTAssertEqual(sessions[0].explicitKey, "conversation:conv_1")
        XCTAssertEqual(sessions[0].eventCount, 3)
        XCTAssertNil(sessions[1].principalName)
        XCTAssertNil(sessions[1].explicitKey)
        XCTAssertTrue(session.requests.first?.url?.path.hasSuffix("/admin/privacy/direct/sessions") == true)
        let firstRequest = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(queryItems(firstRequest)["limit"], "50")
    }

    func testListDirectSessionsToleratesMissingPrincipalName() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"sessions":[
                {"id":"direct_1","ownerId":"owner_1","principalId":"principal_1",
                "credentialId":"credential_1","grantId":"grant_1",
                "explicitKey":null,
                "heuristicKey":"principal_1|credential_1",
                "createdAt":1000,"lastEventAt":2000,"eventCount":1}]}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let sessions = try await client.listDirectSessions(limit: 50)

        XCTAssertEqual(sessions.count, 1)
        XCTAssertNil(sessions[0].principalName)
    }

    func testListDirectSessionEventsDecodesSummaries() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"events":[
                {"sequence":1,"id":"event_1","sessionId":"direct_1","tool":"search_many",
                "outcome":"ok","requestId":"request_1",
                "display":{"title":"search_many","text":null},
                "payloadTruncated":false,"payloadBytes":100,"originalPayloadBytes":100,
                "createdAt":1000},
                {"sequence":2,"id":"event_2","sessionId":"direct_1","tool":"fetch_many",
                "outcome":"refused","requestId":"request_2",
                "display":{"title":"fetch_many","text":null},
                "payloadTruncated":true,"payloadBytes":190,"originalPayloadBytes":200192,
                "createdAt":1100}]}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let events = try await client.listDirectSessionEvents(sessionId: "direct_1", limit: 100)

        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0].outcome, .ok)
        XCTAssertEqual(events[1].outcome, .refused)
        XCTAssertTrue(events[1].payloadTruncated)
        XCTAssertTrue(
            session.requests.first?.url?.path.hasSuffix(
                "/admin/privacy/direct/sessions/direct_1/events"
            ) == true
        )
    }

    func testGetDirectEventDecodesPayload() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"event":{"sequence":1,"id":"event_1","sessionId":"direct_1",
                "tool":"search_many","outcome":"ok","requestId":"request_1",
                "display":{"title":"search_many","text":null},
                "payloadTruncated":false,"payloadBytes":100,"originalPayloadBytes":100,
                "createdAt":1000,
                "payload":{"tool":"search_many","args":{"queries":[{"query":"marathon"}]},
                "result":{"kind":"search.batch","items":[]},"outcome":"ok"}}}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let detail = try await client.getDirectEvent(id: "event_1")

        XCTAssertEqual(detail.tool, "search_many")
        XCTAssertEqual(
            detail.payload,
            .object([
                "tool": .string("search_many"),
                "args": .object(["queries": .array([.object(["query": .string("marathon")])])]),
                "result": .object(["kind": .string("search.batch"), "items": .array([])]),
                "outcome": .string("ok"),
            ])
        )
        XCTAssertTrue(session.requests.first?.url?.path.hasSuffix("/admin/privacy/direct/events/event_1") == true)
    }

    func testDeleteDirectSessionSendsDelete() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: #"{"deleted":true}"#)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        try await client.deleteDirectSession(id: "direct_1")

        XCTAssertEqual(session.requests.first?.httpMethod, "DELETE")
        XCTAssertTrue(
            session.requests.first?.url?.path.hasSuffix("/admin/privacy/direct/sessions/direct_1") == true
        )
    }

    func testDeleteDirectSessionFalseThrows() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: #"{"deleted":false}"#)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        do {
            try await client.deleteDirectSession(id: "direct_1")
            XCTFail("expected invalid response")
        } catch GatewayClient.Error.invalidResponse {
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testDirectSessionIdIsEncodedAsOnePathSegment() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, status: 404, body: #"{"error":"not found"}"#)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        do {
            _ = try await client.listDirectSessionEvents(sessionId: "direct/../other")
            XCTFail("expected not found")
        } catch GatewayClient.Error.notFound {
            XCTAssertEqual(
                session.requests.first?.url?.absoluteString,
                "http://gateway.example:7600/admin/privacy/direct/sessions/direct%2F..%2Fother/events?limit=100"
            )
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}
