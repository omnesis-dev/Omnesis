// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Gateway-internal sources (quick-capture notes, …) on the iOS store:
/// a registered row of the same id always wins over the advertised
/// internal entry, and the mutating action paths refuse internal ids
/// before any round-trip.
@available(iOS 17.0, *)
@MainActor
final class AdminCoordinatorInternalSourcesTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var responder: ((URLRequest) -> (Data, URLResponse))?
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            guard let responder else { throw GatewayClient.Error.invalidResponse }
            return responder(request)
        }
    }

    private func makeClient() -> AdminClient {
        let session = MockSession()
        session.responder = { req in
            let path = req.url?.path ?? ""
            let body = if path == "/admin/sources" {
                """
                {"items":[{"id":"omnesis-notes","type":"omnesis-notes","accountId":"omnesis-notes",
                "deviceId":"dev_1","config":{},"enabled":true,"createdAt":0,"updatedAt":0}],
                "pageInfo":{"hasMore":false,"limit":1},
                "internalSources":[{"id":"omnesis-notes"},{"id":"example-internal"}]}
                """
            } else {
                #"{"items":[],"pageInfo":{"hasMore":false,"limit":0}}"#
            }
            let resp = HTTPURLResponse(
                url: req.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), resp)
        }
        return AdminClient(baseURL: URL(string: "https://stub.local")!, token: "t", session: session)
    }

    func testRegisteredRowWinsOverInternalEntry() async {
        let coord = AdminCoordinator()
        coord.injectAdminClientForTesting(makeClient())
        await coord.refreshSources()
        XCTAssertEqual(coord.internalSources, [InternalSource(id: "example-internal")])
        XCTAssertFalse(coord.isInternalSource("omnesis-notes"))
        XCTAssertTrue(coord.isInternalSource("example-internal"))
    }

    func testMutatingActionsRefuseInternalIds() async {
        let coord = AdminCoordinator()
        coord.injectAdminClientForTesting(makeClient())
        await coord.refreshSources()
        for action in [
            { try await coord.triggerSync(sourceId: "example-internal") },
            { try await coord.setEnabled(sourceId: "example-internal", enabled: false) },
            { try await coord.resync(sourceId: "example-internal") },
            { try await coord.removeSource(sourceId: "example-internal") },
        ] {
            do {
                try await action()
                XCTFail("mutating action on an internal source must throw")
            } catch GatewayClient.Error.internalSource {
                // Expected — refused before any round-trip, and distinct
                // from .forbidden so no UI offers a re-pair for it.
            } catch {
                XCTFail("unexpected error: \(error)")
            }
        }
    }

    func testInternalSourceRecordCarriesTheIdAsTypeAndAccount() {
        let coord = AdminCoordinator()
        let record = coord.internalSourceRecord(for: "example-internal")
        XCTAssertEqual(record.id, "example-internal")
        XCTAssertEqual(record.type, "example-internal")
        XCTAssertEqual(record.accountId, "example-internal")
        XCTAssertTrue(record.enabled)
    }
}
