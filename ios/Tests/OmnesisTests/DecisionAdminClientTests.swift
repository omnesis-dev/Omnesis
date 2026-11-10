// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Decoding the Decision model's fields of `GET /admin/models` (from gateways
/// with and without them) and the requests the setup routes send.
final class DecisionAdminClientTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var status = 200
        var body = "{}"

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
    }

    private let base = URL(string: "http://mac.local:7600")!

    private func client(_ session: MockSession) -> AdminClient {
        AdminClient(baseURL: base, token: "omn_t", session: session)
    }

    private func bodyObject(_ request: URLRequest) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? NSDictionary)
    }

    private static let olderOverview = """
    {"assignmentDisplays":{},
     "capabilities":[{"role":"decision","title":"Decision model","description":"d","icon":"scale",
       "section":"cognition","backendFamily":"typed-decision"}],
     "inference":{"backends":{},"assignments":{"decision":{"role":"decision","kind":"typesafe",
       "model":"jev-1.13.0","available":true}}},
     "catalog":[],"installed":[]}
    """

    private static let currentOverview = """
    {"assignmentDisplays":{"decision":{"providerId":"ollaya","providerLabel":"Ollaya","modelName":"kev",
       "available":true,"configured":true}},
     "capabilities":[{"role":"decision","title":"Decision model","description":"d","icon":"scale",
       "section":"cognition","backendFamily":"typed-decision"}],
     "inference":{"allowRemoteInference":false,"backends":{},
       "typesafe":{"url":"https://api.typesafe.ai/v1/systemone","selfHosted":false,"onHost":false},
       "decisionChatModels":false,
       "decisionBackends":{"ollaya":{"preset":"ollaya","url":"http://127.0.0.1:11435/v1/systemone",
         "protocol":"systemone","auth":"bearer","onHost":true,"hasApiKey":false,
         "calibrations":{"kev":{"points":[[0,0],[0.5,0.4],[1,1]],"reference":"jev-worth/email-worth-v1/jev-1.13.0",
           "fittedAt":"2026-11-08T14:30:00.000Z","samples":298,"agreement":0.92,"agreementBefore":0.71}}}},
       "assignments":{"decision":{"role":"decision","kind":"decision","backendKey":"ollaya","preset":"ollaya",
         "model":"kev","url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone","onHost":true,
         "allowRemoteInference":false,"hasApiKey":false,"calibrated":true,"available":true},
         "agent":{"role":"agent","kind":"some-future-kind","available":false,"reason":"later"}}},
     "catalog":[],"installed":[],
     "decisionPresets":[
       {"id":"cloudflare","name":"Cloudflare Workers AI","kind":"cloud",
        "url":"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run","protocol":"workers-ai",
        "auth":"bearer","keyRequired":true,"modelsDevId":"cloudflare-workers-ai",
        "docsUrl":"https://developers.cloudflare.com/workers-ai/models/clef/",
        "keyUrl":"https://dash.cloudflare.com/profile/api-tokens","suggestedModels":["@cf/cloudflare/clef-flash"],
        "urlParams":[{"key":"account","label":"Account ID","placeholder":"0123456789abcdef"}],
        "note":"Workers AI shortens long text.",
        "models":[{"id":"@cf/cloudflare/clef-flash","contextTokens":8192,"inputCostPerMillion":0.02,"source":"preset"}]},
       {"id":"typesafe","name":"TypeSafe","kind":"cloud","url":"https://api.typesafe.ai/v1/systemone",
        "protocol":"systemone","auth":"bearer","keyRequired":true,"builtIn":"typesafe",
        "docsUrl":"https://docs.typesafe.ai/systemone","suggestedModels":["jev-1.14.0"],
        "models":[{"id":"jev-1.14.0","source":"preset"}],"someNewField":{"nested":true}},
       {"id":"fastino","name":"Fastino","kind":"cloud","url":"https://api.fastino.ai/v1/systemone",
        "protocol":"systemone","auth":"x-api-key","scoreField":"expected_level","keyRequired":true,
        "docsUrl":"https://docs.fastino.ai/glide","suggestedModels":["fastino/GLiDE"],"models":[]},
       {"id":"sparse","url":"http://127.0.0.1:9000/v1/systemone"}]}
    """

    // MARK: - Decoding

    func testOlderGatewayWithoutDecisionFieldsDecodesAndStaysReadOnly() async throws {
        let session = MockSession()
        session.body = Self.olderOverview
        let overview = try await client(session).modelOverview()
        XCTAssertNil(overview.decisionPresets)
        XCTAssertNil(overview.inference.decisionBackends)
        XCTAssertNil(overview.inference.allowRemoteInference)
        XCTAssertNil(overview.inference.typesafe)
        let decision = try XCTUnwrap(overview.inference.assignments["decision"])
        XCTAssertEqual(decision.kind, "typesafe")
        XCTAssertEqual(decision.model, "jev-1.13.0")
        XCTAssertNil(decision.calibrated)
        let cap = try XCTUnwrap(overview.capabilities.first)
        XCTAssertFalse(DecisionModelSetup.isConfigurable(cap, in: overview))
        XCTAssertNil(DecisionModelSetup.calibrationState(overview))
    }

    func testCurrentGatewayDecodesPresetsBackendsAndTheDecisionAssignment() async throws {
        let session = MockSession()
        session.body = Self.currentOverview
        let overview = try await client(session).modelOverview()
        let cap = try XCTUnwrap(overview.capabilities.first)
        XCTAssertTrue(DecisionModelSetup.isConfigurable(cap, in: overview))
        XCTAssertEqual(overview.inference.allowRemoteInference, false)
        XCTAssertEqual(overview.inference.typesafe?.onHost, false)

        let presets = try XCTUnwrap(overview.decisionPresets)
        XCTAssertEqual(presets.map(\.id), ["cloudflare", "typesafe", "fastino", "sparse"])
        XCTAssertEqual(presets[0].urlParams, [DecisionPresetURLParam(key: "account", label: "Account ID", placeholder: "0123456789abcdef")])
        XCTAssertEqual(presets[0].protocol, "workers-ai")
        XCTAssertEqual(presets[0].keyUrl, "https://dash.cloudflare.com/profile/api-tokens")
        XCTAssertEqual(presets[0].models.first?.contextTokens, 8192)
        XCTAssertEqual(presets[0].models.first?.inputCostPerMillion, 0.02)
        XCTAssertTrue(presets[1].isTypeSafe)
        XCTAssertEqual(presets[2].scoreField, "expected_level")
        XCTAssertEqual(presets[2].auth, "x-api-key")
        XCTAssertEqual(presets[2].models, [], "an explicit empty catalog is kept")
        // The logo id is the models.dev id when the preset has one.
        XCTAssertEqual(presets[0].brandId, "cloudflare-workers-ai")
        XCTAssertEqual(presets[1].brandId, "typesafe")
        // A preset missing every optional field still decodes.
        XCTAssertEqual(presets[3].name, "sparse")
        XCTAssertEqual(presets[3].kind, "cloud")
        XCTAssertFalse(presets[3].keyRequired)
        XCTAssertEqual(presets[3].urlParams, [])
        XCTAssertEqual(presets[3].models, [])

        let backend = try XCTUnwrap(overview.inference.decisionBackends?["ollaya"])
        XCTAssertEqual(backend.preset, "ollaya")
        XCTAssertTrue(backend.onHost)
        XCTAssertFalse(backend.hasApiKey)
        XCTAssertEqual(backend.calibrations["kev"]?.agreement, 0.92)
        XCTAssertEqual(backend.calibrations["kev"]?.samples, 298)

        let decision = try XCTUnwrap(overview.inference.assignments["decision"])
        XCTAssertEqual(decision.kind, "decision")
        XCTAssertEqual(decision.backendKey, "ollaya")
        XCTAssertEqual(decision.model, "kev")
        XCTAssertEqual(decision.calibrated, true)
        XCTAssertEqual(decision.onHost, true)
        XCTAssertEqual(overview.inference.assignments["agent"]?.kind, "some-future-kind")
        XCTAssertEqual(DecisionModelSetup.currentVerifyTarget(overview), .backend(key: "ollaya", model: "kev"))
        guard case .calibrated(let stored) = DecisionModelSetup.calibrationState(overview) else {
            return XCTFail("expected a calibrated state")
        }
        XCTAssertEqual(stored?.agreementBefore, 0.71)
    }

    func testResultTypesDecodeWithAndWithoutOptionalFields() throws {
        let decoder = JSONDecoder()
        let verified = try decoder.decode(
            DecisionVerifyResult.self,
            from: Data(#"{"ok":true,"answeredBy":"kev","latencyMs":240}"#.utf8)
        )
        XCTAssertEqual(verified, DecisionVerifyResult(ok: true, answeredBy: "kev", latencyMs: 240))
        let refused = try decoder.decode(
            DecisionVerifyResult.self,
            from: Data(#"{"ok":false,"status":401,"reason":"The API key was refused (HTTP 401)."}"#.utf8)
        )
        XCTAssertEqual(refused.status, 401)
        XCTAssertEqual(refused.reason, "The API key was refused (HTTP 401).")
        let probe = try decoder.decode(DecisionProbeResult.self, from: Data(#"{"ok":true}"#.utf8))
        XCTAssertEqual(probe, DecisionProbeResult(ok: true, models: [], listed: false))
        let idle = try decoder.decode(DecisionCalibrationStatus.self, from: Data(#"{"state":"idle","done":0,"total":0,"failed":0}"#.utf8))
        XCTAssertFalse(idle.isRunning)
        let done = try decoder.decode(DecisionCalibrationStatus.self, from: Data(#"""
        {"state":"done","assignment":"ollaya/kev","done":300,"total":300,"failed":1,
         "startedAt":"2026-11-08T14:25:00.000Z","finishedAt":"2026-11-08T14:30:00.000Z",
         "result":{"points":[[0,0],[1,1]],"reference":"jev-worth/v1/jev","fittedAt":"2026-11-08T14:30:00.000Z",
           "samples":299,"agreement":0.9}}
        """#.utf8))
        XCTAssertEqual(done.result?.samples, 299)
        XCTAssertEqual(done.failed, 1)
        let sparse = try decoder.decode(DecisionCalibrationStatus.self, from: Data(#"{"state":"running"}"#.utf8))
        XCTAssertTrue(sparse.isRunning)
        XCTAssertEqual(sparse.total, 0)
    }

    // MARK: - Requests

    func testPatchDecisionConfigSendsTheMergePatch() async throws {
        let session = MockSession()
        let patch = DecisionConfigPatch(
            backend: .upsert(key: "ollaya", DecisionConfigPatch.Backend(preset: "ollaya", url: "http://127.0.0.1:11435/v1/systemone")),
            assignment: .set("ollaya/kev")
        )
        try await client(session).patchDecisionConfig(patch)
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.absoluteString, "http://mac.local:7600/admin/config")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(try bodyObject(request), [
            "inference": [
                "decisionBackends": ["ollaya": ["preset": "ollaya", "url": "http://127.0.0.1:11435/v1/systemone"]],
                "assignments": ["decision": "ollaya/kev"],
            ] as [String: Any],
        ] as NSDictionary)
    }

    func testVerifyRoutesPostTheModel() async throws {
        let session = MockSession()
        session.body = #"{"ok":false,"reason":"The server has no model \"kev\" (HTTP 404)."}"#
        let result = try await client(session).verifyDecisionBackend(key: "my decider", model: "kev")
        XCTAssertEqual(result.reason, "The server has no model \"kev\" (HTTP 404).")
        session.body = #"{"ok":true,"latencyMs":180}"#
        let typesafe = try await client(session).verifyTypeSafeDecision(model: "jev-1.14.0")
        XCTAssertEqual(typesafe.latencyMs, 180)
        XCTAssertEqual(session.requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertEqual(
            session.requests.map { $0.url?.absoluteString },
            [
                "http://mac.local:7600/admin/inference/decision-backends/my%20decider/verify",
                "http://mac.local:7600/admin/inference/typesafe/verify",
            ]
        )
        XCTAssertEqual(try bodyObject(session.requests[0]), ["model": "kev"] as NSDictionary)
        XCTAssertEqual(try bodyObject(session.requests[1]), ["model": "jev-1.14.0"] as NSDictionary)
    }

    func testBackendNamesAreEncodedAsOnePathSegment() async throws {
        let session = MockSession()
        session.body = #"{"ok":true}"#
        _ = try await client(session).verifyDecisionBackend(key: "a?b#c%d.e/f", model: "kev")
        _ = try await client(session).probeDecisionBackend(key: "a?b#c%d.e/f")
        XCTAssertEqual(
            session.requests.map { $0.url?.absoluteString },
            [
                "http://mac.local:7600/admin/inference/decision-backends/a%3Fb%23c%25d.e%2Ff/verify",
                "http://mac.local:7600/admin/inference/decision-backends/a%3Fb%23c%25d.e%2Ff/probe",
            ]
        )
    }

    func testProbingAnUnsavedServerPostsItsURLAndOnlyTheFieldsGiven() async throws {
        let session = MockSession()
        session.body = #"{"ok":false,"models":[],"listed":false,"reason":"HTTP 401 from http://127.0.0.1:8080/v1/models"}"#
        let result = try await client(session).probeDecisionURL(url: "http://127.0.0.1:8080/v1/systemone", apiKey: "sk-example")
        XCTAssertEqual(result.reason, "HTTP 401 from http://127.0.0.1:8080/v1/models")
        _ = try await client(session).probeDecisionURL(
            url: "http://127.0.0.1:11435/v1/systemone",
            auth: "bearer",
            protocol: "systemone",
            preset: "ollaya"
        )
        XCTAssertEqual(session.requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertEqual(
            session.requests.first?.url?.absoluteString,
            "http://mac.local:7600/admin/inference/decision-backends/probe"
        )
        XCTAssertEqual(
            try bodyObject(session.requests[0]),
            ["url": "http://127.0.0.1:8080/v1/systemone", "apiKey": "sk-example"] as NSDictionary
        )
        XCTAssertEqual(
            try bodyObject(session.requests[1]),
            [
                "url": "http://127.0.0.1:11435/v1/systemone",
                "auth": "bearer",
                "protocol": "systemone",
                "preset": "ollaya",
            ] as NSDictionary
        )
    }

    func testCredentialEntriesDecodeTheEnvironmentFlag() throws {
        let decoder = JSONDecoder()
        let withEnv = try decoder.decode(ModelCredentialEntry.self, from: Data(#"""
        {"fileKey":"typesafe","providerType":"typesafe","providerName":"TypeSafe",
         "spec":{"fields":[{"name":"apiKey","label":"API key","secret":true}]},"configured":false,"environment":true}
        """#.utf8))
        XCTAssertEqual(withEnv.environment, true)
        let older = try decoder.decode(ModelCredentialEntry.self, from: Data(#"""
        {"fileKey":"typesafe","providerType":"typesafe","providerName":"TypeSafe",
         "spec":{"fields":[]},"configured":true}
        """#.utf8))
        XCTAssertNil(older.environment)
    }

    func testProbeRoutePostsToTheBackend() async throws {
        let session = MockSession()
        session.body = #"{"ok":true,"models":["kev","laya"],"listed":true}"#
        let result = try await client(session).probeDecisionBackend(key: "ollaya")
        XCTAssertEqual(result.models, ["kev", "laya"])
        XCTAssertTrue(result.listed)
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://mac.local:7600/admin/inference/decision-backends/ollaya/probe")
    }

    func testCalibrationRoutesUseOneResource() async throws {
        let session = MockSession()
        session.body = #"{"state":"running","assignment":"ollaya/kev","done":0,"total":300,"failed":0}"#
        let admin = client(session)
        _ = try await admin.startDecisionCalibration()
        _ = try await admin.decisionCalibrationStatus()
        _ = try await admin.cancelDecisionCalibration()
        XCTAssertEqual(session.requests.map(\.httpMethod), ["POST", "GET", "DELETE"])
        XCTAssertEqual(
            Set(session.requests.compactMap { $0.url?.absoluteString }),
            ["http://mac.local:7600/admin/models/decision/calibration"]
        )
    }

    func testStartingWhileRunningIsAConflictAndUnsupportedCarriesTheReason() async throws {
        let session = MockSession()
        session.status = 409
        session.body = #"{"error":"A calibration is already running"}"#
        do {
            _ = try await client(session).startDecisionCalibration()
            XCTFail("expected a conflict")
        } catch GatewayClient.Error.serverError(status: 409, _) {}
        session.status = 400
        session.body = #"{"error":"TypeSafe's Jev is the reference itself."}"#
        do {
            _ = try await client(session).startDecisionCalibration()
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual((error as? GatewayClient.Error)?.gatewayMessage, "TypeSafe's Jev is the reference itself.")
        }
    }
}
