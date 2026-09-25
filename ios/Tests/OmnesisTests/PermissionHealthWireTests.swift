// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The permission-health payload the gateway receives, byte for byte after key
/// sorting. The in-app presentation of a capability must never reach it.
final class PermissionHealthWireTests: XCTestCase {
    private final class RecordingSession: URLSessionLike, @unchecked Sendable {
        private(set) var bodies: [Data] = []

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            bodies.append(request.httpBody ?? Data())
            let response = try XCTUnwrap(
                HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 204, httpVersion: nil, headerFields: nil)
            )
            return (Data(), response)
        }
    }

    private func sentJSON(for access: PhotosAccessState) async throws -> String {
        let session = RecordingSession()
        let client = try AdminClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")), token: "t", session: session)
        let report = PhotosPermissionHealth.report(
            access: access,
            backgroundRefresh: .available,
            checkedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        try await client.reportPermissionHealth(report)
        let body = try XCTUnwrap(session.bodies.first)
        let object = try JSONSerialization.jsonObject(with: body)
        let sorted = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return try XCTUnwrap(String(bytes: sorted, encoding: .utf8))
    }

    private static let backgroundRefresh =
        #"{"id":"background-refresh","impact":"Photos can refresh while Omnesis is in the background.","#
            + #""label":"Background App Refresh","repairAction":"none","requirement":"required","state":"healthy"}"#

    func testLimitedPhotosReportIsUnchangedOnTheWire() async throws {
        let json = try await sentJSON(for: .limited)

        XCTAssertEqual(
            json,
            #"{"capabilities":[{"id":"photo-library","#
                + #""impact":"Only selected photos are syncing; the rest of the library is missing from search.","#
                + #""label":"Photos access","remediation":"Allow Full Access to Photos in iOS Settings.","#
                + #""repairAction":"open-app-settings","requirement":"required","state":"permission-degraded"},"#
                + Self.backgroundRefresh
                + #"],"checkedAt":1700000000000,"validForMs":129600000}"#
        )
    }

    func testDeniedPhotosReportIsUnchangedOnTheWire() async throws {
        let json = try await sentJSON(for: .denied)

        XCTAssertEqual(
            json,
            #"{"capabilities":[{"id":"photo-library","#
                + #""impact":"New photos and screenshots have stopped syncing.","#
                + #""label":"Photos access","remediation":"Allow Full Access to Photos in iOS Settings.","#
                + #""repairAction":"open-app-settings","requirement":"required","state":"permission-degraded"},"#
                + Self.backgroundRefresh
                + #"],"checkedAt":1700000000000,"validForMs":129600000}"#
        )
    }
}
