// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class GatewayPairingApprovalHTTPTests: XCTestCase {
    func testPairedAdminListAndDecisionsUseSameBearerGenerationAndCanonicalOrigin() async throws {
        let session = ApprovalHTTPSession()
        let client = try AdminClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")),
            token: "synthetic-token",
            pairingGeneration: "synthetic-generation",
            session: session
        )
        let rows = try await client.pairingApprovalRequests()
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].verificationCode, "465 774")
        try await client.decidePairingApproval(requestId: rows[0].id, approve: true)
        try await client.decidePairingApproval(requestId: rows[0].id, approve: false)
        let requests = session.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "POST", "POST"])
        XCTAssertEqual(
            requests.map { $0.url?.path },
            ["/admin/cloud-pairing/requests", "/admin/cloud-pairing/decision", "/admin/cloud-pairing/decision"]
        )
        for request in requests {
            XCTAssertEqual(request.url?.host, "gateway.example.test")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Omnesis-Pairing-Generation"), "synthetic-generation")
        }
        for (request, expected) in zip(requests.dropFirst(), [true, false]) {
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
            XCTAssertEqual(object["requestId"] as? String, rows[0].id)
            XCTAssertEqual(object["approve"] as? Bool, expected)
        }
    }

    func testTrustingASignInIsSentOnlyWhenChosen() async throws {
        let session = ApprovalHTTPSession()
        let client = try AdminClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")),
            token: "synthetic-token",
            session: session
        )
        let id = "00000000-0000-4000-8000-000000000901"
        try await client.decidePairingApproval(requestId: id, approve: true)
        try await client.decidePairingApproval(requestId: id, approve: true, trustSignIn: true)
        let bodies = try session.requests.map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap($0.httpBody)) as? [String: Any])
        }
        XCTAssertNil(bodies[0]["trustSignIn"])
        XCTAssertEqual(bodies[1]["trustSignIn"] as? Bool, true)
    }

    private final class ApprovalHTTPSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var response: String?
        var status = 200
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let fixture = request.httpMethod == "GET" ?
                #"{"items":[{"requestId":"00000000-0000-4000-8000-000000000901","kind":"ios","name":"Test phone","#
                + #""status":"pending","verificationCode":"465 774","expiresAt":1100000}]}"# :
                #"{"ok":true}"#
            let body = response ?? fixture
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }
}
