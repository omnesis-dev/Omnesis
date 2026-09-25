// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class GatewayClientTests: XCTestCase {
    // MARK: - Mock URLSession

    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var responder: ((URLRequest) throws -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            guard let responder else {
                throw GatewayClient.Error.invalidResponse
            }
            return try responder(request)
        }
    }

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

    // MARK: - Tests

    func testHealthProbeReturnsTrue() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true,\"status\":\"ok\"}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)
        let ok = try await client.health()
        XCTAssertTrue(ok)
        XCTAssertEqual(session.requests.count, 1)
        XCTAssertEqual(session.requests[0].url?.absoluteString, "http://mac.local:7600/health")
        XCTAssertEqual(session.requests[0].httpMethod, "GET")
        XCTAssertNil(session.requests[0].value(forHTTPHeaderField: "Authorization"))
    }

    func testAnalyticsIngestSendsSchemaAndRecords() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ingested\":2}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)

        let schema = AnalyticsTableSchema(
            tableName: "health_body",
            displayName: "Body metrics",
            description: "",
            columns: [
                ColumnDefinition(name: "id", type: .varchar, description: ""),
                ColumnDefinition(name: "value", type: .double, description: ""),
            ],
            primaryKey: ["id"]
        )
        let records: [[String: JSONValue]] = [
            ["id": .string("uuid-1"), "value": .double(74.8)],
            ["id": .string("uuid-2"), "value": .double(75.1)],
        ]
        let response = try await client.ingestAnalyticsRecords(
            tableName: "health_body",
            records: records,
            schema: schema,
            sourceId: "apple-health:local",
            deletedIds: ["uuid-removed"]
        )
        XCTAssertEqual(response.ingested, 2)

        XCTAssertEqual(session.requests.count, 1)
        let sent = session.requests[0]
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.url?.absoluteString, "http://mac.local:7600/analytics/ingest")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer omn_test")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Content-Type"), "application/json")

        // The body round-trip should decode back to the same request shape.
        let body = try XCTUnwrap(sent.httpBody)
        let decoded = try JSONDecoder().decode(DecodableAnalyticsIngest.self, from: body)
        XCTAssertEqual(decoded.tableName, "health_body")
        XCTAssertEqual(decoded.sourceId, "apple-health:local")
        XCTAssertEqual(decoded.schema?.tableName, "health_body")
        XCTAssertEqual(decoded.records.count, 2)
        XCTAssertEqual(decoded.deletedIds, ["uuid-removed"])
    }

    func testAuthedPingHitsStatusWithBearer() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)
        try await client.authedPing()
        XCTAssertEqual(session.requests.count, 1)
        XCTAssertEqual(session.requests[0].url?.absoluteString, "http://mac.local:7600/status")
        XCTAssertEqual(
            session.requests[0].value(forHTTPHeaderField: "Authorization"),
            "Bearer omn_test"
        )
    }

    func testAuthedPingThrowsOn401() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 401, body: "{\"error\":\"Unauthorized\"}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_bad", session: session)
        do {
            try await client.authedPing()
            XCTFail("Expected throw")
        } catch GatewayClient.Error.unauthorized {
            // ok
        } catch {
            XCTFail("Expected unauthorized, got \(error)")
        }
    }

    func testUnauthorizedBecomesError() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 401, body: "{\"error\":\"Unauthorized\"}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_bad", session: session)
        do {
            _ = try await client.health()
            XCTFail("Expected throw")
        } catch GatewayClient.Error.unauthorized {
            // ok
        } catch {
            XCTFail("Expected unauthorized, got \(error)")
        }
    }

    func testGetSyncStateReturnsNilOn404() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 404, body: "", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)
        let state = try await client.getSyncState(sourceId: "apple-health:local")
        XCTAssertNil(state)
    }

    func testSetSyncStatePostsCursor() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)
        try await client.setSyncState(
            sourceId: "apple-health:local",
            cursor: ["anchor": .string("opaque-123")],
            label: "iPhone"
        )
        XCTAssertEqual(session.requests.count, 1)
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        // The `:` in the sourceId may be percent-encoded (%3A) — Hono decodes
        // both forms identically, so accept either.
        let sent = session.requests[0].url?.absoluteString ?? ""
        XCTAssertTrue(
            sent == "http://mac.local:7600/sync-state/apple-health:local"
                || sent == "http://mac.local:7600/sync-state/apple-health%3Alocal",
            "Unexpected URL: \(sent)"
        )
    }

    /// A phone-hosted source has no provider package, so what the phone puts
    /// on this request is the whole of its type's declared identity. A field
    /// that never reaches the body leaves a client grouping by type with the
    /// raw id to show.
    func testSetSyncStateSendsTheFamilyIdentityItWasGiven() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)

        try await client.setSyncState(
            sourceId: "photos:local",
            cursor: ["page": .string("c1")],
            label: "Photos",
            icon: "data:image/svg+xml;base64,QUJD",
            family: SourceFamilyDescriptor(
                icon: "data:image/svg+xml;base64,QUJD",
                label: "Photos"
            )
        )

        let body = try XCTUnwrap(session.requests[0].httpBody)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(json["label"] as? String, "Photos")
        XCTAssertEqual(json["icon"] as? String, "data:image/svg+xml;base64,QUJD")
        let family = try XCTUnwrap(json["family"] as? [String: Any])
        XCTAssertEqual(family["label"] as? String, "Photos")
        XCTAssertEqual(family["icon"] as? String, "data:image/svg+xml;base64,QUJD")
    }

    /// A source that declares nothing sends no family at all, rather than an
    /// empty one the gateway would have to distinguish from a real value.
    func testSetSyncStateOmitsTheFamilyWhenNoneIsDeclared() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)

        try await client.setSyncState(sourceId: "photos:local", cursor: [:])

        let body = try XCTUnwrap(session.requests[0].httpBody)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertNil(json["family"])
    }

    func testClaimSyncLeasePostsToSourceLeaseEndpoint() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: "{\"granted\":true,\"holder\":\"device-1\",\"expiresAt\":1234}",
                url: req.url!
            )
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)

        let claimed = try await client.claimSyncLease(sourceId: "apple-health:local")
        let lease = try XCTUnwrap(claimed)

        XCTAssertTrue(lease.granted)
        XCTAssertEqual(lease.holder, "device-1")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(session.requests.count, 1)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertTrue(request.url?.path.hasSuffix("/sync-state/apple-health:local/lease") == true)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_test")
    }

    func testDeleteDocumentsPostsNaturalKey() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"deleted\":2}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)
        let response = try await client.deleteDocuments(
            providerId: "photos:local",
            sourceId: "photos:local",
            externalIds: ["asset-1", "asset-2"]
        )
        XCTAssertEqual(response.deleted, 2)
        XCTAssertTrue(response.rejected.isEmpty)

        XCTAssertEqual(session.requests.count, 1)
        let sent = session.requests[0]
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.url?.absoluteString, "http://mac.local:7600/documents/delete")
        let body = try XCTUnwrap(sent.httpBody)
        let decoded = try JSONDecoder().decode(DeleteDocumentsRequest.self, from: body)
        XCTAssertEqual(decoded.providerId, "photos:local")
        XCTAssertEqual(decoded.sourceId, "photos:local")
        XCTAssertEqual(decoded.externalIds, ["asset-1", "asset-2"])
    }

    func testReconcileDocumentsPostsPresentExternalIds() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"deleted\":1,\"deletedIds\":[\"asset-3\"]}", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)
        let result = try await client.reconcileDocuments(
            providerId: "photos:local",
            sourceId: "photos:local",
            presentExternalIds: ["asset-1", "asset-2"]
        )
        XCTAssertEqual(result.deleted, 1)
        XCTAssertEqual(result.deletedIds, ["asset-3"])

        XCTAssertEqual(session.requests.count, 1)
        let sent = session.requests[0]
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.url?.absoluteString, "http://mac.local:7600/documents/reconcile")
        let body = try XCTUnwrap(sent.httpBody)
        let decoded = try JSONDecoder().decode(ReconcileDocumentsRequest.self, from: body)
        XCTAssertEqual(decoded.presentExternalIds, ["asset-1", "asset-2"])
    }

    // MARK: - Error envelope

    /// A 4xx/5xx is thrown with the body exactly as the gateway wrote it, so
    /// `gatewayCode` can read the refusal code a caller branches on. Unwrap
    /// it here and the machine-readable half is gone by the time anything
    /// sees the error.
    func testServerErrorsCarryTheRawEnvelopeSoTheCodeSurvives() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        let envelope = #"{"error":"device dev_x is the last host","code":"LAST_MEMBER"}"#
        session.responder = { [weak self] req in
            self!.makeResponse(status: 409, body: envelope, url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)

        do {
            try await client.setSyncState(sourceId: "photos:local", cursor: ["page": .string("c1")])
            XCTFail("expected a server error")
        } catch let error as GatewayClient.Error {
            XCTAssertEqual(error, .serverError(status: 409, body: envelope))
            XCTAssertEqual(error.gatewayCode, "LAST_MEMBER")
            XCTAssertEqual(error.gatewayMessage, "device dev_x is the last host")
        }
    }

    /// A body that is not the envelope is carried verbatim too — a proxy's
    /// HTML is unhelpful, but nothing about it is made worse.
    func testANonEnvelopeBodyIsCarriedVerbatim() async throws {
        let session = MockSession()
        let base = try XCTUnwrap(URL(string: "http://mac.local:7600"))
        session.responder = { [weak self] req in
            self!.makeResponse(status: 502, body: "<html>Bad Gateway</html>", url: req.url!)
        }
        let client = GatewayClient(baseURL: base, token: "omn_test", session: session)

        do {
            try await client.setSyncState(sourceId: "photos:local", cursor: ["page": .string("c1")])
            XCTFail("expected a server error")
        } catch let error as GatewayClient.Error {
            XCTAssertEqual(error, .serverError(status: 502, body: "<html>Bad Gateway</html>"))
            XCTAssertNil(error.gatewayCode)
        }
    }
}

