// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AdminClientTests: XCTestCase {
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

    private let base = URL(string: "http://mac.local:7600")!

    private func makeResponse(status: Int, body: String, url: URL) -> (Data, URLResponse) {
        let data = Data(body.utf8)
        let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (data, response)
    }

    func testListSourcesSendsAuthorizationHeader() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[{"id":"gmail:a@b.com","type":"gmail","accountId":"a@b.com",
                "deviceId":"dev_1","config":{},"enabled":true,"createdAt":0,"updatedAt":0}],
                "pageInfo":{"hasMore":false,"limit":1}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let sources = try await client.listSources()
        XCTAssertEqual(sources.count, 1)
        XCTAssertEqual(sources[0].id, "gmail:a@b.com")
        XCTAssertEqual(sources[0].type, "gmail")
        XCTAssertEqual(sources[0].deviceId, "dev_1")

        XCTAssertEqual(session.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        XCTAssertEqual(session.requests[0].url?.absoluteString, "http://mac.local:7600/admin/sources")
        XCTAssertEqual(session.requests[0].httpMethod, "GET")
    }

    func testSyncSourceTargetsCorrectURL() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.syncSource(sourceId: "gmail:a@b.com")
        // `:` in the source id gets percent-encoded (%3A) by urlPathAllowed,
        // which is what the gateway expects.
        let absolute = session.requests[0].url?.absoluteString ?? ""
        XCTAssertTrue(absolute.contains("/admin/sources/"))
        XCTAssertTrue(absolute.hasSuffix("/sync"), "unexpected URL: \(absolute)")
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
    }

    func testPatchSourceSendsBody() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"source":{"id":"gmail:a@b.com","type":"gmail","accountId":"a@b.com",
                "deviceId":"dev_1","config":{},"enabled":false,"createdAt":0,"updatedAt":0}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let updated = try await client.patchSource(sourceId: "gmail:a@b.com", enabled: false)
        XCTAssertFalse(updated.enabled)
        let body = session.requests[0].httpBody ?? Data()
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(decoded?["enabled"] as? Bool, false)
    }

    func testPatchSourceSendsMobileLifecycleFields() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"source":{"id":"apple-health:local","type":"apple-health","accountId":"local",
                "deviceId":"new-phone","config":{},"enabled":true,"createdAt":0,"updatedAt":0,
                "multiDeviceMode":"replicated"}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        _ = try await client.patchSource(
            sourceId: "apple-health:local",
            deviceId: "new-phone",
            multiDeviceMode: .replicated
        )
        let body = session.requests[0].httpBody ?? Data()
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(decoded?["deviceId"] as? String, "new-phone")
        XCTAssertEqual(decoded?["multiDeviceMode"] as? String, "replicated")
        XCTAssertNil(decoded?["enabled"])
        XCTAssertNil(decoded?["config"])
    }

    func testRemoveSourceSendsDelete() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.removeSource(sourceId: "gmail:a@b.com")
        XCTAssertEqual(session.requests[0].httpMethod, "DELETE")
    }

    func testModePatchRejectsLegacySuccessWithoutRequestedModeAcknowledgment() async throws {
        for field in ["", ",\"multiDeviceMode\":\"exclusive\""] {
            let session = MockSession()
            session.responder = { [weak self] request in
                self!.makeResponse(
                    status: 200,
                    body: """
                    {"source":{"id":"fictional:local","type":"fictional","accountId":"local",
                    "deviceId":"phone","config":{},"enabled":true,"createdAt":0,"updatedAt":0\(field)}}
                    """,
                    url: request.url!
                )
            }
            let client = AdminClient(baseURL: base, token: "test-token", session: session)
            do {
                _ = try await client.patchSource(sourceId: "fictional:local", multiDeviceMode: .partitioned)
                XCTFail("HTTP success cannot acknowledge an ignored storage-mode request")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("Update the gateway"))
            }
        }
    }

    private static let sourceMembershipBody = """
    {"source":{"id":"apple-health:local","type":"apple-health","accountId":"local",
    "deviceId":"dev_phone_1","config":{},"enabled":true,"createdAt":0,"updatedAt":0},
    "members":["dev_phone_1","dev_phone_2"]}
    """

    /// `/admin/sources` names every host of a row, so a client can tell
    /// whether this device is one of them without a second call.
    func testListSourcesReadsTheHostListAndTheSharingMode() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[{"id":"apple-health:local","type":"apple-health","accountId":"local",
                "deviceId":"dev_phone_1","config":{},"enabled":true,"createdAt":0,"updatedAt":0,
                "members":["dev_phone_1","dev_phone_2"],"multiDeviceMode":"replicated"}],
                "pageInfo":{"hasMore":false,"limit":1}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let sources = try await client.listSources()
        let source = try XCTUnwrap(sources.first)
        XCTAssertEqual(source.members, ["dev_phone_1", "dev_phone_2"])
        XCTAssertEqual(source.hostDeviceIds, ["dev_phone_1", "dev_phone_2"])
        XCTAssertEqual(source.multiDeviceMode, "replicated")
        XCTAssertTrue(source.hosts("dev_phone_2"))
        XCTAssertFalse(source.hosts("dev_phone_3"))
    }

    /// A gateway that predates membership sends neither field. Its owner is
    /// then the row's only host, which is what `hosts(_:)` has to say.
    func testASourceFromAGatewayWithoutMembershipHasItsOwnerAsSoleHost() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[{"id":"apple-health:local","type":"apple-health","accountId":"local",
                "deviceId":"dev_phone_1","config":{},"enabled":true,"createdAt":0,"updatedAt":0}],
                "pageInfo":{"hasMore":false,"limit":1}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let sources = try await client.listSources()
        let source = try XCTUnwrap(sources.first)
        XCTAssertTrue(source.members.isEmpty)
        XCTAssertEqual(source.hostDeviceIds, ["dev_phone_1"])
        XCTAssertNil(source.multiDeviceMode)
        XCTAssertTrue(source.hosts("dev_phone_1"))
        XCTAssertFalse(source.hosts("dev_phone_2"))
    }

    func testListSourcesAndInternalReadsTheInternalArray() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[],"pageInfo":{"hasMore":false,"limit":0},
                "pendingRemovals":[{"id":"notes-synth:retired","type":"notes-synth","accountId":"retired","state":"removing"}],
                "removedSourceIds":["notes-synth:retired"],"internalSources":[{"id":"omnesis-notes"}]}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let result = try await client.listSourcesAndInternal()
        XCTAssertTrue(result.sources.isEmpty)
        XCTAssertEqual(result.internalSources, [InternalSource(id: "omnesis-notes")])
        XCTAssertEqual(result.removedSourceIds, ["notes-synth:retired"])
        XCTAssertEqual(result.pendingRemovals.map(\.id), ["notes-synth:retired"])
        XCTAssertEqual(session.requests.count, 1)
    }

    func testListSourcesAndInternalToleratesAGatewayWithoutTheField() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[],"pageInfo":{"hasMore":false,"limit":0}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let result = try await client.listSourcesAndInternal()
        XCTAssertTrue(result.internalSources.isEmpty)
        XCTAssertTrue(result.removedSourceIds.isEmpty)
        XCTAssertTrue(result.pendingRemovals.isEmpty)
    }

    func testDetachSourceMemberSendsDeleteToTheMemberPath() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: Self.sourceMembershipBody, url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let membership = try await client.detachSourceMember(sourceId: "apple-health:local", deviceId: "dev_phone_2")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/admin/sources/apple-health:local/members/dev_phone_2")
        XCTAssertNil(request.httpBody)
        XCTAssertEqual(membership.source.id, "apple-health:local")
        XCTAssertEqual(membership.members, ["dev_phone_1", "dev_phone_2"])
    }

    func testJoinSourceSendsTheDeviceIdBody() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: Self.sourceMembershipBody, url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        _ = try await client.joinSource(sourceId: "apple-health:local", deviceId: "dev_phone_2")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/admin/sources/apple-health:local/members")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
        XCTAssertEqual(body["deviceId"] as? String, "dev_phone_2")
    }

    func testDetachRefusalSurfacesTheGatewayCode() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 409,
                body: #"{"error":"device dev_phone_1 is the last host of apple-health:local","code":"LAST_MEMBER"}"#,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        do {
            _ = try await client.detachSourceMember(sourceId: "apple-health:local", deviceId: "dev_phone_1")
            XCTFail("expected a 409")
        } catch let error as GatewayClient.Error {
            XCTAssertEqual(error.gatewayCode, "LAST_MEMBER")
        }
    }

    func testForgetDeviceSendsTheForgetQuery() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: #"{"ok":true,"forgotten":true}"#, url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.forgetDevice(id: "dev_phone_2")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/admin/devices/dev_phone_2")
        XCTAssertEqual(request.url?.query, "forget=true")
    }

    func testRevokeDeviceSendsNoForgetQuery() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: #"{"ok":true}"#, url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.revokeDevice(id: "dev_phone_2")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertNil(request.url?.query)
    }

    func testDeviceRecordDecodesRevokedAt() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[
                  {"id":"dev_1","name":"Studio Desktop","kind":"collector","pairedAt":1,"lastSeenAt":2,"online":true},
                  {"id":"dev_2","name":"Old phone","kind":"ios","pairedAt":1,"lastSeenAt":null,"revokedAt":1700000000000,"online":false}
                ],"pageInfo":{"hasMore":false,"limit":2}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let devices = try await client.listDevices()
        XCTAssertEqual(devices.map(\.revokedAt), [nil, 1_700_000_000_000])
        XCTAssertEqual(devices.map(\.isRevoked), [false, true])
    }

    func testReportPermissionHealthUsesCanonicalPathAndBody() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let report = SourcePermissionHealthReport(
            sourceId: "photos:local",
            displayName: "Photos",
            checkedAt: Date(timeIntervalSince1970: 1_700_000_000.125),
            validForMs: 86_400_000,
            capabilities: [SourcePermissionCapability(
                id: "photo-library",
                state: .permissionDegraded,
                requirement: .required,
                label: "Photos access",
                impact: "Only selected photos are syncing.",
                remediation: "Allow Full Access.",
                repairAction: .openAppSettings
            )]
        )

        try await AdminClient(baseURL: base, token: "omn_t", session: session)
            .reportPermissionHealth(report)

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/admin/sources/photos:local/permission-health")
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        )
        XCTAssertEqual((body["checkedAt"] as? NSNumber)?.int64Value, 1_700_000_000_125)
        XCTAssertEqual(body["validForMs"] as? Int, 86_400_000)
        XCTAssertNil(body["sourceId"])
        XCTAssertNil(body["displayName"])
        let capability = try XCTUnwrap((body["capabilities"] as? [[String: Any]])?.first)
        XCTAssertEqual(capability["state"] as? String, "permission-degraded")
        XCTAssertEqual(capability["requirement"] as? String, "required")
        XCTAssertEqual(capability["repairAction"] as? String, "open-app-settings")
    }

    func testUnauthorizedThrowsErrorUnauthorized() async {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 401, body: "{\"error\":\"bad token\"}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        do {
            _ = try await client.listSources()
            XCTFail("expected error")
        } catch GatewayClient.Error.unauthorized {
            // Expected.
        } catch {
            XCTFail("wrong error: \(error)")
        }
    }

    func testModelOverviewDecodesInferenceAndCatalog() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"assignmentDisplays":{"agent":{"providerId":"anthropic","providerLabel":"Anthropic",
                  "modelName":"Claude","available":true,"configured":true}},
                "capabilities":[{"role":"agent","title":"Agent","description":"d","icon":"bot"},{"role":"entailment-verifier","title":"Entailment verifier","description":"d","icon":"shield-check","experimental":true,"section":"cognition"}],
                "inference":{"backends":{"nstar":{"type":"http","status":"ok","url":"http://x/v1",
                  "models":["m1"],"modelRoles":{"m1":["agent"]},"hasApiKey":false}},
                  "codex":{"type":"codex","configured":true,"status":"ok","loggedIn":true,
                    "models":["gpt-example-frontier"],
                    "modelDetails":[{"id":"gpt-example-frontier","name":"GPT Example Frontier","recommended":true}],
                    "runtime":{"source":"managed","command":"/tmp/codex","packageName":"@openai/codex","packageVersion":"0.142.4","version":"0.142.4","supported":true},
                    "discovery":"app-server",
                    "modelRoles":{"gpt-example-frontier":["agent","background-agent"]},"refreshedAt":"2026-07-03T12:00:00Z"},
                  "assignments":{"agent":{"kind":"anthropic","available":true}}},
                "catalog":[{"kind":"anthropic-api","id":"anthropic/claude","name":"Claude","roles":["agent"]},
                  {"kind":"gguf","id":"example-embed-v1.Q4_K_M","name":"example-embed-v1","roles":["embed"],
                   "sizeBytes":512000000,"minRamGb":8,"recommendedRamGb":12,"quant":"Q4_K_M","params":"560M","recommended":true}],
                "installed":[{"id":"nomic.Q8"}],
                "presets":[],"modelsDir":"/m",
                "activeDownloads":[{"downloadId":"dl-1","modelId":"example-embed-v1.Q4_K_M",
                  "filename":"example-embed-v1.Q4_K_M.gguf","startedAt":"2026-01-01T00:00:00Z",
                  "progress":{"downloadedBytes":215000000,"totalBytes":512000000,"speedBytesPerSec":8400000,"etaMs":35000}}]}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let overview = try await client.modelOverview()
        XCTAssertEqual(overview.assignmentDisplays["agent"]?.modelName, "Claude")
        XCTAssertEqual(overview.capabilities.first?.role, "agent")
        // `section` decodes when served, and defaults nil for entries an
        // older gateway emits without it — the models-screen grouping key.
        XCTAssertNil(overview.capabilities.first?.section)
        XCTAssertEqual(overview.capabilities.last?.section, "cognition")
        XCTAssertEqual(overview.inference.backends["nstar"]?.modelRoles?["m1"], ["agent"])
        XCTAssertEqual(overview.inference.codex?.configured, true)
        XCTAssertEqual(overview.inference.codex?.modelDetails?.first?.name, "GPT Example Frontier")
        XCTAssertEqual(overview.inference.codex?.runtime?.source, "managed")
        XCTAssertEqual(overview.inference.codex?.discovery, "app-server")
        XCTAssertEqual(overview.inference.codex?.modelRoles?["gpt-example-frontier"], ["agent", "background-agent"])
        XCTAssertEqual(overview.inference.assignments["agent"]?.kind, "anthropic")
        XCTAssertEqual(overview.catalog.first?.id, "anthropic/claude")
        XCTAssertEqual(overview.installed.first?.id, "nomic.Q8")
        // The GGUF entry's lifecycle/fit fields decode.
        let gguf = overview.catalog.first { $0.kind == "gguf" }
        XCTAssertEqual(gguf?.sizeBytes, 512_000_000)
        XCTAssertEqual(gguf?.minRamGb, 8)
        XCTAssertEqual(gguf?.quant, "Q4_K_M")
        XCTAssertEqual(gguf?.recommended, true)
        // activeDownloads decode (id + progress snapshot).
        XCTAssertEqual(overview.activeDownloads.count, 1)
        XCTAssertEqual(overview.activeDownloads.first?.modelId, "example-embed-v1.Q4_K_M")
        XCTAssertEqual(overview.activeDownloads.first?.progress.totalBytes, 512_000_000)
        XCTAssertEqual(session.requests[0].url?.absoluteString, "http://mac.local:7600/admin/models")
    }

    func testModelOverviewDefaultsActiveDownloadsWhenAbsent() async throws {
        // An older gateway omits `activeDownloads` — it must default to empty,
        // not fail the whole overview decode.
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"assignmentDisplays":{},"capabilities":[],
                "inference":{"backends":{},"assignments":{}},
                "catalog":[],"installed":[],"presets":[],"modelsDir":"/m"}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let overview = try await client.modelOverview()
        XCTAssertTrue(overview.activeDownloads.isEmpty)
        // `presets` likewise defaults to empty when the gateway omits the key.
        XCTAssertTrue(overview.presets.isEmpty)
        XCTAssertTrue(overview.modelControls.isEmpty)
        XCTAssertTrue(overview.modelSettings.isEmpty)
    }

    func testModelOverviewDecodesProviderSpecificControlsAndSavedBehavior() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"assignmentDisplays":{},"capabilities":[],
                "inference":{"backends":{},"assignments":{}},"catalog":[],"installed":[],
                "modelControls":{"openai/gpt-example":{"providerId":"openai","source":"models.dev",
                    "reasoning":true,"controls":[
                      {"key":"reasoningEnabled","type":"boolean","label":"Reasoning"},
                      {"key":"reasoningEffort","type":"enum","label":"Effort",
                       "values":["low","high"],"exclusiveWith":["reasoningBudgetTokens"]},
                      {"key":"reasoningBudgetTokens","type":"integer","label":"Token budget",
                       "min":1,"max":8192,"exclusiveWith":["reasoningEffort"]}
                    ],"modalities":{"input":["text"],"output":["text"]},"logoUrl":"/model-logos/openai.svg"}},
                "modelSettings":{"agent":{"assignment":"openai/gpt-example",
                  "values":{"reasoningEnabled":true,"reasoningEffort":"high","reasoningBudgetTokens":2048}}}}
                """,
                url: req.url!
            )
        }
        let overview = try await AdminClient(baseURL: base, token: "omn_t", session: session).modelOverview()
        XCTAssertEqual(overview.modelControls["openai/gpt-example"]?.source, "models.dev")
        XCTAssertEqual(overview.modelControls["openai/gpt-example"]?.controls.map(\.key), [
            "reasoningEnabled", "reasoningEffort", "reasoningBudgetTokens",
        ])
        XCTAssertEqual(overview.modelControls["openai/gpt-example"]?.controls.last?.max, 8192)
        XCTAssertEqual(overview.modelControls["openai/gpt-example"]?.controls.last?.exclusiveWith, ["reasoningEffort"])
        XCTAssertEqual(overview.modelSettings["agent"]?.assignment, "openai/gpt-example")
        XCTAssertEqual(overview.modelSettings["agent"]?.values.reasoningEffort, "high")
        XCTAssertEqual(overview.modelSettings["agent"]?.values.reasoningBudgetTokens, 2048)
    }

    func testBehaviorPatchSendsFullOverrideMapAndAssignmentGuard() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.updateModelBehavior(
            role: "privacy-reviewer",
            assignment: "openai/gpt-example",
            values: ModelBehaviorValues(reasoningEnabled: false),
            expectedValues: ModelBehaviorValues(reasoningEffort: "high", reasoningBudgetTokens: 2048)
        )
        let req = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(req.url?.absoluteString, "http://mac.local:7600/admin/models/behavior/privacy-reviewer")
        XCTAssertEqual(req.httpMethod, "PATCH")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
        XCTAssertEqual(body["assignment"] as? String, "openai/gpt-example")
        let values = try XCTUnwrap(body["values"] as? [String: Any])
        XCTAssertEqual(values["reasoningEnabled"] as? Bool, false)
        XCTAssertNil(values["reasoningEffort"], "omitted fields clear previous overrides")
        XCTAssertNil(values["reasoningBudgetTokens"])
        let expected = try XCTUnwrap(body["expectedValues"] as? [String: Any])
        XCTAssertEqual(expected["reasoningEffort"] as? String, "high")
        XCTAssertEqual(expected["reasoningBudgetTokens"] as? Int, 2048)

        try await client.updateModelBehavior(
            role: "privacy-reviewer",
            assignment: "openai/gpt-example",
            values: ModelBehaviorValues(),
            expectedValues: ModelBehaviorValues(reasoningEnabled: false)
        )
        let resetBody = try XCTUnwrap(session.requests.last?.httpBody)
        let reset = try XCTUnwrap(JSONSerialization.jsonObject(with: resetBody) as? [String: Any])
        XCTAssertEqual(reset["assignment"] as? String, "openai/gpt-example")
        XCTAssertTrue(try XCTUnwrap(reset["values"] as? [String: Any]).isEmpty, "reset sends an empty override map")
        XCTAssertEqual(
            try XCTUnwrap(reset["expectedValues"] as? [String: Any])["reasoningEnabled"] as? Bool,
            false
        )
    }

    func testLogoRequestUsesGatewayAndRejectsNonSvgResponse() async throws {
        let session = MockSession()
        session.responder = { req in
            let response = HTTPURLResponse(
                url: req.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "image/svg+xml; charset=utf-8"]
            )!
            return (Data("<svg></svg>".utf8), response)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let svg = try await client.modelProviderLogo(providerId: "openai")
        XCTAssertEqual(svg, Data("<svg></svg>".utf8))
        XCTAssertEqual(session.requests.first?.url?.absoluteString, "http://mac.local:7600/model-logos/openai.svg")
        XCTAssertEqual(session.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")

        do {
            _ = try await client.modelProviderLogo(providerId: "../outside")
            XCTFail("Provider ids must be a single safe path segment")
        } catch GatewayClient.Error.invalidURL {
            XCTAssertEqual(session.requests.count, 1, "invalid ids must not reach the gateway")
        }

        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"oops\":true}", url: req.url!)
        }
        do {
            _ = try await client.modelProviderLogo(providerId: "openai")
            XCTFail("JSON must never be treated as an SVG")
        } catch GatewayClient.Error.invalidResponse {
            // Expected.
        }
    }

    func testModelOverviewDecodesProviderPresets() async throws {
        // The add-backend grid reads `presets`: id/name/defaultUrl always,
        // apiPathPrefix + knownModels + capabilities when present.
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"assignmentDisplays":{},"capabilities":[],
                "inference":{"backends":{},"assignments":{}},
                "catalog":[],"installed":[],
                "presets":[
                  {"id":"openai","name":"OpenAI","defaultUrl":"https://api.openai.com",
                   "knownModels":["gpt-4o","text-embedding-3-small"],"capabilities":["agent","embed"]},
                  {"id":"google","name":"Google AI (Gemini)","defaultUrl":"https://generativelanguage.googleapis.com",
                   "apiPathPrefix":"/v1beta/openai","knownModels":["gemini-2.5-flash"],"capabilities":["agent","embed"]}
                ],"modelsDir":"/m"}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let overview = try await client.modelOverview()
        XCTAssertEqual(overview.presets.count, 2)
        let openai = overview.presets.first { $0.id == "openai" }
        XCTAssertEqual(openai?.name, "OpenAI")
        XCTAssertEqual(openai?.defaultUrl, "https://api.openai.com")
        XCTAssertNil(openai?.apiPathPrefix)
        XCTAssertEqual(openai?.capabilities, ["agent", "embed"])
        let google = overview.presets.first { $0.id == "google" }
        XCTAssertEqual(google?.apiPathPrefix, "/v1beta/openai")
        XCTAssertEqual(google?.knownModels, ["gemini-2.5-flash"])
    }

    func testSystemInfoDecodesFitFields() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"platform":"linux","arch":"arm64","cpuModel":"x","cpuCount":8,
                 "totalRamGb":16,"freeRamGb":6.5,"metalSupported":false,"cudaSupported":true,
                 "modelsDir":"/m","modelsDirFreeGb":40.25}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let info = try await client.systemInfo()
        XCTAssertEqual(info.totalRamGb, 16)
        XCTAssertEqual(info.freeRamGb, 6.5)
        XCTAssertEqual(info.modelsDirFreeGb, 40.25)
        XCTAssertEqual(session.requests[0].url?.absoluteString, "http://mac.local:7600/admin/system-info")
    }

    func testInstallModelPostsIdAndDecodesDownloadId() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true,\"downloadId\":\"dl-9\"}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let id = try await client.installModel(id: "example-embed-v1.Q4_K_M")
        XCTAssertEqual(id, "dl-9")
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/models/install")))
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[0].httpBody)) as? [String: Any]
        XCTAssertEqual(decoded?["id"] as? String, "example-embed-v1.Q4_K_M")
    }

    func testCancelDownloadPostsIdAndDecodesCancelled() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true,\"cancelled\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let cancelled = try await client.cancelModelDownload(id: "example-embed-v1.Q4_K_M")
        XCTAssertTrue(cancelled)
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/models/cancel-download")))
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[0].httpBody)) as? [String: Any]
        XCTAssertEqual(decoded?["id"] as? String, "example-embed-v1.Q4_K_M")
    }

    func testUninstallModelSendsDeleteToId() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.uninstallModel(id: "example-embed-v1.Q4_K_M")
        XCTAssertEqual(session.requests[0].httpMethod, "DELETE")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/models/example-embed-v1.Q4_K_M")))
    }

    func testActivateModelSendsIdAndCatalogRole() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.activateModel(catalogId: "nomic.Q8", role: "embed")
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/models/activate")))
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[0].httpBody)) as? [String: Any]
        XCTAssertEqual(decoded?["id"] as? String, "nomic.Q8")
        XCTAssertEqual(decoded?["role"] as? String, "embed")
        XCTAssertNil(decoded?["capability"])
    }

    func testActivatePrivacyReviewerSendsIndependentCapabilityTarget() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.activateModel(
            catalogId: "example-agent.Q8",
            role: "agent",
            capability: "privacy-reviewer"
        )
        let decoded = try JSONSerialization.jsonObject(
            with: XCTUnwrap(session.requests[0].httpBody)
        ) as? [String: Any]
        XCTAssertEqual(decoded?["id"] as? String, "example-agent.Q8")
        XCTAssertEqual(decoded?["role"] as? String, "agent")
        XCTAssertEqual(decoded?["capability"] as? String, "privacy-reviewer")
    }

    func testAssignCapabilitySendsBackendValue() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.assignCapability(role: "ocr", assignment: "nstar/dots-ocr")
        XCTAssertEqual(session.requests[0].httpMethod, "PATCH")
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[0].httpBody)) as? [String: Any]
        let assignments = (decoded?["inference"] as? [String: Any])?["assignments"] as? [String: Any]
        XCTAssertEqual(assignments?["ocr"] as? String, "nstar/dots-ocr")
    }

    func testClearCapabilityEncodesExplicitNull() async throws {
        // The clear path must serialize `{"ocr": null}`, not drop the key — a
        // missing key is a no-op patch, not a clear.
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.assignCapability(role: "ocr", assignment: nil)
        let body = try String(data: XCTUnwrap(session.requests[0].httpBody), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("\"ocr\":null"), "expected explicit null, got: \(body)")
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[0].httpBody)) as? [String: Any]
        let assignments = (decoded?["inference"] as? [String: Any])?["assignments"] as? [String: Any]
        XCTAssertTrue(assignments?.keys.contains("ocr") == true, "key must be present")
        XCTAssertTrue(assignments?["ocr"] is NSNull, "value must be JSON null")
    }

    func testAddHttpBackendSendsTypedConfig() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.addHttpBackend(
            key: "my-vllm",
            url: "https://backend.example/v1",
            apiKey: "sk-example-secret",
            apiPathPrefix: "/v1beta/openai"
        )
        XCTAssertEqual(session.requests[0].httpMethod, "PATCH")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/config")))
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[0].httpBody)) as? [String: Any]
        let backends = (decoded?["inference"] as? [String: Any])?["backends"] as? [String: Any]
        let cfg = backends?["my-vllm"] as? [String: Any]
        XCTAssertEqual(cfg?["type"] as? String, "http")
        XCTAssertEqual(cfg?["url"] as? String, "https://backend.example/v1")
        XCTAssertEqual(cfg?["apiKey"] as? String, "sk-example-secret")
        XCTAssertEqual(cfg?["apiPathPrefix"] as? String, "/v1beta/openai")
    }

    func testAddHttpBackendOmitsBlankOptionalFields() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.addHttpBackend(key: "local-srv", url: "http://192.0.2.5:8000/v1")
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[0].httpBody)) as? [String: Any]
        let cfg = ((decoded?["inference"] as? [String: Any])?["backends"] as? [String: Any])?["local-srv"] as? [String: Any]
        // A keyless local server sends no apiKey / apiPathPrefix keys at all.
        XCTAssertNil(cfg?["apiKey"])
        XCTAssertNil(cfg?["apiPathPrefix"])
    }

    func testRemoveHttpBackendEncodesExplicitNull() async throws {
        // Like the capability clear, removing a backend must serialize an
        // explicit `{"<key>": null}` (a missing key is a no-op patch).
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.removeHttpBackend(key: "my-vllm")
        XCTAssertEqual(session.requests[0].httpMethod, "PATCH")
        let body = try String(data: XCTUnwrap(session.requests[0].httpBody), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("\"my-vllm\":null"), "expected explicit null, got: \(body)")
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[0].httpBody)) as? [String: Any]
        let backends = (decoded?["inference"] as? [String: Any])?["backends"] as? [String: Any]
        XCTAssertTrue(backends?["my-vllm"] is NSNull, "value must be JSON null")
    }

    func testProbeBackendDecodesResultAndTargetsKey() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: "{\"ok\":true,\"status\":\"ok\",\"models\":[\"m1\",\"m2\"]}",
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let result = try await client.probeBackend(key: "my-vllm")
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.status, "ok")
        XCTAssertEqual(result.models, ["m1", "m2"])
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue(
            try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/inference/backends/my-vllm/probe")),
            "unexpected URL: \(session.requests[0].url!.absoluteString)"
        )
    }

    func testProbeBackendDecodesUnreachableReason() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: "{\"ok\":false,\"status\":\"unreachable\",\"models\":[],\"reason\":\"connection refused\"}",
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let result = try await client.probeBackend(key: "down")
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.status, "unreachable")
        XCTAssertEqual(result.reason, "connection refused")
    }

    func testRefreshCodexBackendTargetsRefreshEndpoint() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"type":"codex","configured":true,"status":"ok","loggedIn":true,
                 "models":["gpt-example-frontier"],"modelRoles":{"gpt-example-frontier":["agent","background-agent"]}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let status = try await client.refreshCodexBackend()
        XCTAssertEqual(status.configured, true)
        XCTAssertEqual(status.models, ["gpt-example-frontier"])
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/inference/codex/refresh")))
    }

    func testStartCodexLoginDecodesDeviceFlow() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"id":"flow_1","status":"pending","verificationUri":"https://auth.openai.com/codex/device",
                 "userCode":"ABCD-12345","expiresAt":"2026-07-03T12:15:00Z"}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let flow = try await client.startCodexLogin()
        XCTAssertEqual(flow.userCode, "ABCD-12345")
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/inference/codex/login")))
    }

    func testGetAndCancelCodexLoginTargetLoginEndpoint() async throws {
        let session = MockSession()
        var count = 0
        session.responder = { [weak self] req in
            count += 1
            if count == 1 {
                return self!.makeResponse(
                    status: 200,
                    body: "{\"flow\":{\"id\":\"flow_1\",\"status\":\"pending\",\"userCode\":\"ABCD-12345\"}}",
                    url: req.url!
                )
            }
            return self!.makeResponse(
                status: 200,
                body: "{\"ok\":true,\"canceled\":true,\"flow\":{\"id\":\"flow_1\",\"status\":\"canceled\"}}",
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let flow = try await client.getCodexLogin()
        let cancel = try await client.cancelCodexLogin()
        XCTAssertEqual(flow?.userCode, "ABCD-12345")
        XCTAssertTrue(cancel.canceled)
        XCTAssertEqual(session.requests[0].httpMethod, "GET")
        XCTAssertEqual(session.requests[1].httpMethod, "DELETE")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/inference/codex/login")))
        XCTAssertTrue(try XCTUnwrap(session.requests[1].url?.absoluteString.hasSuffix("/admin/inference/codex/login")))
    }

    func testRemoveCodexBackendTargetsCodexEndpoint() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"ok":true,"status":{"type":"codex","configured":false,"status":"unreachable",
                 "loggedIn":false,"models":[],"reason":"Codex login removed."},
                 "clearedAssignments":["agent"]}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let result = try await client.removeCodexBackend()
        XCTAssertEqual(result.status.configured, false)
        XCTAssertEqual(result.clearedAssignments, ["agent"])
        XCTAssertEqual(session.requests[0].httpMethod, "DELETE")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/inference/codex")))
    }

    func testListModelCredentialsDecodesEntriesAndDropsHostname() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[{
                  "fileKey":"anthropic","providerType":"anthropic","providerName":"Anthropic",
                  "spec":{"fileKey":"anthropic","required":true,"publicClient":false,
                    "fields":[{"name":"apiKey","label":"API Key","placeholder":"sk-ant-…",
                      "secret":true,"pattern":"^sk-ant-.+$","patternHint":"starts with sk-ant-"}],
                    "wizard":{"intro":"","why":"","estMinutes":1,"steps":[]}},
                  "configured":true
                }],
                "pageInfo":{"hasMore":false,"limit":1},"hostname":"gateway-host"}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let entries = try await client.listModelCredentials()
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].fileKey, "anthropic")
        XCTAssertEqual(entries[0].providerName, "Anthropic")
        XCTAssertTrue(entries[0].configured)
        XCTAssertEqual(entries[0].spec.fields.count, 1)
        XCTAssertEqual(entries[0].spec.fields[0].name, "apiKey")
        XCTAssertEqual(entries[0].spec.fields[0].secret, true)
        XCTAssertEqual(session.requests[0].httpMethod, "GET")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/model-credentials")))
    }

    func testSetModelCredentialsPostsFieldsToFileKey() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true,\"fileKey\":\"anthropic\"}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.setModelCredentials(fileKey: "anthropic", fields: ["apiKey": "sk-ant-example0000"])
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/model-credentials/anthropic")))
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(session.requests[0].httpBody)) as? [String: Any]
        let fields = decoded?["fields"] as? [String: Any]
        XCTAssertEqual(fields?["apiKey"] as? String, "sk-ant-example0000")
    }

    func testClearModelCredentialsSendsDeleteToFileKey() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true,\"fileKey\":\"anthropic\"}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.clearModelCredentials(fileKey: "anthropic")
        XCTAssertEqual(session.requests[0].httpMethod, "DELETE")
        XCTAssertTrue(try XCTUnwrap(session.requests[0].url?.absoluteString.hasSuffix("/admin/model-credentials/anthropic")))
    }

    func testListSyncStatusesDecodesProgress() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[{
                  "sourceId":"apple-health:local",
                  "deviceId":"dev_1",
                  "members":[
                    {"sourceId":"apple-health:local","deviceId":"dev_1","state":"syncing","lastSyncAt":null},
                    {"sourceId":"apple-health:local","deviceId":"dev_2","state":"synced","lastSyncAt":"2026-09-03T12:00:00Z"}
                  ],
                  "state":"syncing",
                  "unitName":"samples",
                  "progress":{"phase":"bootstrap","total":100,"processed":40,"percentComplete":40.0,"message":"body metrics"},
                  "lastUpdated":1700000000000
                }],
                "pageInfo":{"hasMore":false,"limit":1}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let statuses = try await client.listSyncStatuses()
        XCTAssertEqual(statuses.count, 1)
        XCTAssertEqual(statuses[0].sourceId, "apple-health:local")
        XCTAssertEqual(statuses[0].state, "syncing")
        XCTAssertEqual(statuses[0].progress?.processed, 40)
        XCTAssertEqual(statuses[0].progress?.percentComplete, 40.0)
        XCTAssertEqual(statuses[0].progress?.total, 100)
        XCTAssertEqual(statuses[0].progress?.phase, "bootstrap")
        XCTAssertEqual(statuses[0].members?.count, 2)
        XCTAssertEqual(statuses[0].members?.last?.deviceId, "dev_2")
        XCTAssertEqual(statuses[0].members?.last?.lastSyncAt, "2026-09-03T12:00:00Z")
        XCTAssertEqual(statuses[0].status(forDeviceId: "dev_2")?.state, "synced")
        XCTAssertNil(statuses[0].status(forDeviceId: "missing"))
        XCTAssertNil(statuses[0].members?.last?.status(forDeviceId: "dev_1"))
    }

    // MARK: - Devices & tokens

    func testListDevicesDecodesPageItems() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[
                  {"id":"dev_1","name":"Studio Desktop","kind":"collector",
                   "pairedAt":1700000000000,"lastSeenAt":1700000100000,"online":true},
                  {"id":"dev_2","name":"Northstar Agent","kind":"agent","pairedAt":1700000200000,
                   "capabilities":{"agentIntegration":{"harness":"openclaw",
                   "deliveryProtocolMin":2,"deliveryProtocolMax":2,"maxConcurrentRuns":2}}}
                ],
                 "pageInfo":{"hasMore":false,"limit":2}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let devices = try await client.listDevices()
        XCTAssertEqual(devices.count, 2)
        XCTAssertEqual(devices[0].id, "dev_1")
        XCTAssertEqual(devices[0].kind, "collector")
        XCTAssertEqual(devices[0].online, true)
        XCTAssertNil(devices[1].lastSeenAt)
        XCTAssertEqual(devices[1].capabilities?.agentIntegration?.harness, "openclaw")
        XCTAssertEqual(devices[1].capabilities?.agentIntegration?.maxConcurrentRuns, 2)
        XCTAssertEqual(session.requests[0].url?.absoluteString, "http://mac.local:7600/admin/devices")
        XCTAssertEqual(session.requests[0].httpMethod, "GET")
    }

    func testReportPushHealthSendsStrictBodyToSameDeviceEndpoint() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: #"{"ok":true,"updatedAt":1786788000000}"#,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_admin", session: session)

        try await client.reportPushHealth(deviceId: "dev_1", status: "scheduled-summary")

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://mac.local:7600/admin/devices/dev_1/push-health"
        )
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_admin")
        let json = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String]
        XCTAssertEqual(json, ["status": "scheduled-summary"])
    }

    func testListTokensSendsDeviceIdQueryAndDecodes() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[
                  {"id":"tok_1","deviceId":"dev_1","name":"sync","scopes":["read","write:*"],
                   "createdAt":1700000000000,"lastUsedAt":1700000050000}
                ],
                 "pageInfo":{"hasMore":false,"limit":1}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let tokens = try await client.listTokens(deviceId: "dev_1")
        XCTAssertEqual(tokens.count, 1)
        XCTAssertEqual(tokens[0].id, "tok_1")
        XCTAssertEqual(tokens[0].scopes, ["read", "write:*"])
        let absolute = session.requests[0].url?.absoluteString ?? ""
        XCTAssertTrue(absolute.contains("/admin/tokens"))
        XCTAssertTrue(absolute.contains("deviceId=dev_1"))
        XCTAssertEqual(session.requests[0].httpMethod, "GET")
    }

    func testRevokeTokenSendsDeleteToId() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.revokeToken(id: "tok_1")
        XCTAssertEqual(session.requests[0].httpMethod, "DELETE")
        XCTAssertTrue((session.requests[0].url?.absoluteString ?? "").hasSuffix("/admin/tokens/tok_1"))
    }

    func testRevokeDeviceSendsDeleteToId() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: "{\"ok\":true}", url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        try await client.revokeDevice(id: "dev_1")
        XCTAssertEqual(session.requests[0].httpMethod, "DELETE")
        XCTAssertTrue((session.requests[0].url?.absoluteString ?? "").hasSuffix("/admin/devices/dev_1"))
    }

    func testCreatePairingPostsBodyAndDecodesCode() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: "{\"pairingCode\":\"7K3M-9QX2\",\"expiresAt\":1700000600000}",
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let pending = try await client.createPairing(kind: "ios")
        XCTAssertEqual(pending.pairingCode, "7K3M-9QX2")
        XCTAssertEqual(pending.expiresAt, 1_700_000_600_000)
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue((session.requests[0].url?.absoluteString ?? "").hasSuffix("/admin/devices/pair"))
        let body = session.requests[0].httpBody ?? Data()
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        // The kind alone: the gateway fills in its canonical grant.
        XCTAssertEqual(decoded?.keys.sorted(), ["kind"])
        XCTAssertEqual(decoded?["kind"] as? String, "ios")
    }

    func testCreateRepairPairingBindsExistingDevice() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: "{\"pairingCode\":\"7K3M-9QX2\",\"expiresAt\":1700000600000}",
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        _ = try await client.createPairing(kind: "android", repairDeviceId: "device_existing")
        let body = session.requests[0].httpBody ?? Data()
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(decoded?.keys.sorted(), ["kind", "repairDeviceId"])
        XCTAssertEqual(decoded?["kind"] as? String, "android")
        XCTAssertEqual(decoded?["repairDeviceId"] as? String, "device_existing")
    }

    func testBuildPairQrPostsBodyAndUnwrapsPayload() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: "{\"qrPayload\":\"{\\\"v\\\":3,\\\"gatewayUrl\\\":\\\"https://192.0.2.42:7600\\\"}\"}",
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let payload = try await client.buildPairQr(
            pairingCode: "7K3M-9QX2",
            gatewayUrl: "https://192.0.2.42:7600"
        )
        XCTAssertTrue(payload.contains("\"v\":3"))
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue((session.requests[0].url?.absoluteString ?? "").hasSuffix("/admin/devices/pair-qr"))
        let body = session.requests[0].httpBody ?? Data()
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(decoded?["pairingCode"] as? String, "7K3M-9QX2")
        XCTAssertEqual(decoded?["gatewayUrl"] as? String, "https://192.0.2.42:7600")
        XCTAssertEqual(decoded?["trustMode"] as? String, "auto")
    }

    func testBuildPairQrFallsBackForAnOlderGateway() async throws {
        let session = MockSession()
        session.responder = { [weak self, weak session] req in
            if session?.requests.count == 1 {
                return self!.makeResponse(
                    status: 400,
                    body: "{\"error\":\"Validation failed\",\"code\":\"VALIDATION_ERROR\",\"detail\":[{\"path\":\"/trustMode\"}]}",
                    url: req.url!
                )
            }
            return self!.makeResponse(
                status: 200,
                body: "{\"qrPayload\":\"{\\\"v\\\":3}\"}",
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let payload = try await client.buildPairQr(
            pairingCode: "7K3M-9QX2",
            gatewayUrl: "https://host.example:7600"
        )
        XCTAssertEqual(payload, "{\"v\":3}")
        XCTAssertEqual(session.requests.count, 2)
        let retryBody = session.requests[1].httpBody ?? Data()
        let retry = try JSONSerialization.jsonObject(with: retryBody) as? [String: Any]
        XCTAssertNil(retry?["trustMode"])
    }

    func testListNetworkIdentitiesDecodesPageItems() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"items":[
                  {"address":"192.0.2.42","label":"LAN","kind":"lan","offLan":false},
                  {"address":"198.51.100.7","label":"Tailscale","kind":"tailscale","offLan":true}
                ],
                 "pageInfo":{"hasMore":false,"limit":2}}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let identities = try await client.listNetworkIdentities()
        XCTAssertEqual(identities.count, 2)
        XCTAssertEqual(identities[0].address, "192.0.2.42")
        XCTAssertEqual(identities[1].offLan, true)
        XCTAssertEqual(session.requests[0].url?.absoluteString, "http://mac.local:7600/admin/network-identities")
    }

    // MARK: - Backend verify

    func testVerifyModelPostsBodyAndDecodesVerdict() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(
                status: 200,
                body: """
                {"role":"embedder","model":"text-embed-3","supported":true,"detail":"768-dim vectors"}
                """,
                url: req.url!
            )
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let verdict = try await client.verifyModel(
            key: "my-vllm",
            model: "text-embed-3",
            role: "embedder",
            force: true
        )
        XCTAssertTrue(verdict.supported)
        XCTAssertEqual(verdict.role, "embedder")
        XCTAssertEqual(verdict.detail, "768-dim vectors")
        XCTAssertEqual(session.requests[0].httpMethod, "POST")
        XCTAssertTrue((session.requests[0].url?.absoluteString ?? "").hasSuffix("/admin/inference/backends/my-vllm/verify"))
        let body = session.requests[0].httpBody ?? Data()
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(decoded?["model"] as? String, "text-embed-3")
        XCTAssertEqual(decoded?["role"] as? String, "embedder")
        XCTAssertEqual(decoded?["force"] as? Bool, true)
    }

    // MARK: - Pairing QR gateway-URL host swap

    func testSwapHostPreservesSchemeAndPort() throws {
        // The portal swaps only the host, keeping the gateway's real scheme/port.
        XCTAssertEqual(
            try swapHost(into: XCTUnwrap(URL(string: "https://mac.local:7600")), host: "198.51.100.7"),
            "https://198.51.100.7:7600"
        )
        // Non-default port is preserved (the bug this guards against was a
        // hardcoded :7600).
        XCTAssertEqual(
            try swapHost(into: XCTUnwrap(URL(string: "https://mac.local:17600")), host: "192.0.2.42"),
            "https://192.0.2.42:17600"
        )
        // Plain HTTP origin keeps its scheme (no port → none added).
        XCTAssertEqual(
            try swapHost(into: XCTUnwrap(URL(string: "http://mac.local")), host: "192.0.2.42"),
            "http://192.0.2.42"
        )
        // No origin → https fallback, no port assumed.
        XCTAssertEqual(swapHost(into: nil, host: "192.0.2.42"), "https://192.0.2.42")
    }
}
