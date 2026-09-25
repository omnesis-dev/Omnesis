// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Mobile consumes each policy as a read-only Markdown document.
final class PrivacyPolicyClientTests: PrivacyClientTestCase {
    /// A grant names one policy family, and the review it is judged against is
    /// that family's document.
    func testGetPolicyFamilyAddressesTheNamedFamily() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: "{\"policy\":\"# Work-safe\",\"revision\":\"policy-version-3\",\"updatedAt\":1786851000000}"
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let document = try await client.getPolicyFamily(id: "policy work/safe")

        XCTAssertEqual(document.policy, "# Work-safe")
        XCTAssertEqual(document.revision, "policy-version-3")
        XCTAssertEqual(
            session.requests.first?.url?.absoluteString,
            "http://gateway.example:7600/admin/privacy/policies/policy%20work%2Fsafe"
        )
        XCTAssertEqual(
            session.requests.first?.value(forHTTPHeaderField: "Authorization"),
            "Bearer omn_test"
        )
        XCTAssertEqual(session.requests.first?.value(forHTTPHeaderField: "Cache-Control"), "no-store")
        XCTAssertEqual(session.requests.first?.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
    }

    /// The catalogue names every family, retired ones included, without any
    /// text. `archivedAt` is the one field the gateway sends as an explicit
    /// null on a live family.
    func testListPolicyFamiliesDecodesTheWholeCatalogue() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"policies":[
                {"id":"00000000-0000-4000-8000-000000000001","name":"Household",
                "currentRevision":"rev_household_0a1b2c3d4e5f6a7b","currentVersion":2,
                "updatedAt":1786851000000,"archivedAt":null,"affectedGrantIds":["grant-1","grant-2"]},
                {"id":"policy-old-desk","name":"Old desk","currentRevision":"rev_old","currentVersion":1,
                "updatedAt":1786800000000,"archivedAt":1786840000000,"affectedGrantIds":[]}
                ]}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let families = try await client.listPolicyFamilies()

        XCTAssertEqual(families.map(\.id), ["00000000-0000-4000-8000-000000000001", "policy-old-desk"])
        XCTAssertEqual(families[0].name, "Household")
        XCTAssertEqual(families[0].currentRevision, "rev_household_0a1b2c3d4e5f6a7b")
        XCTAssertEqual(families[0].currentVersion, 2)
        XCTAssertNil(families[0].archivedAt)
        XCTAssertEqual(families[0].affectedGrantIds, ["grant-1", "grant-2"])
        XCTAssertEqual(families[1].archivedAt, 1_786_840_000_000)
        XCTAssertEqual(families[1].affectedGrantIds, [])
        XCTAssertEqual(
            session.requests.first?.url?.absoluteString,
            "http://gateway.example:7600/admin/privacy/policies"
        )
        XCTAssertEqual(
            session.requests.first?.value(forHTTPHeaderField: "Authorization"),
            "Bearer omn_test"
        )
        XCTAssertEqual(session.requests.first?.value(forHTTPHeaderField: "Cache-Control"), "no-store")
    }

    /// A family id is one path segment: a slash inside it must not be able to
    /// address a different route.
    func testGetPolicyFamilyRejectsATraversingId() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: "{\"policy\":\"x\",\"revision\":\"r\",\"updatedAt\":null}")
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        _ = try await client.getPolicyFamily(id: "../approvals")

        XCTAssertEqual(
            session.requests.first?.url?.absoluteString,
            "http://gateway.example:7600/admin/privacy/policies/..%2Fapprovals"
        )
    }
}
