// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The store's Resync against the gateway it is paired with: a gateway
/// whose listing names resync modes gets the chosen mode in one request,
/// and one that names none gets the delete and the sync, from scratch only.
@available(iOS 17.0, *)
@MainActor
final class AdminCoordinatorResyncTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        let listing: String
        var requests: [URLRequest] = []

        init(listing: String) {
            self.listing = listing
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let body = request.url?.path == "/admin/sources"
                ? listing
                : #"{"ok":true,"deleted":0,"items":[],"pageInfo":{"hasMore":false,"limit":0}}"#
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }

        /// The mutating requests sent so far, as `METHOD path`.
        var writes: [String] {
            requests.filter { $0.httpMethod != "GET" }.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }
        }
    }

    private let sourceId = "gmail:maya.reeves@example.org"

    private func coordinator(resyncModes: String) async -> (AdminCoordinator, MockSession) {
        let session = MockSession(listing: """
        {"items":[{"id":"\(sourceId)","type":"gmail","accountId":"maya.reeves@example.org",
        "deviceId":"dev_1","config":{},"enabled":true,"createdAt":0,"updatedAt":0\(resyncModes)}],
        "pageInfo":{"hasMore":false,"limit":1}}
        """)
        let coord = AdminCoordinator()
        coord.injectAdminClientForTesting(
            AdminClient(baseURL: URL(string: "https://stub.local")!, token: "t", session: session)
        )
        await coord.refreshSources()
        return (coord, session)
    }

    func testGatewayWithModesIsSentTheChosenMode() async throws {
        let (coord, session) = await coordinator(resyncModes: #","resyncModes":["in-place","from-scratch"]"#)
        try await coord.resync(sourceId: sourceId, mode: .inPlace)
        XCTAssertEqual(session.writes, ["POST /admin/sources/\(sourceId)/resync"])
        let sent = try XCTUnwrap(session.requests.last?.httpBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: sent) as? [String: String], ["mode": "in-place"])
    }

    func testOlderGatewayIsSentTheDeleteThenTheSync() async throws {
        let (coord, session) = await coordinator(resyncModes: "")
        try await coord.resync(sourceId: sourceId, mode: .fromScratch)
        XCTAssertEqual(
            session.writes,
            ["POST /documents/delete-all/source/\(sourceId)", "POST /admin/sources/\(sourceId)/sync"]
        )
    }

    func testOlderGatewayIsNeverAskedToResyncInPlace() async {
        let (coord, session) = await coordinator(resyncModes: "")
        do {
            try await coord.resync(sourceId: sourceId, mode: .inPlace)
            XCTFail("a gateway without resync modes would delete instead")
        } catch {
            XCTAssertEqual(error as? SourceResyncError, .notOffered)
        }
        XCTAssertEqual(session.writes, [])
    }

    func testSourceThatCannotBeResyncedIsSentNothing() async {
        let (coord, session) = await coordinator(resyncModes: #","resyncModes":[]"#)
        do {
            try await coord.resync(sourceId: sourceId, mode: .fromScratch)
            XCTFail("a source offering no mode must be refused")
        } catch {
            XCTAssertEqual(error as? SourceResyncError, .notOffered)
        }
        XCTAssertEqual(session.writes, [])
    }
}
