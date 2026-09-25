// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class BriefsClientTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var responder: ((URLRequest) -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            guard let responder else {
                throw GatewayClient.Error.invalidResponse
            }
            return responder(request)
        }
    }

    private let base = URL(string: "http://mac.local:7600")!

    private func makeResponse(status: Int, body: String, url: URL) -> (Data, URLResponse) {
        let data = Data(body.utf8)
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (data, response)
    }

    private func queryItems(_ request: URLRequest) -> [String: String] {
        Dictionary(
            uniqueKeysWithValues: (
                URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            ).compactMap { item in
                item.value.map { (item.name, $0) }
            }
        )
    }

    // MARK: - feed()

    /// Decodes the full feed DTO — nullable fields both present and
    /// absent-as-null — and hits the right route with the bearer token.
    func testFeedRequestAndDecode() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"briefs":[
                  {"id":"b1","kind":"loop","state":"unread",
                   "title":"Reply to Maya about the cabin weekend",
                   "description":"No reply yet.",
                   "body":"Maya proposed two weekends.",
                   "confidence":0.9,"urgency":0.6,
                   "createdAt":"2026-07-02T10:00:00.000Z",
                   "eventAt":null,"relevantUntil":null,
                   "citations":[{"docId":"d1","title":"Cabin weekend — which dates?",
                                 "providerId":"google","sourceId":"gmail:user@example.com"}]},
                  {"id":"b2","kind":"info","state":"read",
                   "title":"Design review in 45 minutes",
                   "description":"Video call at 3pm.",
                   "body":null,
                   "confidence":0.8,"urgency":0.9,
                   "createdAt":"2026-07-02T11:30:00.000Z",
                   "eventAt":"2026-07-02T15:00:00.000Z",
                   "relevantUntil":"2026-07-02T16:00:00.000Z",
                   "citations":[]}
                ]}
                """,
                url: req.url!
            )
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        let briefs = try await client.feed().briefs

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/briefs/feed")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")

        XCTAssertEqual(briefs.count, 2)
        XCTAssertEqual(briefs[0].id, "b1")
        XCTAssertEqual(briefs[0].kind, .loop)
        XCTAssertEqual(briefs[0].state, .unread)
        XCTAssertEqual(briefs[0].body, "Maya proposed two weekends.")
        XCTAssertNil(briefs[0].eventAtDate)
        XCTAssertEqual(briefs[0].citations.count, 1)
        XCTAssertEqual(briefs[0].citations[0].docId, "d1")
        XCTAssertEqual(briefs[0].citations[0].sourceId, "gmail:user@example.com")
        XCTAssertEqual(briefs[1].kind, .info)
        XCTAssertEqual(briefs[1].state, .read)
        XCTAssertNil(briefs[1].body)
        XCTAssertTrue(briefs[1].citations.isEmpty)
        // The gateway's toISOString() timestamps (fractional seconds)
        // parse; eventAt lands 2h after createdAt wall-clock.
        let created = try XCTUnwrap(briefs[1].createdAtDate)
        let event = try XCTUnwrap(briefs[1].eventAtDate)
        XCTAssertEqual(event.timeIntervalSince(created), 3.5 * 3600, accuracy: 1)
    }

    func testFeedSendsCursorAndDecodesPageInfo() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "briefs":[],
                  "pageInfo":{"hasMore":true,"limit":2,"nextCursor":"brief-next"}
                }
                """,
                url: req.url!
            )
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)

        let page = try await client.feed(limit: 2, cursor: "brief+/=")
        let request = try XCTUnwrap(session.requests.first)

        XCTAssertTrue(page.pageInfo.hasMore)
        XCTAssertEqual(page.pageInfo.nextCursor, "brief-next")
        XCTAssertEqual(queryItems(request), [
            "limit": "2",
            "cursor": "brief+/=",
        ])
    }

    func testFeedEmptyIsTheNoBriefsState() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: #"{"briefs":[]}"#, url: req.url!)
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        let briefs = try await client.feed().briefs
        XCTAssertTrue(briefs.isEmpty)
    }

    /// An inactive feature answers 404 on every route — surfaced as the
    /// shared `.notFound` so `GatewayErrorView` classifies it.
    func testFeed404MapsToNotFound() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 404, body: #"{"error":"Not found"}"#, url: req.url!)
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        do {
            _ = try await client.feed()
            XCTFail("expected notFound")
        } catch GatewayClient.Error.notFound {
            // expected
        }
    }

    // MARK: - unreadCount()

    /// Hits `GET /briefs/count` with the bearer token and decodes the
    /// `unread` number — the cheap drawer-badge read.
    func testUnreadCountRequestAndDecode() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: #"{"unread":3}"#, url: req.url!)
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        let count = try await client.unreadCount()

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/briefs/count")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        XCTAssertEqual(count, 3)
    }

    /// An inactive feature 404s the count route too — surfaced as
    /// `.notFound` so the caller can zero the badge.
    func testUnreadCount404MapsToNotFound() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 404, body: #"{"error":"Not found"}"#, url: req.url!)
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        do {
            _ = try await client.unreadCount()
            XCTFail("expected notFound")
        } catch GatewayClient.Error.notFound {
            // expected
        }
    }

    // MARK: - markRead()

    func testMarkReadPostsToReadRoute() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: #"{"ok":true,"state":"read"}"#, url: req.url!)
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        try await client.markRead(briefId: "b1")

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/briefs/b1/read")
        XCTAssertNil(request.httpBody)
    }

    func testOpenThreadPostsAndDecodesResult() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: #"{"conversationId":"s_thread_1","created":true}"#,
                url: req.url!
            )
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        let result = try await client.openThread(briefId: "b1")

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/briefs/b1/thread")
        XCTAssertNil(request.httpBody)
        XCTAssertEqual(result, .init(conversationId: "s_thread_1", created: true))
    }

    /// The agent harness being unavailable answers 409 — surfaced as
    /// `serverError(status: 409, …)` so the card can show the message.
    func testOpenThread409SurfacesStatus() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 409,
                body: #"{"error":"no background-agent model is assigned for brief threads"}"#,
                url: req.url!
            )
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        do {
            _ = try await client.openThread(briefId: "b1")
            XCTFail("expected serverError")
        } catch GatewayClient.Error.serverError(let status, _) {
            XCTAssertEqual(status, 409)
        }
    }

    /// Marking a dismissed brief read answers 409 — surfaced as
    /// `serverError(status: 409, …)` so callers can drop the card.
    func testMarkRead409SurfacesStatus() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 409, body: #"{"error":"dismissed"}"#, url: req.url!)
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        do {
            try await client.markRead(briefId: "b1")
            XCTFail("expected serverError")
        } catch GatewayClient.Error.serverError(let status, _) {
            XCTAssertEqual(status, 409)
        }
    }

    // MARK: - dismiss()

    /// The gateway's dismiss body schema is strict — absent fields must
    /// be omitted entirely, never sent as null.
    func testDismissBodyOmitsAbsentFields() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: #"{"ok":true,"state":"dismissed_wrong","feedbackRunId":"r1"}"#,
                url: req.url!
            )
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        try await client.dismiss(briefId: "b1", reason: .wrong)

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/briefs/b1/dismiss")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
        )
        XCTAssertEqual(json["reason"] as? String, "wrong")
        XCTAssertEqual(Set(json.keys), ["reason"])
    }

    func testDismissEncodesFeedbackAndSnoozeUntil() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: #"{"ok":true,"state":"dismissed_snoozed","feedbackRunId":"r2"}"#,
                url: req.url!
            )
        }
        let client = BriefsClient(baseURL: base, token: "omn_t", session: session)
        let snoozeUntil = Date(timeIntervalSince1970: 1_790_000_000)
        try await client.dismiss(
            briefId: "b2",
            reason: .snoozed,
            feedback: "the deadline is actually the 20th",
            snoozeUntil: snoozeUntil
        )

        let request = try XCTUnwrap(session.requests.first)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
        )
        XCTAssertEqual(json["reason"] as? String, "snoozed")
        XCTAssertEqual(json["feedback"] as? String, "the deadline is actually the 20th")
        // ISO-8601 UTC, parseable back to the same instant.
        let wire = try XCTUnwrap(json["snoozeUntil"] as? String)
        let parsed = try XCTUnwrap(BriefRecord.date(from: wire))
        XCTAssertEqual(parsed.timeIntervalSince1970, snoozeUntil.timeIntervalSince1970, accuracy: 1)
        XCTAssertEqual(Set(json.keys), ["reason", "feedback", "snoozeUntil"])
    }

    /// The wire spelling of every reason matches the gateway enum.
    func testDismissReasonWireSpellings() {
        XCTAssertEqual(BriefDismissReason.notRelevant.rawValue, "not_relevant")
        XCTAssertEqual(BriefDismissReason.wrong.rawValue, "wrong")
        XCTAssertEqual(BriefDismissReason.alreadyHandled.rawValue, "already_handled")
        XCTAssertEqual(BriefDismissReason.acknowledged.rawValue, "acknowledged")
        XCTAssertEqual(BriefDismissReason.snoozed.rawValue, "snoozed")
    }

    /// The clear action reports the reason the gateway pairs with each
    /// kind: loop → already_handled, info → acknowledged. A wrong pairing
    /// is a runtime 400, not a compile error, so it is pinned here.
    func testClearActionReasonMatchesKind() {
        XCTAssertEqual(BriefKind.loop.clearActionReason, .alreadyHandled)
        XCTAssertEqual(BriefKind.info.clearActionReason, .acknowledged)
    }

    // MARK: - Date parsing

    func testDateParsingToleratesFractionalAndPlainSeconds() {
        XCTAssertNotNil(BriefRecord.date(from: "2026-07-02T10:00:00.123Z"))
        XCTAssertNotNil(BriefRecord.date(from: "2026-07-02T10:00:00Z"))
        XCTAssertNil(BriefRecord.date(from: "not a date"))
    }
}
