// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class SearchClientTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        private let lock = NSLock()
        var requests: [URLRequest] = []
        var responder: ((URLRequest) -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            lock.withLock { requests.append(request) }
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
            url: url, statusCode: status, httpVersion: "HTTP/1.1",
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

    // MARK: - search()

    func testSearchPostsBodyAndDecodesResults() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "results": [
                    {
                      "documentId": "abc-123",
                      "sourceId": "gmail:user@example.com",
                      "documentType": "email",
                      "title": "Hello world",
                      "sourceCreatedAt": "2026-01-01T12:00:00Z",
                      "author": "alice@example.com",
                      "chunkText": "Hi there.",
                      "score": 0.91
                    }
                  ],
                  "query": { "original": "hello" },
                  "timing": { "totalMs": 12 }
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let response = try await client.search(text: "hello", limit: 30)
        XCTAssertEqual(response.results.count, 1)
        XCTAssertEqual(response.results[0].documentId, "abc-123")
        XCTAssertEqual(response.results[0].documentType, "email")
        XCTAssertEqual(response.results[0].title, "Hello world")
        XCTAssertEqual(response.results[0].score, 0.91, accuracy: 1e-6)

        let req = session.requests[0]
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        XCTAssertEqual(req.url?.absoluteString, "http://mac.local:7600/search")
        let body = try XCTUnwrap(req.httpBody)
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(json?["text"] as? String, "hello")
        XCTAssertEqual(json?["limit"] as? Int, 30)
    }

    func testSearchPropagatesUnauthorized() async {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 401, body: "{\"error\":\"bad token\"}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        do {
            _ = try await client.search(text: "x")
            XCTFail("expected error")
        } catch GatewayClient.Error.unauthorized {
            // expected
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    // MARK: - recentItems()

    func testRecentItemsDecodesDocumentsArm() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "kind": "documents",
                  "documents": [
                    {
                      "id": "doc-1",
                      "sourceId": "gmail:user@example.com",
                      "externalId": "ext-1",
                      "title": "First",
                      "contentPreview": "preview text",
                      "documentType": "email",
                      "relevanceScore": 0.5,
                      "sourceCreatedAt": "2026-01-01T00:00:00Z",
                      "sourceUpdatedAt": "2026-01-01T00:00:00Z"
                    }
                  ]
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let response = try await client.recentItems(sourceId: "gmail:user@example.com", limit: 5)
        guard case .documents(let docs) = response.content else {
            return XCTFail("expected .documents arm, got \(response)")
        }
        XCTAssertEqual(docs.count, 1)
        XCTAssertEqual(docs[0].title, "First")
        XCTAssertEqual(docs[0].contentPreview, "preview text")

        // URL is percent-encoded with `?limit=5`.
        let absolute = session.requests[0].url?.absoluteString ?? ""
        XCTAssertTrue(absolute.contains("/sources/"))
        XCTAssertTrue(absolute.hasSuffix("/recent?limit=5"))
    }

    func testRecentItemsSendsCursorAndDecodesPageInfo() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "kind":"documents",
                  "documents":[],
                  "pageInfo":{"hasMore":true,"limit":3,"nextCursor":"recent-next"}
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)

        let page = try await client.recentItems(
            sourceId: "gmail:user@example.com",
            limit: 3,
            cursor: "recent+/="
        )
        let request = try XCTUnwrap(session.requests.first)

        XCTAssertEqual(page.pageInfo.nextCursor, "recent-next")
        XCTAssertEqual(queryItems(request), [
            "limit": "3",
            "cursor": "recent+/=",
        ])
    }

    func testRecentItemsDecodesEmptyArm() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"kind\":\"empty\"}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let response = try await client.recentItems(sourceId: "gmail:x")
        guard case .empty = response.content else {
            return XCTFail("expected .empty, got \(response)")
        }
    }

    func testRecentItemsDecodesEnvelopeInternalFlag() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"kind\":\"empty\",\"internal\":true}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let page = try await client.recentItems(sourceId: "omnesis-notes")
        XCTAssertTrue(page.isInternal)
    }

    func testRecentItemsDefaultsEnvelopeInternalToFalse() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"kind\":\"empty\"}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let page = try await client.recentItems(sourceId: "gmail:x")
        XCTAssertFalse(page.isInternal)
    }

    func testGetDocumentFlagsInternalSource() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "id": "doc-1", "provider_id": "local:default", "source_id": "omnesis-notes",
                  "external_id": "2026-01-02", "title": "Notes", "content": "body",
                  "content_hash": "sha256:abc", "metadata": {},
                  "source_created_at": "2026-01-02T10:00:00Z", "internal": true
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let doc = try await client.getDocument(id: "doc-1")
        XCTAssertTrue(doc.isInternal)
    }

    func testGetDocumentDefaultsInternalToFalse() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "id": "doc-2", "provider_id": "local:default", "source_id": "gmail:user@example.com",
                  "external_id": "e", "title": "Hi", "content": "body",
                  "content_hash": "sha256:abc", "metadata": {},
                  "source_created_at": "2026-01-02T10:00:00Z"
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let doc = try await client.getDocument(id: "doc-2")
        XCTAssertFalse(doc.isInternal)
    }

    func testRecentItemsDecodesAnalyticsArm() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "kind": "analytics",
                  "table": "strava_activities",
                  "displayName": "Strava activities",
                  "columns": ["id", "start", "distance"],
                  "columnDefs": [],
                  "rows": [["1", "2026-01-01", 10.0], ["2", "2026-01-02", 5.5]]
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let response = try await client.recentItems(sourceId: "strava-activities:user@example.com")
        guard case .analytics(let table, let displayName, let columns, let rows) = response.content else {
            return XCTFail("expected .analytics, got \(response)")
        }
        XCTAssertEqual(table, "strava_activities")
        XCTAssertEqual(displayName, "Strava activities")
        XCTAssertEqual(columns, ["id", "start", "distance"])
        XCTAssertEqual(rows, [
            [.string("1"), .string("2026-01-01"), .int(10)],
            [.string("2"), .string("2026-01-02"), .double(5.5)],
        ])
    }

    func testDuckDBCellDisplayBoundsLongValuesAndCompactsNestedValues() {
        let longValue = String(repeating: "x", count: 240)
        XCTAssertEqual(JSONValue.string(longValue).displayString, String(repeating: "x", count: 200) + "…")
        XCTAssertEqual(JSONValue.array([.int(1), .string("two")]).displayString, "[2 items]")
        XCTAssertEqual(JSONValue.object(["place": .string("Studio Northstar")]).displayString, "{1 fields}")
    }

    // MARK: - getDocument()

    func testGetDocumentDecodesSnakeCaseRow() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "id": "abc-123",
                  "provider_id": "google:user@example.com",
                  "source_id": "gmail:user@example.com",
                  "external_id": "ext-1",
                  "title": "Hello",
                  "content": "Hello body",
                  "content_hash": "abc",
                  "metadata": "{\\"documentType\\":\\"email\\",\\"sourceUrl\\":\\"https://mail.google.com/x\\"}",
                  "source_created_at": "2026-01-01T00:00:00Z",
                  "source_updated_at": "2026-01-01T00:00:00Z",
                  "ingested_at": "2026-01-01T00:00:00Z",
                  "updated_at": "2026-01-01T00:00:00Z"
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let doc = try await client.getDocument(id: "abc-123")
        XCTAssertEqual(doc.id, "abc-123")
        XCTAssertEqual(doc.title, "Hello")
        XCTAssertEqual(doc.content, "Hello body")
        XCTAssertEqual(doc.documentType, "email")
        XCTAssertEqual(doc.sourceUrl, "https://mail.google.com/x")
    }

    func testGetDocumentDecodesParsedMetadataObject() async throws {
        // Some endpoints already return metadata as a parsed object — ensure
        // both wire shapes decode without error.
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "id": "abc-123",
                  "provider_id": "google:user@example.com",
                  "source_id": "gmail:user@example.com",
                  "external_id": "ext-1",
                  "title": "Hello",
                  "content": "body",
                  "content_hash": "abc",
                  "metadata": {"documentType": "email"},
                  "source_created_at": "2026-01-01T00:00:00Z"
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let doc = try await client.getDocument(id: "abc-123")
        XCTAssertEqual(doc.documentType, "email")
    }

    // MARK: - getDocumentPeople()

    func testGetDocumentPeopleDecodesArrayWrapper() async throws {
        // Match the real `DocumentPersonLink[]` wire shape from
        // packages/gateway/src/people.ts:135 — `canonicalName` (not
        // `name`) plus an aliases array. The displayName fallback to
        // the first alias is what makes WhatsApp participants known
        // only by phone show their phone instead of "(unknown)".
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                { "people": [
                  {
                    "personId": "p1",
                    "canonicalName": "Alice",
                    "role": "sender",
                    "isSelf": false,
                    "aliases": [{"id":"a1","aliasType":"email","alias":"alice@example.com","sourceId":null}]
                  },
                  {
                    "personId": "p2",
                    "canonicalName": "",
                    "role": "participant",
                    "isSelf": false,
                    "aliases": [{"id":"a2","aliasType":"phone","alias":"+15550100000","sourceId":null}]
                  }
                ] }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let people = try await client.getDocumentPeople(id: "abc")
        XCTAssertEqual(people.count, 2)
        XCTAssertEqual(people[0].role, "sender")
        XCTAssertEqual(people[0].displayName, "Alice")
        // Phone-only participant falls back to the alias.
        XCTAssertEqual(people[1].displayName, "+15550100000")
    }

    // MARK: - annotations

    func testGetDocumentAnnotationsDecodesWrapper() async throws {
        // The agent's durable LLM annotations grounded on a document — the
        // "Enriched by Omnesis" panel. One row carries a grounding evidence
        // quote; the second is a null-evidence row (render-time defensiveness).
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                { "annotations": [
                  {
                    "id": "ann-1",
                    "claimType": "commitment",
                    "claimText": "A payment of $124.00 is due by April 15.",
                    "evidenceDocId": "abc-123",
                    "evidenceQuote": "Pay before the due date to avoid late fees.",
                    "confidence": 0.88,
                    "claimBasis": "inferred",
                    "createdAt": "2026-04-12T10:16:00Z",
                    "verificationState": "verified",
                    "lastVerifiedAt": "2026-04-14T08:00:00Z"
                  },
                  {
                    "id": "ann-2",
                    "claimType": "vendor",
                    "claimText": "Issued by Stellar Sound.",
                    "evidenceDocId": null,
                    "evidenceQuote": null,
                    "confidence": 0.7,
                    "createdAt": "2026-04-12T10:16:30Z"
                  }
                ],
                "pageInfo":{"hasMore":true,"limit":2,"nextCursor":"annotation-next"} }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let annotations = try await client.getDocumentAnnotations(
            id: "abc-123",
            limit: 2,
            cursor: "annotation+/="
        )
        XCTAssertEqual(annotations.annotations.count, 2)
        XCTAssertEqual(annotations.annotations[0].id, "ann-1")
        XCTAssertEqual(annotations.annotations[0].claimType, "commitment")
        XCTAssertEqual(annotations.annotations[0].claimText, "A payment of $124.00 is due by April 15.")
        XCTAssertEqual(annotations.annotations[0].evidenceDocId, "abc-123")
        XCTAssertEqual(annotations.annotations[0].evidenceQuote, "Pay before the due date to avoid late fees.")
        XCTAssertEqual(annotations.annotations[0].confidence, 0.88, accuracy: 1e-6)
        XCTAssertEqual(annotations.annotations[0].claimBasis, "inferred")
        XCTAssertEqual(annotations.annotations[0].verificationState, "verified")
        XCTAssertEqual(annotations.annotations[0].lastVerifiedAt, "2026-04-14T08:00:00Z")
        // Null-evidence row decodes to nil on both optional fields; the
        // basis/verification metadata an older gateway omits decodes to nil.
        XCTAssertNil(annotations.annotations[1].evidenceDocId)
        XCTAssertNil(annotations.annotations[1].evidenceQuote)
        XCTAssertEqual(annotations.annotations[1].confidence, 0.7, accuracy: 1e-6)
        XCTAssertNil(annotations.annotations[1].claimBasis)
        XCTAssertNil(annotations.annotations[1].verificationState)
        XCTAssertNil(annotations.annotations[1].lastVerifiedAt)
        XCTAssertEqual(annotations.pageInfo.nextCursor, "annotation-next")

        let req = session.requests[0]
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        XCTAssertEqual(queryItems(req), [
            "limit": "2",
            "cursor": "annotation+/=",
            "includeDependents": "0",
        ])
    }

    func testGetPersonAnnotationsDecodesWrapper() async throws {
        // Same wire shape as document annotations, served from the person
        // route — the self person's are the user's own "Profile".
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                { "annotations": [
                  {
                    "id": "ann-p-1",
                    "claimType": "routine",
                    "claimText": "Reviews open loops on Sunday evenings.",
                    "evidenceDocId": "doc-ann-1",
                    "evidenceQuote": "doing my Sunday reset now",
                    "confidence": 0.95,
                    "createdAt": "2026-07-01T09:00:00Z"
                  }
                ] }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let annotations = try await client.getPersonAnnotations(id: "p1")
        XCTAssertEqual(annotations.annotations.count, 1)
        XCTAssertEqual(annotations.annotations[0].id, "ann-p-1")
        XCTAssertEqual(annotations.annotations[0].claimType, "routine")
        XCTAssertEqual(annotations.annotations[0].claimText, "Reviews open loops on Sunday evenings.")
        XCTAssertEqual(annotations.annotations[0].evidenceQuote, "doing my Sunday reset now")
        XCTAssertEqual(annotations.annotations[0].confidence, 0.95, accuracy: 1e-6)

        let req = session.requests[0]
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(
            req.url?.absoluteString,
            "http://mac.local:7600/people/p1/annotations?limit=20&includeDependents=0"
        )
    }

    func testGetPersonDocumentsPageSendsOpaqueCursorAndDecodesPageInfo() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "items": [
                    { "id": "doc-1", "roles": ["participant"] }
                  ],
                  "pageInfo": {
                    "hasMore": true,
                    "limit": 1,
                    "nextCursor": "person-docs-next"
                  }
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)

        let page = try await client.getPersonDocumentsPage(
            id: "person-1",
            limit: 1,
            cursor: "opaque+/="
        )
        let request = try XCTUnwrap(session.requests.first)

        XCTAssertEqual(page.items.map(\.id), ["doc-1"])
        XCTAssertEqual(page.pageInfo.nextCursor, "person-docs-next")
        XCTAssertEqual(queryItems(request), [
            "limit": "1",
            "cursor": "opaque+/=",
        ])
    }

    func testGetAnnotationsDegradesOn404() async {
        // Experimental-gated server-side: the routes 404 when the gateway
        // isn't in experimental mode. The client throws `.notFound`; call
        // sites degrade to an empty list via `try?`, which this asserts
        // end-to-end for both the document and person routes.
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 404, body: "{\"error\":\"not found\"}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let docAnnotations = await (try? client.getDocumentAnnotations(id: "abc"))?.annotations ?? []
        XCTAssertTrue(docAnnotations.isEmpty)
        let personAnnotations = await (try? client.getPersonAnnotations(id: "p1"))?.annotations ?? []
        XCTAssertTrue(personAnnotations.isEmpty)
    }

    // MARK: - Document graph pagination

    func testGetDocumentRefsLoadsBothCanonicalDirectionPages() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            switch req.url?.path {
            case "/documents/abc/refs/outbound":
                self!.makeResponse(
                    status: 200,
                    body: """
                    {
                      "items":[{
                        "linkType":"url",
                        "rawTarget":"https://example.com/plan",
                        "normalizedTarget":"https://example.com/plan",
                        "targetDocId":"doc-plan",
                        "targetTitle":"Quarterly plan",
                        "targetSourceId":"demo-mail:inbox",
                        "targetSourceUrl":null,
                        "targetAppUrl":null
                      }],
                      "pageInfo":{"hasMore":true,"limit":2,"nextCursor":"outbound-next"}
                    }
                    """,
                    url: req.url!
                )
            case "/documents/abc/refs/inbound":
                self!.makeResponse(
                    status: 200,
                    body: """
                    {
                      "items":[{
                        "sourceDocId":"doc-notes",
                        "sourceTitle":"Review notes",
                        "sourceSourceId":"demo-drive:files",
                        "linkType":"url",
                        "sourceSourceUrl":null,
                        "sourceAppUrl":null
                      }],
                      "pageInfo":{"hasMore":false,"limit":2}
                    }
                    """,
                    url: req.url!
                )
            default:
                self!.makeResponse(status: 500, body: #"{"error":"unexpected"}"#, url: req.url!)
            }
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)

        let refs = try await client.getDocumentRefs(id: "abc", limit: 2)

        XCTAssertEqual(refs.outbound.map(\.targetDocId), ["doc-plan"])
        XCTAssertEqual(refs.inbound.map(\.sourceDocId), ["doc-notes"])
        XCTAssertEqual(refs.outboundPageInfo.nextCursor, "outbound-next")
        XCTAssertFalse(refs.inboundPageInfo.hasMore)
        XCTAssertEqual(
            Set(session.requests.compactMap(\.url?.path)),
            ["/documents/abc/refs/outbound", "/documents/abc/refs/inbound"]
        )
        for request in session.requests {
            XCTAssertEqual(queryItems(request), ["limit": "2"])
        }
    }

    func testGetDocumentRefsFallsBackToLegacyEnvelopeOnDirection404() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            if req.url?.path == "/documents/abc/refs" {
                return self!.makeResponse(
                    status: 200,
                    body: """
                    {
                      "outbound":[{
                        "linkType":"url",
                        "rawTarget":"https://example.com/archive",
                        "normalizedTarget":"https://example.com/archive",
                        "targetDocId":null,
                        "targetTitle":null,
                        "targetSourceId":null,
                        "targetSourceUrl":null,
                        "targetAppUrl":null
                      }],
                      "inbound":[]
                    }
                    """,
                    url: req.url!
                )
            }
            return self!.makeResponse(
                status: 404,
                body: #"{"error":"Not found"}"#,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)

        let refs = try await client.getDocumentRefs(id: "abc", limit: 2)

        XCTAssertEqual(refs.outbound.count, 1)
        XCTAssertFalse(refs.outboundPageInfo.hasMore)
        XCTAssertFalse(refs.inboundPageInfo.hasMore)
        XCTAssertTrue(session.requests.contains { $0.url?.path == "/documents/abc/refs" })
    }

    func testGetDocumentNearDupesSendsAfterCursorAndDecodesNextCursor() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: #"{"edges":[],"nextCursor":"near-next"}"#,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)

        let page = try await client.getDocumentNearDupes(
            id: "abc",
            limit: 4,
            cursor: "near+/="
        )
        let request = try XCTUnwrap(session.requests.first)

        XCTAssertEqual(page.nextCursor, "near-next")
        XCTAssertEqual(queryItems(request), [
            "limit": "4",
            "after": "near+/=",
        ])
    }

    // MARK: - People merge rules / candidates

    func testListPeoplePageSendsCursorAndDecodesPageInfo() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "items":[],
                  "pageInfo":{"hasMore":true,"limit":7,"nextCursor":"people-next"}
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)

        let page = try await client.listPeoplePage(
            query: "Maya",
            limit: 7,
            cursor: "people+/="
        )
        let request = try XCTUnwrap(session.requests.first)

        XCTAssertEqual(page.pageInfo.nextCursor, "people-next")
        XCTAssertEqual(queryItems(request), [
            "limit": "7",
            "q": "Maya",
            "cursor": "people+/=",
        ])
    }

    func testListMergeRuleGroupsSendsFiltersAndCursor() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {
                  "items":[],
                  "pageInfo":{"hasMore":true,"limit":5,"nextCursor":"rules-next"}
                }
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)

        let page = try await client.listMergeRuleGroups(
            limit: 5,
            cursor: "rules+/=",
            query: "Maya",
            kind: "user"
        )
        let request = try XCTUnwrap(session.requests.first)

        XCTAssertEqual(page.pageInfo.nextCursor, "rules-next")
        XCTAssertEqual(queryItems(request), [
            "limit": "5",
            "cursor": "rules+/=",
            "q": "Maya",
            "kind": "user",
        ])
    }

    func testListMergeRulesUnwrapsRulesEnvelope() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"rules":[
                  {"id":"r1","kind":"user","winnerSide":"a",
                   "sideA":{"aliasType":"email","alias":"maya@example.com"},
                   "sideB":{"aliasType":"email","alias":"m.reeves@example.org"},
                   "reason":"same person","createdAt":"2026-01-02T00:00:00Z","groupId":"g1"}
                ]}
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let rules = try await client.listMergeRules()
        XCTAssertEqual(rules.count, 1)
        XCTAssertEqual(rules[0].id, "r1")
        XCTAssertEqual(rules[0].kind, "user")
        XCTAssertEqual(rules[0].winnerSide, "a")
        XCTAssertEqual(rules[0].sideA.alias, "maya@example.com")
        XCTAssertEqual(rules[0].groupId, "g1")

        let absolute = session.requests[0].url?.absoluteString ?? ""
        XCTAssertTrue(absolute.contains("/people/merge-rules"))
        XCTAssertTrue(absolute.contains("active=1"))
        XCTAssertTrue(absolute.contains("resolve=1"))
        XCTAssertTrue(absolute.contains("details=1"))
        XCTAssertTrue(absolute.contains("preMerge=1"))
        XCTAssertEqual(session.requests[0].httpMethod, "GET")
        XCTAssertEqual(session.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
    }

    func testListMergeCandidatesDecodesItemsAndCounts() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[
                  {"id":"c1","clusterId":"cl1",
                   "resolvedSideA":[{"id":"p1","canonicalName":"Maya Reeves"}],
                   "resolvedSideB":[{"id":"p2","canonicalName":"M. Reeves"}]}
                ],
                 "counts":{"pending":3,"accepted":1,"denied":2},
                 "pageInfo":{"hasMore":true,"limit":1,"nextCursor":"candidates-next"}}
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let page = try await client.listMergeCandidates(
            clusterLimit: 1,
            cursor: "candidates+/=",
            query: "Maya"
        )
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].id, "c1")
        XCTAssertEqual(page.items[0].clusterId, "cl1")
        XCTAssertEqual(page.items[0].resolvedSideA.first?.canonicalName, "Maya Reeves")
        XCTAssertEqual(page.counts.pending, 3)
        XCTAssertEqual(page.counts.accepted, 1)
        XCTAssertEqual(page.counts.denied, 2)
        XCTAssertEqual(page.pageInfo.nextCursor, "candidates-next")

        XCTAssertEqual(session.requests[0].url?.path, "/people/merge-candidates")
        XCTAssertEqual(queryItems(session.requests[0]), [
            "status": "pending",
            "clusterLimit": "1",
            "cursor": "candidates+/=",
            "q": "Maya",
        ])
        XCTAssertEqual(session.requests[0].httpMethod, "GET")
    }

    func testPeopleStatsDecodesSummaryAndMergeCounts() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"totalPeople":420,"totalAliases":1200,"totalLinks":9000,
                 "selfDetected":true,"pendingMergeCandidates":133,"mergeRules":415}
                """,
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let stats = try await client.peopleStats()
        XCTAssertEqual(stats.totalPeople, 420)
        XCTAssertTrue(stats.selfDetected)
        XCTAssertEqual(stats.pendingMergeCandidates, 133)
        XCTAssertEqual(stats.mergeRules, 415)

        let absolute = session.requests[0].url?.absoluteString ?? ""
        XCTAssertTrue(absolute.hasSuffix("/people/stats"))
        XCTAssertEqual(session.requests[0].httpMethod, "GET")
    }

    func testMergeClusterPostsPersonIdsAndDecodesResult() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: "{\"rulesCreated\":2,\"anchorId\":\"p1\",\"groupId\":\"g9\"}",
                url: req.url!
            )
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let result = try await client.mergeCluster(personIds: ["p1", "p2", "p3"], reason: "same person")
        XCTAssertEqual(result.rulesCreated, 2)
        XCTAssertEqual(result.anchorId, "p1")
        XCTAssertEqual(result.groupId, "g9")

        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue((session.requests[0].url?.absoluteString ?? "").hasSuffix("/people/merge-candidates/merge-cluster"))
        let body = session.requests[0].httpBody ?? Data()
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(decoded?["personIds"] as? [String], ["p1", "p2", "p3"])
        XCTAssertEqual(decoded?["reason"] as? String, "same person")
    }

    func testDenyMergeCandidatePostsToDenyRoute() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        try await client.denyMergeCandidate(id: "c1")
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue((session.requests[0].url?.absoluteString ?? "").hasSuffix("/people/merge-candidates/c1/deny"))
    }

    // MARK: - deleteDocument()

    func testDeleteDocumentSendsDeleteToDocumentRouteAndDecodesCount() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"deleted\":2}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        let deleted = try await client.deleteDocument(id: "doc-42")
        XCTAssertEqual(deleted, 2)
        XCTAssertEqual(session.requests[0].httpMethod, "DELETE")
        XCTAssertEqual(session.requests[0].url?.absoluteString, "http://mac.local:7600/documents/doc-42")
    }

    func testDeleteDocumentCopyOnlyAsksTheGatewayToSkipTheTombstone() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"deleted\":1}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        _ = try await client.deleteDocument(id: "doc-42", keepCopy: true)
        XCTAssertEqual(session.requests[0].httpMethod, "DELETE")
        XCTAssertEqual(
            session.requests[0].url?.absoluteString,
            "http://mac.local:7600/documents/doc-42?tombstone=0"
        )
    }

    func testDeleteDocumentMapsForbiddenToError() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 403, body: "{\"error\":\"forbidden\"}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        do {
            _ = try await client.deleteDocument(id: "doc-42")
            XCTFail("expected a thrown error for 403")
        } catch {
            // A read-only token must surface, not silently succeed.
        }
    }

    // MARK: - /status on-disk size

    func testStatusOnDiskPrefersTheWholeFootprint() throws {
        let status = try decodeStatus("""
        { "documents": { "total": 5, "bySource": {} }, "dbSizeBytes": 1000,
          "diskUsage": { "totalBytes": 3000, "measuredAt": "2026-06-04T10:00:00.000Z",
                         "stores": [{ "id": "documents", "label": "Main database", "bytes": 1000 }] } }
        """)
        XCTAssertEqual(status.dbSizeBytes, 1000)
        XCTAssertEqual(status.onDiskBytes, 3000)
    }

    func testStatusOnDiskFallsBackToTheMainDatabase() throws {
        let older = try decodeStatus("""
        { "documents": { "total": 5, "bySource": {} }, "dbSizeBytes": 1000 }
        """)
        XCTAssertEqual(older.onDiskBytes, 1000)
        let measuring = try decodeStatus("""
        { "documents": { "total": 5, "bySource": {} }, "dbSizeBytes": 1000, "diskUsage": null }
        """)
        XCTAssertEqual(measuring.onDiskBytes, 1000)
    }

    // MARK: - /status experimental flag

    private func decodeStatus(_ body: String) throws -> StatusSnapshot {
        try JSONDecoder().decode(StatusSnapshot.self, from: Data(body.utf8))
    }

    func testStatusDecodesExperimentalTrue() throws {
        let status = try decodeStatus("""
        { "documents": { "total": 5, "bySource": {} }, "experimental": true }
        """)
        XCTAssertTrue(status.experimental)
    }

    func testStatusDecodesExperimentalFalse() throws {
        let status = try decodeStatus("""
        { "documents": { "total": 5, "bySource": {} }, "experimental": false }
        """)
        XCTAssertFalse(status.experimental)
    }

    /// An older gateway that predates the flag omits it entirely — the decode
    /// must succeed and default `experimental` to false (so experimental UI
    /// stays hidden) rather than throwing.
    func testStatusDefaultsExperimentalToFalseWhenAbsent() throws {
        let status = try decodeStatus("""
        { "documents": { "total": 5, "bySource": {} } }
        """)
        XCTAssertFalse(status.experimental)
    }

    // MARK: - createDevAnnotation()

    func testCreateDevAnnotationSendsPlatformAndAppVersion() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 201, body: "{}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        try await client.createDevAnnotation(
            targetType: "document",
            targetId: "doc-1",
            note: "Sender name mis-parsed.",
            contextLabel: "Re: Q4 budget review",
            appVersion: "1.2.3",
            appBuild: "456"
        )
        let req = session.requests[0]
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString, "http://mac.local:7600/dev/annotations")
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any]
        )
        XCTAssertEqual(json["targetType"] as? String, "document")
        XCTAssertEqual(json["targetId"] as? String, "doc-1")
        XCTAssertEqual(json["client"] as? String, "ios")
        let context = try XCTUnwrap(json["context"] as? [String: String])
        XCTAssertEqual(context["platform"], "ios")
        XCTAssertEqual(context["label"], "Re: Q4 budget review")
        XCTAssertEqual(context["appVersion"], "1.2.3")
        XCTAssertEqual(context["appBuild"], "456")
    }

    func testCreateDevAnnotationOmitsAbsentVersionKeys() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 201, body: "{}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        try await client.createDevAnnotation(
            targetType: "route",
            targetId: nil,
            note: "General note.",
            contextLabel: nil
        )
        let req = session.requests[0]
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString, "http://mac.local:7600/dev/annotations")
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any]
        )
        let context = try XCTUnwrap(json["context"] as? [String: String])
        XCTAssertEqual(context["platform"], "ios")
        XCTAssertNil(context["label"])
        XCTAssertNil(context["appVersion"])
        XCTAssertNil(context["appBuild"])
    }

    func testCreateDevAnnotationOmitsEmptyVersionKeys() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 201, body: "{}", url: req.url!)
        }
        let client = SearchClient(baseURL: base, token: "omn_t", session: session)
        try await client.createDevAnnotation(
            targetType: "route",
            targetId: nil,
            note: "General note.",
            contextLabel: "iOS app",
            appVersion: "",
            appBuild: ""
        )
        let req = session.requests[0]
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any]
        )
        let context = try XCTUnwrap(json["context"] as? [String: String])
        XCTAssertEqual(context["platform"], "ios")
        XCTAssertEqual(context["label"], "iOS app")
        XCTAssertNil(context["appVersion"])
        XCTAssertNil(context["appBuild"])
    }
}
