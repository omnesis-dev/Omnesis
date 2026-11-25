// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class DeviceRetirementAdminClientTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var responder: ((URLRequest) -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            guard let responder else {
                throw GatewayClient.Error.invalidResponse
            }
            return responder(request)
        }
    }

    private let base = URL(string: "https://gateway.example.org")!

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

    func testForgetDeviceReviewsImpactAndSendsTheChosenDispositionAndFence() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            let body = if request.httpMethod == "GET" {
                """
                {"sources":[{"id":"activity:local","type":"activity","multiDeviceMode":"partitioned",
                "otherDeviceCount":1,"deleteScope":"partition"}],"fingerprint":"review-1"}
                """
            } else {
                #"{"ok":true,"forgotten":true}"#
            }
            return self!.makeResponse(status: 200, body: body, url: request.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let impact = try await client.forgetDeviceImpact(id: "dev_phone_2")
        XCTAssertTrue(impact.hasSources)
        XCTAssertEqual(impact.sources.first?.deleteScope, "partition")
        XCTAssertEqual(session.requests.first?.url?.path, "/admin/devices/dev_phone_2/forget-impact")
        try await client.forgetDevice(id: "dev_phone_2", data: .keep, impactFingerprint: impact.fingerprint)
        XCTAssertEqual(session.requests.last?.url?.query, "forget=true&data=keep&impactFingerprint=review-1")
        try await client.forgetDevice(id: "dev_phone_2", data: .delete, impactFingerprint: impact.fingerprint)
        XCTAssertEqual(session.requests.last?.url?.query, "forget=true&data=delete&impactFingerprint=review-1")
    }

    func testForgetDevicePreservesChangedImpactRefusalForAnotherReview() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.makeResponse(
                status: 409,
                body: #"{"code":"DEVICE_FORGET_IMPACT_CHANGED","error":"Review the source impact again."}"#,
                url: request.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        do {
            try await client.forgetDevice(id: "dev_phone_2", data: .delete, impactFingerprint: "stale")
            XCTFail("Expected another source review")
        } catch let error as GatewayClient.Error {
            XCTAssertEqual(error.gatewayCode, "DEVICE_FORGET_IMPACT_CHANGED")
        }
        XCTAssertEqual(session.requests.count, 1)
    }

    func testHistoricalSourceRetainsDeviceProvenanceWithoutActiveHosts() throws {
        let data = Data("""
        {"id":"activity:local","type":"activity","accountId":"local","deviceId":"retired-phone",
         "config":{},"enabled":false,"createdAt":1,"updatedAt":2,"archived":true,
         "archivedDevices":[{"deviceId":"retired-phone","name":"Retired phone","kind":"ios","forgottenAt":3}]}
        """.utf8)
        let source = try JSONDecoder().decode(SourceRecord.self, from: data)
        XCTAssertTrue(source.archived)
        XCTAssertEqual(source.hostDeviceIds, [])
        XCTAssertFalse(source.hosts("retired-phone"))
        XCTAssertEqual(source.archivedDevices.first?.name, "Retired phone")
    }
}
