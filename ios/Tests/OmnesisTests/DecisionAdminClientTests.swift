// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Decoding the decision fields of `GET /admin/models` — presets' and
/// backends' decision APIs, from gateways with and without them — and the
/// requests the setup routes send.
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

    /// A gateway that predates decision models: presets carry only an
    /// OpenAI-compatible URL, and every backend has one.
    private static let olderOverview = """
    {"assignmentDisplays":{},
     "capabilities":[{"role":"decision","title":"Decision model","description":"d","icon":"scale",
       "section":"cognition","backendFamily":"typed-decision"}],
     "inference":{"backends":{"vllm":{"type":"http","status":"ok","url":"http://127.0.0.1:8000","models":["m"]}},
       "assignments":{"decision":{"role":"decision","kind":"typesafe","model":"jev-1.13.0","available":true}}},
     "catalog":[],"installed":[],
     "presets":[{"id":"groq","name":"Groq","defaultUrl":"https://api.groq.com/openai","capabilities":["agent"]}]}
    """

    private static let currentOverview = """
    {"assignmentDisplays":{"decision":{"providerId":"ollaya","providerLabel":"Ollaya","modelName":"kev",
       "available":true,"configured":true}},
     "capabilities":[{"role":"decision","title":"Decision model","description":"d","icon":"scale",
       "section":"cognition","backendFamily":"typed-decision"}],
     "inference":{"allowRemoteInference":false,
       "typesafe":{"url":"https://api.typesafe.ai/v1/systemone","selfHosted":false,"onHost":false},
       "backends":{
         "ollaya":{"type":"http","status":"ok","preset":"ollaya",
           "decision":{"url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone","auth":"bearer",
             "onHost":true,"hasApiKey":false,
             "calibrations":{"kev":{"points":[[0,0],[0.5,0.4],[1,1]],"reference":"jev-worth/email-worth-v1/jev-1.13.0",
               "fittedAt":"2026-11-08T14:30:00.000Z","samples":298,"agreement":0.92,"agreementBefore":0.71}}}},
         "fireworks":{"type":"http","status":"ok","url":"https://api.fireworks.ai/inference","protocol":"chat-completions",
           "models":["accounts/fireworks/models/example-chat"],
           "modelRoles":{"accounts/fireworks/models/example-chat":["agent"]},
           "hasApiKey":true,"credentialSource":"file","preset":"fireworks",
           "decision":{"url":"https://api.fireworks.ai/inference/v1/systemone","protocol":"systemone","auth":"bearer",
             "onHost":false,"hasApiKey":true,"calibrations":{}}},
         "groq":{"type":"http","status":"ok","url":"https://api.groq.com/openai","models":[],"hasApiKey":true,"preset":"groq"},
         "fastino":{"type":"http","status":"unreachable","reason":"API key unreadable","preset":"fastino",
           "decision":{"url":"https://api.fastino.ai/v1/systemone","protocol":"systemone","auth":"x-api-key",
             "onHost":false,"hasApiKey":false,"calibrations":{},
             "apiKeySecretError":"Backend \\"fastino\\" API key secret is missing or unreadable"}}},
       "assignments":{"decision":{"role":"decision","kind":"decision","backendKey":"ollaya","preset":"ollaya",
         "model":"kev","url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone","onHost":true,
         "allowRemoteInference":false,"hasApiKey":false,"calibrated":true,"available":true},
         "agent":{"role":"agent","kind":"some-future-kind","available":false,"reason":"later"}}},
     "catalog":[],"installed":[],
     "presets":[
       {"id":"fireworks","modelsDevId":"fireworks-ai","name":"Fireworks AI","kind":"cloud",
        "defaultUrl":"https://api.fireworks.ai/inference","capabilities":["agent","embed","decision"],
        "decision":{"url":"https://api.fireworks.ai/inference/v1/systemone","protocol":"systemone","auth":"bearer",
          "keyRequired":true,"suggestedModels":["accounts/fireworks/models/rune"],
          "docsUrl":"https://docs.fireworks.ai/api-reference/post-systemone",
          "models":[{"id":"accounts/fireworks/models/rune","source":"preset"}]}},
       {"id":"google","name":"Google AI (Gemini)","kind":"cloud","defaultUrl":"https://generativelanguage.googleapis.com",
        "apiPathPrefix":"/v1beta/openai","capabilities":["agent","embed"]},
       {"id":"cloudflare","name":"Cloudflare Workers AI","kind":"cloud","capabilities":["decision"],
        "decision":{"url":"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run","protocol":"workers-ai",
          "auth":"bearer","keyRequired":true,"modelsDevId":"cloudflare-workers-ai",
          "docsUrl":"https://developers.cloudflare.com/workers-ai/models/clef/",
          "keyUrl":"https://dash.cloudflare.com/profile/api-tokens","suggestedModels":["@cf/cloudflare/clef-flash"],
          "urlParams":[{"key":"account","label":"Account ID","placeholder":"0123456789abcdef"}],
          "note":"Workers AI shortens long text.",
          "models":[{"id":"@cf/cloudflare/clef-flash","contextTokens":8192,"inputCostPerMillion":0.02,"source":"preset"}]}},
       {"id":"typesafe","name":"TypeSafe","kind":"cloud","capabilities":["decision"],"builtIn":"typesafe",
        "decision":{"url":"https://api.typesafe.ai/v1/systemone","protocol":"systemone","auth":"bearer","keyRequired":true,
          "docsUrl":"https://docs.typesafe.ai/api","suggestedModels":["jev-1.14.0"],
          "models":[{"id":"jev-1.14.0","source":"preset"}],"someNewField":{"nested":true}}},
       {"id":"fastino","name":"Fastino","kind":"cloud","capabilities":["decision"],
        "decision":{"url":"https://api.fastino.ai/v1/systemone","protocol":"systemone","auth":"x-api-key",
          "scoreField":"expected_level","keyRequired":true,"docsUrl":"https://docs.fastino.ai/inference/systemone",
          "suggestedModels":["fastino/GLiDE"],"models":[]}},
       {"id":"ollaya","name":"Ollaya","kind":"local","capabilities":["decision"],
        "decision":{"url":"http://127.0.0.1:11435/v1/systemone","protocol":"systemone","auth":"bearer",
          "keyRequired":false,"docsUrl":"https://ollaya.dev/docs/api","suggestedModels":["kev"],
          "models":[{"id":"kev","source":"preset"}]}},
       {"id":"sparse","decision":{}}]}
    """

    // MARK: - Decoding

    func testOlderGatewayWithoutDecisionFieldsDecodesAndStaysReadOnly() async throws {
        let session = MockSession()
        session.body = Self.olderOverview
        let overview = try await client(session).modelOverview()
        XCTAssertEqual(overview.presets.map(\.id), ["groq"])
        XCTAssertNil(overview.presets[0].decision)
        XCTAssertEqual(overview.presets[0].kind, "cloud")
        XCTAssertNil(overview.inference.backends["vllm"]?.decision)
        XCTAssertEqual(overview.inference.backends["vllm"]?.servesOpenAI, true)
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

    func testCurrentGatewayDecodesPresetsWithTheirDecisionAPI() async throws {
        let session = MockSession()
        session.body = Self.currentOverview
        let overview = try await client(session).modelOverview()
        let cap = try XCTUnwrap(overview.capabilities.first)
        XCTAssertTrue(DecisionModelSetup.isConfigurable(cap, in: overview))
        XCTAssertEqual(overview.inference.allowRemoteInference, false)
        XCTAssertEqual(overview.inference.typesafe?.onHost, false)

        let presets = overview.presets
        XCTAssertEqual(presets.map(\.id), ["fireworks", "google", "cloudflare", "typesafe", "fastino", "ollaya", "sparse"])
        // Fireworks serves both APIs; Google only the OpenAI-compatible one.
        XCTAssertEqual(presets[0].defaultUrl, "https://api.fireworks.ai/inference")
        XCTAssertEqual(presets[0].decision?.url, "https://api.fireworks.ai/inference/v1/systemone")
        XCTAssertEqual(presets[0].brandId, "fireworks-ai")
        XCTAssertNil(presets[1].decision)
        XCTAssertEqual(presets[1].apiPathPrefix, "/v1beta/openai")
        // A decision-only provider has no OpenAI-compatible URL.
        let cloudflare = try XCTUnwrap(presets[2].decision)
        XCTAssertNil(presets[2].defaultUrl)
        XCTAssertEqual(cloudflare.urlParams, [DecisionPresetURLParam(key: "account", label: "Account ID", placeholder: "0123456789abcdef")])
        XCTAssertEqual(cloudflare.protocol, "workers-ai")
        XCTAssertEqual(cloudflare.keyUrl, "https://dash.cloudflare.com/profile/api-tokens")
        XCTAssertEqual(cloudflare.models.first?.contextTokens, 8192)
        XCTAssertEqual(cloudflare.models.first?.inputCostPerMillion, 0.02)
        XCTAssertTrue(presets[3].isTypeSafe)
        XCTAssertEqual(presets[3].brandId, "typesafe")
        XCTAssertEqual(presets[4].decision?.scoreField, "expected_level")
        XCTAssertEqual(presets[4].decision?.auth, "x-api-key")
        XCTAssertEqual(presets[4].decision?.models, [], "an explicit empty catalog is kept")
        XCTAssertTrue(presets[5].isLocal)
        // A preset missing every optional field still decodes.
        XCTAssertEqual(presets[6].name, "sparse")
        XCTAssertEqual(presets[6].kind, "cloud")
        XCTAssertEqual(presets[6].capabilities, [])
        XCTAssertEqual(presets[6].decision?.keyRequired, false)
        XCTAssertEqual(presets[6].decision?.urlParams, [])
        XCTAssertEqual(presets[6].decision?.models, [])
    }

    func testCurrentGatewayDecodesEachBackendsDecisionAPIAndTheAssignment() async throws {
        let session = MockSession()
        session.body = Self.currentOverview
        let overview = try await client(session).modelOverview()
        let backends = overview.inference.backends

        // A decision-only backend: no OpenAI-compatible URL or models.
        let ollaya = try XCTUnwrap(backends["ollaya"])
        XCTAssertNil(ollaya.url)
        XCTAssertFalse(ollaya.servesOpenAI)
        XCTAssertEqual(ollaya.preset, "ollaya")
        let decision = try XCTUnwrap(ollaya.decision)
        XCTAssertTrue(decision.onHost)
        XCTAssertFalse(decision.hasApiKey)
        XCTAssertEqual(decision.calibrations["kev"]?.agreement, 0.92)
        XCTAssertEqual(decision.calibrations["kev"]?.samples, 298)
        // A calibration stored before keeps and skips were recorded.
        XCTAssertNil(decision.calibrations["kev"]?.keeps)
        XCTAssertNil(decision.calibrations["kev"]?.skips)
        // One backend, one key, both APIs.
        XCTAssertEqual(backends["fireworks"]?.servesOpenAI, true)
        XCTAssertEqual(backends["fireworks"]?.decision?.url, "https://api.fireworks.ai/inference/v1/systemone")
        XCTAssertEqual(backends["fireworks"]?.hasApiKey, true)
        XCTAssertNil(backends["groq"]?.decision)
        XCTAssertEqual(backends["fastino"]?.status, "unreachable")
        XCTAssertEqual(
            backends["fastino"]?.decision?.apiKeySecretError,
            "Backend \"fastino\" API key secret is missing or unreadable"
        )

        let assignment = try XCTUnwrap(overview.inference.assignments["decision"])
        XCTAssertEqual(assignment.kind, "decision")
        XCTAssertEqual(assignment.backendKey, "ollaya")
        XCTAssertEqual(assignment.model, "kev")
        XCTAssertEqual(assignment.calibrated, true)
        XCTAssertEqual(assignment.onHost, true)
        XCTAssertEqual(overview.inference.assignments["agent"]?.kind, "some-future-kind")
        XCTAssertEqual(DecisionModelSetup.currentVerifyTarget(overview), .backend(key: "ollaya", model: "kev"))
        guard case .calibrated(let stored) = DecisionModelSetup.calibrationState(overview) else {
            return XCTFail("expected a calibrated state")
        }
        XCTAssertEqual(stored?.agreementBefore, 0.71)

        let groups = DecisionModelSetup.providerGroups(overview)
        XCTAssertEqual(groups.existing.map(\.key), ["fastino", "fireworks", "ollaya"])
        XCTAssertEqual(groups.enable, [], "groq's provider has no decision API")
        XCTAssertEqual(groups.typesafe?.id, "typesafe")
        XCTAssertEqual(groups.add.map(\.id), ["ollaya", "fireworks", "cloudflare", "fastino", "sparse"])
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
           "samples":299,"agreement":0.9,"keeps":0.95,"keepsBefore":0.8,"skips":0.88,"skipsBefore":0.91}}
        """#.utf8))
        XCTAssertEqual(done.result?.samples, 299)
        XCTAssertEqual(done.result?.keeps, 0.95)
        XCTAssertEqual(done.result?.keepsBefore, 0.8)
        XCTAssertEqual(done.result?.skips, 0.88)
        XCTAssertEqual(done.result?.skipsBefore, 0.91)
        XCTAssertEqual(done.failed, 1)
        let sparse = try decoder.decode(DecisionCalibrationStatus.self, from: Data(#"{"state":"running"}"#.utf8))
        XCTAssertTrue(sparse.isRunning)
        XCTAssertEqual(sparse.total, 0)
    }

    // MARK: - Requests

    func testPatchDecisionConfigSendsTheMergePatch() async throws {
        let session = MockSession()
        let patch = DecisionConfigPatch(
            backend: .upsert(key: "ollaya", DecisionConfigPatch.Backend(
                type: "http",
                preset: "ollaya",
                decision: .set(DecisionConfigPatch.DecisionAPI(url: "http://127.0.0.1:11435/v1/systemone"))
            )),
            assignment: .set("ollaya/kev")
        )
        try await client(session).patchDecisionConfig(patch)
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.absoluteString, "http://mac.local:7600/admin/config")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(try bodyObject(request), [
            "inference": [
                "backends": ["ollaya": [
                    "type": "http",
                    "preset": "ollaya",
                    "decision": ["url": "http://127.0.0.1:11435/v1/systemone"],
                ] as [String: Any]],
                "assignments": ["decision": "ollaya/kev"],
            ] as [String: Any],
        ] as NSDictionary)
    }

    func testVerifyRoutesPostTheModel() async throws {
        let session = MockSession()
        session.body = #"{"ok":false,"reason":"The server has no model \"kev\" (HTTP 404)."}"#
        let result = try await client(session).verifyBackendDecision(key: "my decider", model: "kev")
        XCTAssertEqual(result.reason, "The server has no model \"kev\" (HTTP 404).")
        session.body = #"{"ok":true,"latencyMs":180}"#
        let typesafe = try await client(session).verifyTypeSafeDecision(model: "jev-1.14.0")
        XCTAssertEqual(typesafe.latencyMs, 180)
        XCTAssertEqual(session.requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertEqual(
            session.requests.map { $0.url?.absoluteString },
            [
                "http://mac.local:7600/admin/inference/backends/my%20decider/decision/verify",
                "http://mac.local:7600/admin/inference/typesafe/verify",
            ]
        )
        XCTAssertEqual(try bodyObject(session.requests[0]), ["model": "kev"] as NSDictionary)
        XCTAssertEqual(try bodyObject(session.requests[1]), ["model": "jev-1.14.0"] as NSDictionary)
    }

    func testBackendNamesAreEncodedAsOnePathSegment() async throws {
        let session = MockSession()
        session.body = #"{"ok":true}"#
        _ = try await client(session).verifyBackendDecision(key: "a?b#c%d.e/f", model: "kev")
        _ = try await client(session).probeBackendDecision(key: "a?b#c%d.e/f")
        XCTAssertEqual(
            session.requests.map { $0.url?.absoluteString },
            [
                "http://mac.local:7600/admin/inference/backends/a%3Fb%23c%25d.e%2Ff/decision/verify",
                "http://mac.local:7600/admin/inference/backends/a%3Fb%23c%25d.e%2Ff/decision/probe",
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
            preset: "ollaya",
            backendKey: "lan"
        )
        XCTAssertEqual(session.requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertEqual(
            Set(session.requests.compactMap { $0.url?.absoluteString }),
            ["http://mac.local:7600/admin/inference/decision/probe"]
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
                "backendKey": "lan",
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
        let result = try await client(session).probeBackendDecision(key: "ollaya")
        XCTAssertEqual(result.models, ["kev", "laya"])
        XCTAssertTrue(result.listed)
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://mac.local:7600/admin/inference/backends/ollaya/decision/probe")
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

/// The Backends side of one backend per provider: what the Add backend form
/// sends for a preset with a decision API, what each row says it serves, and
/// which backends the ordinary model pickers offer.
final class BackendDecisionAPITests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (Data("{}".utf8), response)
        }
    }

    func testAddingAProviderWithBothAPIsSendsItsDecisionAPIWithTheSameKey() async throws {
        let session = MockSession()
        let backend = ModelManagement.newHttpBackend(
            name: " fireworks ",
            url: "https://api.fireworks.ai/inference/",
            apiKey: "fw-example",
            apiPathPrefix: "",
            preset: DecisionFixtures.fireworks
        )
        try await AdminClient(baseURL: XCTUnwrap(URL(string: "http://mac.local:7600")), token: "omn_t", session: session)
            .addHttpBackend(backend)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(session.requests.first?.httpBody)) as? NSDictionary)
        XCTAssertEqual(body, ["inference": ["backends": ["fireworks": [
            "type": "http",
            "url": "https://api.fireworks.ai/inference/",
            "apiKey": "fw-example",
            "preset": "fireworks",
            "decision": ["url": "https://api.fireworks.ai/inference/v1/systemone", "protocol": "systemone", "auth": "bearer"],
        ] as [String: Any]]]] as NSDictionary)
    }

    func testTheAddFormKeepsAPresetOnlyWhileItsURLIsThePresets() {
        let moved = ModelManagement.newHttpBackend(
            name: "fireworks",
            url: "https://proxy.example.com/inference",
            apiKey: nil,
            apiPathPrefix: nil,
            preset: DecisionFixtures.fireworks
        )
        XCTAssertEqual(moved, NewHttpBackend(key: "fireworks", url: "https://proxy.example.com/inference"))
        let chatOnly = ModelManagement.newHttpBackend(
            name: "groq",
            url: "https://api.groq.com/openai",
            apiKey: "",
            apiPathPrefix: "/openai/v1",
            preset: DecisionFixtures.groq
        )
        XCTAssertEqual(
            chatOnly,
            NewHttpBackend(key: "groq", url: "https://api.groq.com/openai", apiPathPrefix: "/openai/v1", preset: "groq")
        )
        // A decision URL that needs the operator's values is left to the Decision card.
        let withParams = ProviderPreset(
            id: "regional",
            name: "Regional",
            defaultUrl: "https://chat.example.com",
            decision: ProviderDecisionPreset(
                url: "https://{region}.example.com/v1/systemone",
                urlParams: [DecisionPresetURLParam(key: "region", label: "Region")]
            )
        )
        let regional = ModelManagement.newHttpBackend(
            name: "regional",
            url: "https://chat.example.com",
            apiKey: nil,
            apiPathPrefix: nil,
            preset: withParams
        )
        XCTAssertEqual(regional.preset, "regional")
        XCTAssertNil(regional.decision)
    }

    func testTheAddFormOffersProvidersWithAnOpenAICompatibleAPI() {
        XCTAssertEqual(
            ModelManagement.addBackendPresets(DecisionFixtures.presets).map(\.id),
            ["openrouter", "fireworks", "groq"]
        )
        XCTAssertEqual(
            ModelManagement.addBackendNote(DecisionFixtures.fireworks),
            "Configuring Fireworks AI — add your API key; the URL is pre-filled. Its decision models are set up too, with the same key."
        )
        XCTAssertEqual(
            ModelManagement.addBackendNote(DecisionFixtures.groq),
            "Configuring Groq — add your API key; the URL is pre-filled."
        )
    }

    func testEachBackendRowSaysWhatItServes() {
        let both = DecisionFixtures.chatBackend(
            "https://api.fireworks.ai/inference",
            decision: BackendDecisionStatus(url: "https://api.fireworks.ai/inference/v1/systemone")
        )
        XCTAssertEqual(ModelManagement.servesLabel(both), "Chat & decision models")
        XCTAssertEqual(
            ModelManagement.servesLabel(DecisionFixtures.decisionBackend("http://127.0.0.1:11435/v1/systemone")),
            "Decision models"
        )
        XCTAssertEqual(ModelManagement.servesLabel(DecisionFixtures.chatBackend("http://127.0.0.1:8000")), "Chat models")
    }

    func testOrdinaryPickersLeaveOutDecisionOnlyBackends() {
        let overview = DecisionFixtures.overview(backends: [
            "ollaya": DecisionFixtures.decisionBackend("http://127.0.0.1:11435/v1/systemone"),
            "vllm": DecisionFixtures.chatBackend("http://127.0.0.1:8000"),
        ])
        XCTAssertEqual(
            ModelManagement.pickerBackends(capabilityRole: "agent", overview: overview).map(\.providerId),
            ["vllm"]
        )
        XCTAssertEqual(ModelManagement.httpBackends(overview).map(\.key), ["ollaya", "vllm"], "the Backends list shows both")
    }
}
