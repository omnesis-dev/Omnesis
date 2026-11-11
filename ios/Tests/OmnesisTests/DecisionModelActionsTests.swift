// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Decision sheet's gateway calls against a paired gateway: the order
/// and shape of the requests one save sends.
final class DecisionModelActionsTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var body = "{}"

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
    }

    private func actions(_ session: MockSession) -> DecisionModelActions {
        .live(AdminClient(baseURL: URL(string: "http://mac.local:7600")!, token: "omn_t", session: session))
    }

    private func bodyObject(_ request: URLRequest) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? NSDictionary)
    }

    private func typesafePlan(apiKey: String, in overview: ModelsOverview) -> DecisionModelSetup.SavePlan {
        DecisionModelSetup.savePlan(
            DecisionModelSetup.Draft(
                choice: .preset(DecisionFixtures.typesafe),
                name: "",
                url: "",
                apiKey: apiKey,
                model: "jev-1.14.0",
                enableRemoteInference: false
            ),
            in: overview
        )
    }

    func testTypeSafeSaveStoresTheKeyBeforeTheConfigPatch() async throws {
        let session = MockSession()
        try await actions(session).save(typesafePlan(apiKey: "ts-example", in: DecisionFixtures.overview()))
        XCTAssertEqual(session.requests.map(\.httpMethod), ["POST", "PATCH"])
        XCTAssertEqual(session.requests[0].url?.path, "/admin/model-credentials/typesafe")
        XCTAssertEqual(try bodyObject(session.requests[0]), ["fields": ["apiKey": "ts-example"]] as NSDictionary)
        XCTAssertEqual(session.requests[1].url?.path, "/admin/config")
        XCTAssertEqual(
            try bodyObject(session.requests[1]),
            ["inference": ["assignments": ["decision": "typesafe/jev-1.14.0"]]] as NSDictionary
        )
    }

    func testABlankKeySendsNoCredentialAndAnEmptyPatchSendsNothing() async throws {
        let session = MockSession()
        try await actions(session).save(typesafePlan(apiKey: "  ", in: DecisionFixtures.overview()))
        XCTAssertEqual(session.requests.map { $0.url?.path }, ["/admin/config"])
        let unchanged = DecisionFixtures.overview(decision: ResolvedAssignment(kind: "typesafe", model: "jev-1.14.0"))
        session.requests = []
        try await actions(session).save(typesafePlan(apiKey: "", in: unchanged))
        XCTAssertEqual(session.requests, [])
    }

    func testTypeSafeListingReadsTheCredentialRoute() async {
        let session = MockSession()
        session.body = #"""
        {"items":[{"fileKey":"typesafe","providerType":"typesafe","providerName":"TypeSafe",
          "spec":{"fields":[]},"configured":false,"environment":true}],
         "pageInfo":{"hasMore":false,"limit":10},"hostname":"gateway.example.com"}
        """#
        let listed = await actions(session).typesafeKeyListed()
        XCTAssertEqual(listed, true)
        XCTAssertEqual(session.requests.first?.url?.path, "/admin/model-credentials")
    }

    func testUnsavedProbeAndVerifyRouteThroughTheClient() async throws {
        let session = MockSession()
        session.body = #"{"ok":true,"models":["kev"],"listed":true}"#
        let request = DecisionProbeRequest(url: "http://127.0.0.1:8080/v1/systemone", apiKey: "sk-example")
        let probe = try await actions(session).probeURL(request)
        XCTAssertEqual(probe.models, ["kev"])
        // A backend gaining decisions lends its saved key instead of a typed one.
        let lent = DecisionProbeRequest(url: "http://127.0.0.1:11435/v1/systemone", preset: "ollaya", backendKey: "lan")
        _ = try await actions(session).probeURL(lent)
        _ = try await actions(session).probe("studio")
        session.body = #"{"ok":true,"latencyMs":90}"#
        _ = try await actions(session).verify(.typesafe(model: "jev-1.14.0"))
        _ = try await actions(session).verify(.backend(key: "studio", model: "decider-1"))
        XCTAssertEqual(
            session.requests.map { $0.url?.path },
            [
                "/admin/inference/decision/probe",
                "/admin/inference/decision/probe",
                "/admin/inference/backends/studio/decision/probe",
                "/admin/inference/typesafe/verify",
                "/admin/inference/backends/studio/decision/verify",
            ]
        )
        XCTAssertEqual(
            try bodyObject(session.requests[1]),
            ["url": "http://127.0.0.1:11435/v1/systemone", "preset": "ollaya", "backendKey": "lan"] as NSDictionary
        )
    }

    func testWithoutAGatewayEveryCallFails() async {
        let unpaired = DecisionModelActions.live(nil)
        do {
            _ = try await unpaired.probe("studio")
            XCTFail("expected a failure without a paired gateway")
        } catch {}
        let listed = await unpaired.typesafeKeyListed()
        XCTAssertNil(listed)
    }
}
