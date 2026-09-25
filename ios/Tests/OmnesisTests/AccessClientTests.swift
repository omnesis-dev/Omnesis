// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessClientTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var responseBody = "{}"
        var status = 200

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(responseBody.utf8), response)
        }
    }

    private let baseURL = URL(string: "https://gateway.example")!

    func testLookupUsesPairedBearerAndCodeOnly() async throws {
        let session = MockSession()
        session.responseBody = """
        {"request":{"id":"request-example","approvalId":"approval-example","status":"pending",
        "clientId":"client-example","clientName":"Fictional Agent","clientUri":null,
        "redirectOrigin":"http://127.0.0.1:8765","resource":"https://gateway.example/mcp",
        "scope":"omnesis:access","expiresAt":1800000000000,"requiresAnswer":false}}
        """

        let envelope = try await AccessClient(
            baseURL: baseURL,
            token: "omn_device_example",
            session: session
        ).lookup(code: "ABCD-EFGH")

        XCTAssertEqual(envelope.request.clientName, "Fictional Agent")
        XCTAssertNil(envelope.reconnect)
        let sent = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(sent.url?.path, "/admin/access/authorizations/lookup")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer omn_device_example")
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: XCTUnwrap(sent.httpBody)) as? [String: String],
            ["code": "ABCD-EFGH"]
        )
    }

    /// A request the overview lists as waiting is read by its id, with the
    /// same envelope the code lookup returns and nothing in the body.
    func testLookupByIdReadsTheRequestRouteWithoutABody() async throws {
        let session = MockSession()
        session.responseBody = """
        {"request":{"id":"request-example","approvalId":"approval-example","status":"pending",
        "clientId":"client-example","clientName":"Fictional Agent","clientUri":null,
        "redirectOrigin":"http://127.0.0.1:8765","resource":"https://gateway.example/mcp",
        "scope":"omnesis:access","expiresAt":1800000000000,"requiresAnswer":false},"reconnect":null}
        """

        let envelope = try await AccessClient(
            baseURL: baseURL,
            token: "omn_device_example",
            session: session
        ).lookup(id: "request example")

        XCTAssertEqual(envelope.request.id, "request-example")
        XCTAssertNil(envelope.reconnect)
        let sent = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(sent.httpMethod, "GET")
        XCTAssertEqual(sent.url?.path, "/admin/access/authorizations/request example")
        XCTAssertEqual(sent.url?.absoluteString, "https://gateway.example/admin/access/authorizations/request%20example")
        XCTAssertNil(sent.httpBody)
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer omn_device_example")
    }

    /// A request that stopped waiting is a `notFound`, distinct from a fault.
    func testLookupByIdOfARequestNoLongerPendingIsNotFound() async {
        let session = MockSession()
        session.status = 404
        session.responseBody = #"{"error":"not-found"}"#
        let client = AccessClient(baseURL: baseURL, token: "omn_device_example", session: session)

        do {
            _ = try await client.lookup(id: "request-gone")
            XCTFail("Expected the missing request to be refused")
        } catch let error as GatewayClient.Error {
            guard case .notFound = error else { return XCTFail("Expected notFound, got \(error)") }
        } catch {
            XCTFail("Expected a gateway error, got \(error)")
        }
    }

    func testDecisionEncodesTheSharedNestedGrantRule() async throws {
        let session = MockSession()
        let client = AccessClient(
            baseURL: baseURL,
            token: "omn_device_example",
            session: session
        )
        let selection = AccessAuthorizationSelection.connect(
            rules: [
                .direct(
                    sources: AccessSourceBoundary(
                        mode: .allowlist,
                        sourceIds: ["github:maya-reeves"]
                    )
                ),
                .answer(
                    sources: AccessSourceBoundary(mode: .denylist, sourceIds: []),
                    release: .reviewed(policyFamilyId: "policy-work-safe")
                ),
            ],
            credentialLabel: "Development agent"
        )

        try await client.decide(
            approvalId: "approval-example",
            decision: .approve(selection)
        )

        let sent = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(
            sent.url?.path,
            "/admin/access/authorizations/approval-example/decision"
        )
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(sent.httpBody)) as? [String: Any]
        )
        XCTAssertEqual(object["decision"] as? String, "approve")
        let encodedSelection = try XCTUnwrap(object["selection"] as? [String: Any])
        XCTAssertEqual(encodedSelection["kind"] as? String, "connect")
        let rules = try XCTUnwrap(encodedSelection["rules"] as? [[String: Any]])
        XCTAssertEqual((rules[0]["sources"] as? [String: Any])?["mode"] as? String, "allowlist")
        XCTAssertEqual((rules[1]["release"] as? [String: Any])?["mode"] as? String, "reviewed")
    }

    func testOverviewDecodesCanonicalGatewayGrantRules() async throws {
        let session = MockSession()
        session.responseBody = """
        {"sources":[{"id":"github:maya-reeves","name":"GitHub — Work","icon":null,"available":true}],
        "policyFamilies":[{"id":"policy-work-safe","name":"Work safe","revision":"rev-1"}],
        "defaultPolicyFamilyId":"policy-work-safe","principals":[{"id":"principal-example",
        "name":"Development agent","kind":"interactive","createdAt":1,"updatedAt":1,"revokedAt":null,
        "grants":[{"id":"grant-example","principalId":"principal-example","name":"Coding access",
        "revision":2,"capabilities":[],"rules":[{"capability":"direct","sources":{"mode":"allowlist",
        "sourceIds":["github:maya-reeves"]}},{"capability":"answer","sources":{"mode":"denylist",
        "sourceIds":[]},"release":{"mode":"reviewed","policyFamilyId":"policy-work-safe"}}],
        "createdAt":1,"updatedAt":2,"expiresAt":null,"revokedAt":null,"credentials":[]}]}]}
        """

        let overview = try await AccessClient(
            baseURL: baseURL,
            token: "omn_device_example",
            session: session
        ).overview()

        XCTAssertEqual(overview.principals.first?.grants.first?.rules, [
            .direct(
                sources: AccessSourceBoundary(
                    mode: .allowlist,
                    sourceIds: ["github:maya-reeves"]
                )
            ),
            .answer(
                sources: AccessSourceBoundary(mode: .denylist, sourceIds: []),
                release: .reviewed(policyFamilyId: "policy-work-safe")
            ),
        ])
        XCTAssertEqual(session.requests.first?.url?.path, "/admin/access")
    }

    func testDenialContainsNoGrantMaterial() async throws {
        let session = MockSession()
        let client = AccessClient(baseURL: baseURL, token: "omn_device_example", session: session)

        try await client.decide(approvalId: "approval-example", decision: .deny)

        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(
                with: XCTUnwrap(session.requests.first?.httpBody)
            ) as? [String: Any]
        )
        XCTAssertEqual(object["decision"] as? String, "deny")
        XCTAssertNil(object["selection"])
    }

    func testDecisionPreservesMachineReadableAuthorizationConflict() async throws {
        let session = MockSession()
        session.status = 409
        session.responseBody = #"{"error":"already-decided"}"#
        let client = AccessClient(baseURL: baseURL, token: "omn_device_example", session: session)

        do {
            try await client.decide(approvalId: "approval-example", decision: .deny)
            XCTFail("Expected the completed authorization to conflict")
        } catch let error as GatewayClient.Error {
            XCTAssertEqual(error.gatewayMessage, "already-decided")
        }
    }
}
