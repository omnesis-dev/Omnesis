// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class LabCompatibilityTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let data = Data(#"""
            {"experimental":true,"features":[
              {"id":"future/feature","name":"Future feature","description":"New experiment.","enabled":false}
            ]}
            """#.utf8)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (data, response)
        }
    }

    func testCatalogAcceptsFutureExperimentAndEscapesItsIdentifier() async throws {
        let session = Session()
        let client = try AdminClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.com")), token: "omn_example", session: session)
        let snapshot = try await client.getLab()
        XCTAssertEqual(snapshot.features.first?.id, "future/feature")
        _ = try await client.setLabFeature("future/feature", enabled: true)
        XCTAssertEqual(session.requests.last?.url?.absoluteString, "https://gateway.example.com/admin/lab/future%2Ffeature")
    }

    func testFlagsDefaultEachMissingKeyToFalse() throws {
        let empty = try JSONDecoder().decode(LabFlags.self, from: Data("{}".utf8))
        XCTAssertFalse(empty.brain)
        XCTAssertFalse(empty.tasks)
        XCTAssertFalse(empty.watches)
        let partial = try JSONDecoder().decode(LabFlags.self, from: Data(#"{"tasks":true,"future":true}"#.utf8))
        XCTAssertFalse(partial.brain)
        XCTAssertTrue(partial.tasks)
        XCTAssertFalse(partial.watches)
    }

    private func status(_ fields: [String: Any] = [:]) throws -> StatusSnapshot {
        var payload = fields
        payload["documents"] = ["total": 0, "bySource": [String: Int]()] as [String: Any]
        return try JSONDecoder().decode(StatusSnapshot.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    func testLegacyStatusRetainsItsAdvertisedSurfacesWithoutOfferingLab() throws {
        for experimental in [false, true] {
            let snapshot = try status(["experimental": experimental, "tasks": ["available": true]])
            XCTAssertNil(snapshot.lab)
            XCTAssertTrue(snapshot.tasksAvailable, "Legacy stable gateways also serve Tasks")
            XCTAssertEqual(snapshot.brainEnabled, experimental)
            XCTAssertEqual(snapshot.watchesEnabled, experimental)
            XCTAssertFalse(snapshot.labAvailable)
        }
        let older = try status()
        XCTAssertFalse(older.tasksAvailable)
        XCTAssertFalse(older.brainEnabled)
        XCTAssertFalse(older.watchesEnabled)
        XCTAssertFalse(older.labAvailable)
    }

    func testExplicitLabOptOutsOverrideLegacyExperimentalAndTasksAdvertisements() throws {
        let snapshot = try status([
            "experimental": true, "tasks": ["available": true], "labAvailable": true,
            "lab": ["brain": false, "tasks": false, "watches": false],
        ])
        XCTAssertFalse(snapshot.tasksAvailable)
        XCTAssertFalse(snapshot.brainEnabled)
        XCTAssertFalse(snapshot.watchesEnabled)
        XCTAssertTrue(snapshot.labAvailable)
        let partial = try status(["experimental": true, "tasks": ["available": true], "lab": ["tasks": true]])
        XCTAssertTrue(partial.tasksAvailable)
        XCTAssertFalse(partial.brainEnabled)
        XCTAssertFalse(partial.watchesEnabled)
        let unavailable = try status(["tasks": ["available": false], "lab": ["tasks": true]])
        XCTAssertFalse(unavailable.tasksAvailable)
    }

    func testPresentUnreadableLabDoesNotFallBackToLegacyEnabledState() throws {
        let unreadable: [Any] = [NSNull(), false, ["tasks": "invalid"]]
        for lab in unreadable {
            let snapshot = try status(["experimental": true, "tasks": ["available": true], "lab": lab])
            XCTAssertNotNil(snapshot.lab)
            XCTAssertFalse(snapshot.tasksAvailable)
            XCTAssertFalse(snapshot.brainEnabled)
            XCTAssertFalse(snapshot.watchesEnabled)
        }
    }
}
