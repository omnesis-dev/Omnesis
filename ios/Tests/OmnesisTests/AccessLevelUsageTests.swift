// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Who an access level reaches, and deleting one: the overview's integrations
/// on the wire, the impact a review names, and how a refused deletion reads.
final class AccessLevelUsageTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var responseBody = "{}"
        var status = 200

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data(responseBody.utf8), response)
        }
    }

    private let overviewJSON = """
    {"principals":[
    {"id":"principal-desk","name":"Northstar desk","kind":"interactive","revokedAt":null,
    "grants":[{"id":"grant-desk","name":"Northstar desk access","revision":1,"rules":[],"credentials":[],
    "expiresAt":null,"revokedAt":null,"levelId":"level-research"}]},
    {"id":"principal-atlas","name":"Atlas notebook","kind":"interactive","revokedAt":null,
    "grants":[{"id":"grant-atlas","name":"Atlas notebook access","revision":1,"rules":[],"credentials":[],
    "expiresAt":null,"revokedAt":null,"levelId":"level-research"},
    {"id":"grant-atlas-old","name":"Atlas notebook access","revision":1,"rules":[],"credentials":[],
    "expiresAt":null,"revokedAt":1800000000000,"levelId":"level-research"}]},
    {"id":"principal-gone","name":"Retired helper","kind":"interactive","revokedAt":1800000000000,
    "grants":[{"id":"grant-gone","name":"Retired helper access","revision":1,"rules":[],"credentials":[],
    "expiresAt":null,"revokedAt":null,"levelId":"level-research"}]},
    {"id":"principal-other","name":"Studio reader","kind":"interactive","revokedAt":null,
    "grants":[{"id":"grant-other","name":"Studio reader access","revision":1,"rules":[],"credentials":[],
    "expiresAt":null,"revokedAt":null,"levelId":"level-notes"}]}],
    "sources":[],"policyFamilies":[],
    "levels":[
    {"id":"level-research","name":"Research assistants","revision":2,"connectionCount":2,
    "devices":[{"id":"device-harness","name":"Riverside harness","kind":"agent"}],
    "createdAt":1800000000000,"updatedAt":1800000600000,"rules":[]},
    {"id":"level-notes","name":"Notes only","revision":1,"connectionCount":1,
    "createdAt":1800000000000,"updatedAt":1800000600000,"rules":[]},
    {"id":"level-harness","name":"Harness only","revision":1,"connectionCount":0,
    "devices":[{"id":"device-second","name":"Stellar harness","kind":"agent"}],
    "createdAt":1800000000000,"updatedAt":1800000600000,"rules":[]},
    {"id":"level-unused","name":"Unused","revision":1,"connectionCount":0,"devices":[],
    "createdAt":1800000000000,"updatedAt":1800000600000,"rules":[]}]}
    """

    private func usage(_ levelId: String) throws -> AccessLevelUsage {
        let overview = try JSONDecoder().decode(AccessOverview.self, from: Data(overviewJSON.utf8))
        return try AccessLevelUsage(level: XCTUnwrap(overview.levels.first { $0.id == levelId }), overview: overview)
    }

    func testLevelDecodesItsIntegrationsAndReadsTheirAbsenceAsUnreported() throws {
        let overview = try JSONDecoder().decode(AccessOverview.self, from: Data(overviewJSON.utf8))
        XCTAssertEqual(overview.levels[0].devices, [.init(id: "device-harness", name: "Riverside harness", kind: "agent")])
        XCTAssertNil(overview.levels[1].devices)
        XCTAssertEqual(overview.levels[3].devices, [])
    }

    func testImpactNamesLiveConnectionsOnTheLevelAndItsIntegrations() throws {
        let research = try usage("level-research")
        XCTAssertEqual(research.connections, ["Atlas notebook", "Northstar desk"])
        XCTAssertEqual(research.integrations, ["Riverside harness"])
        XCTAssertTrue(research.inUse)
        XCTAssertEqual(try usage("level-notes").connections, ["Studio reader"])
        XCTAssertEqual(try usage("level-harness").integrations, ["Stellar harness"])
        XCTAssertTrue(try usage("level-harness").inUse)
        XCTAssertFalse(try usage("level-unused").inUse)
    }

    func testDeletionIsHeldBackWithWhatToMoveWhileTheLevelIsInUse() throws {
        XCTAssertEqual(try usage("level-research").deletionBlock, "Move its connections and integrations off it first.")
        XCTAssertEqual(try usage("level-notes").deletionBlock, "Move or remove its connections first.")
        XCTAssertEqual(try usage("level-harness").deletionBlock, "Move its integrations to another access level first.")
        XCTAssertNil(try usage("level-unused").deletionBlock)
    }

    func testRefusedDeletionReadsAsWhatToDoAndAMissingLevelNeedsNoMessage() {
        let inUse = GatewayClient.Error.serverError(status: 409, body: #"{"error":"level-in-use"}"#)
        XCTAssertEqual(accessLevelDeletionFailureMessage(inUse), "Move its connections and integrations off it first.")
        XCTAssertNil(accessLevelDeletionFailureMessage(GatewayClient.Error.notFound))
        XCTAssertEqual(accessLevelDeletionFailureMessage(GatewayClient.Error.forbidden), "The access level could not be deleted.")
        XCTAssertEqual(
            accessLevelDeletionFailureMessage(GatewayClient.Error.serverError(status: 500, body: #"{"error":"level-in-use"}"#)),
            "The access level could not be deleted."
        )
    }

    func testDeleteLevelSendsDeleteToTheEncodedLevelAndSurfacesTheRefusal() async throws {
        let session = MockSession()
        session.responseBody = #"{"removed":true}"#
        let client = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example")),
            token: "omn_device_example",
            session: session
        )
        try await client.deleteLevel(id: "level research")
        let sent = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(sent.httpMethod, "DELETE")
        XCTAssertEqual(sent.url?.absoluteString, "https://gateway.example/admin/access/levels/level%20research")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer omn_device_example")
        XCTAssertNil(sent.httpBody)

        session.status = 409
        session.responseBody = #"{"error":"level-in-use"}"#
        do {
            try await client.deleteLevel(id: "level-research")
            XCTFail("A level in use must not read as deleted")
        } catch {
            XCTAssertEqual(accessLevelMutationCode(error), "level-in-use")
        }
    }
}