/// Helper shape for decoding the request body back for round-trip asserts.
extension GatewayClientTests {
    func testCursorRefreshFallsBackOnlyForOfflineTransportErrors() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.makeResponse(status: 200, body: "{\"cursor\":{\"page\":1}}", url: request.url!)
        }
        let client = try GatewayClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "test-token", session: session
        )
        let store = CursorStore(gateway: client)
        let original = try await store.load(for: "fictional:local", refresh: true)
        session.responder = { _ in throw URLError(.notConnectedToInternet) }
        let offline = try await store.load(for: "fictional:local", refresh: true)
        XCTAssertEqual(offline, original)
        for status in [401, 403, 409] {
            session.responder = { [weak self] request in
                self!.makeResponse(status: status, body: "{}", url: request.url!)
            }
            do {
                _ = try await store.load(for: "fictional:local", refresh: true)
                XCTFail("\(status) must not use a stale cached cursor")
            } catch {}
        }
        session.responder = { [weak self] request in
            self!.makeResponse(status: 200, body: "not-json", url: request.url!)
        }
        do {
            _ = try await store.load(for: "fictional:local", refresh: true)
            XCTFail("malformed cursor response must not become a reset or stale fallback")
        } catch {}
        session.responder = { [weak self] request in
            self!.makeResponse(status: 404, body: "{}", url: request.url!)
        }
        let reset = try await store.load(for: "fictional:local", refresh: true)
        XCTAssertNil(reset)
        let cached = try await store.load(for: "fictional:local")
        XCTAssertNil(cached)
    }
}

private struct DecodableAnalyticsIngest: Decodable {
    struct Schema: Decodable { let tableName: String }
    let tableName: String
    let records: [[String: JSONValue]]
    let sourceId: String
    let schema: Schema?
    let deletedIds: [String]?
}
