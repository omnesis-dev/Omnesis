// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
@testable import Omnesis
import XCTest

@available(iOS 17.0, *)
final class ModelManagementTests: XCTestCase {
    // MARK: - Three-way capability state (mirrors capability-state.js)

    func testStateEnabledWhenLocalAvailable() {
        let assignment = ResolvedAssignment(kind: "local", available: true)
        XCTAssertEqual(ModelManagement.state(assignment), .on)
        XCTAssertTrue(ModelManagement.isConfigured(assignment))
    }

    func testStateNeedsAttentionWhenConfiguredButUnavailable() {
        let assignment = ResolvedAssignment(kind: "http", available: false, reason: "Backend unreachable")
        XCTAssertEqual(ModelManagement.state(assignment), .warn)
        XCTAssertTrue(ModelManagement.isConfigured(assignment))
    }

    func testStateOffWhenDisabledOrUnresolved() {
        XCTAssertEqual(ModelManagement.state(ResolvedAssignment(kind: "disabled")), .off)
        XCTAssertEqual(ModelManagement.state(ResolvedAssignment(kind: "unresolved", reason: "x")), .off)
        XCTAssertEqual(ModelManagement.state(nil), .off)
        XCTAssertFalse(ModelManagement.isConfigured(ResolvedAssignment(kind: "disabled")))
    }

    func testReplayCountsAsEnabled() {
        XCTAssertEqual(ModelManagement.state(ResolvedAssignment(kind: "replay")), .on)
    }

    // MARK: - Capability → catalog role mapping

    func testCatalogRoleMapping() {
        XCTAssertEqual(ModelManagement.catalogRole(for: "embedder"), "embed")
        XCTAssertEqual(ModelManagement.catalogRole(for: "agent"), "agent")
        XCTAssertEqual(ModelManagement.catalogRole(for: "privacy-reviewer"), "agent")
        XCTAssertEqual(ModelManagement.catalogRole(for: "watch-judge"), "agent")
        XCTAssertEqual(ModelManagement.catalogRole(for: "transcriber"), "transcribe")
        // OCR has no catalog role — only backend models / clear apply to it.
        XCTAssertNil(ModelManagement.catalogRole(for: "ocr"))
    }

    func testWatchJudgeIsLabelledAndVerifiable() {
        XCTAssertEqual(ModelManagement.roleLabel("watch-judge"), "Watch judge")
        XCTAssertTrue(ModelManagement.verifiableRoles.contains("watch-judge"))
    }

    // MARK: - Picker options

    private func overview() -> ModelsOverview {
        ModelsOverview(
            assignmentDisplays: [:],
            capabilities: [],
            inference: InferenceOverview(
                backends: [
                    "northstar": BackendStatus(
                        type: "http",
                        status: "ok",
                        url: "http://example.local:9000/v1",
                        models: ["dots-ocr", "llama-vision-8b", "embed-model"],
                        modelRoles: [
                            "dots-ocr": ["ocr"],
                            "llama-vision-8b": ["ocr", "agent"],
                            "embed-model": ["embedder"],
                        ],
                        hasApiKey: false
                    ),
                    "anthropic": BackendStatus(type: "anthropic", status: "ok"),
                ],
                assignments: [:]
            ),
            catalog: [
                CatalogEntry(kind: "gguf", id: "nomic.Q8", name: "nomic-embed", roles: ["embed"]),
                CatalogEntry(kind: "gguf", id: "not-installed.Q8", name: "other-embed", roles: ["embed"]),
                CatalogEntry(kind: "anthropic-api", id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", roles: ["agent"]),
                CatalogEntry(kind: "anthropic-api", id: "anthropic/claude-fable-5", name: "Claude Fable 5", roles: ["agent"]),
            ],
            installed: [ManifestEntry(id: "nomic.Q8")]
        )
    }

    private func overviewWithCodex(configured: Bool = true) -> ModelsOverview {
        let base = overview()
        return ModelsOverview(
            assignmentDisplays: base.assignmentDisplays,
            capabilities: base.capabilities,
            inference: InferenceOverview(
                backends: base.inference.backends,
                codex: CodexBackendStatus(
                    configured: configured,
                    status: configured ? "ok" : "unreachable",
                    loggedIn: configured,
                    models: configured ? ["gpt-example-frontier", "gpt-example-mini"] : [],
                    modelDetails: configured
                        ? [
                            CodexModelStatus(id: "gpt-example-frontier", name: "GPT Example Frontier", recommended: true),
                            CodexModelStatus(id: "gpt-example-mini", name: "GPT Example Mini"),
                        ]
                        : nil,
                    modelRoles: configured
                        ? [
                            "gpt-example-frontier": ["agent", "background-agent"],
                            "gpt-example-mini": ["agent", "background-agent"],
                        ]
                        : nil
                ),
                assignments: base.inference.assignments
            ),
            catalog: base.catalog,
            installed: base.installed,
            activeDownloads: base.activeDownloads,
            presets: base.presets
        )
    }

    private func overviewWithResponsesBackend() -> ModelsOverview {
        let base = overview()
        var backends = base.inference.backends
        backends["responses-only"] = BackendStatus(
            type: "http",
            status: "ok",
            url: "https://example.com/v1",
            protocol: "responses",
            models: ["agent-model"],
            modelRoles: ["agent-model": ["agent", "watch-judge"]]
        )
        return ModelsOverview(
            assignmentDisplays: base.assignmentDisplays,
            capabilities: base.capabilities,
            inference: InferenceOverview(backends: backends, assignments: base.inference.assignments),
            catalog: base.catalog,
            installed: base.installed,
            activeDownloads: base.activeDownloads,
            presets: base.presets
        )
    }

    func testResponsesBackendIsExcludedOnlyForWatchJudge() {
        let value = overviewWithResponsesBackend()
        XCTAssertFalse(ModelManagement.pickerOptions(capabilityRole: "watch-judge", overview: value)
            .contains { $0.providerId == "responses-only" })
        XCTAssertFalse(ModelManagement.pickerBackends(capabilityRole: "watch-judge", overview: value)
            .contains { $0.providerId == "responses-only" })
        XCTAssertTrue(ModelManagement.pickerOptions(capabilityRole: "agent", overview: value)
            .contains { $0.providerId == "responses-only" })
        XCTAssertTrue(ModelManagement.pickerBackends(capabilityRole: "agent", overview: value)
            .contains { $0.providerId == "responses-only" })
    }

    func testBackendProtocolDecodes() throws {
        let status = try JSONDecoder().decode(
            BackendStatus.self,
            from: Data(#"{"type":"http","status":"ok","protocol":"responses"}"#.utf8)
        )
        XCTAssertEqual(status.protocol, "responses")
    }

    func testEmbedderOptionsIncludeInstalledGgufAndBackendModel() {
        let opts = ModelManagement.pickerOptions(capabilityRole: "embedder", overview: overview())
        let ids = opts.map(\.id)
        XCTAssertTrue(ids.contains("local/nomic.Q8"), "installed GGUF offered")
        XCTAssertFalse(ids.contains("local/not-installed.Q8"), "not-downloaded GGUF excluded")
        XCTAssertTrue(ids.contains("northstar/embed-model"), "role-matching backend model offered")
    }

    func testGgufActivateUsesCatalogRole() {
        let opts = ModelManagement.pickerOptions(capabilityRole: "embedder", overview: overview())
        let local = opts.first { $0.id == "local/nomic.Q8" }
        XCTAssertEqual(
            local?.apply,
            .activate(catalogId: "nomic.Q8", catalogRole: "embed", capabilityRole: "embedder")
        )
    }

    func testBackendModelUsesAssignValue() {
        let opts = ModelManagement.pickerOptions(capabilityRole: "ocr", overview: overview())
        let backend = opts.first { $0.id == "northstar/dots-ocr" }
        XCTAssertEqual(backend?.apply, .assign(value: "northstar/dots-ocr"))
    }

    func testOcrOptionsOnlyFromBackends() {
        // OCR has no catalog role → only backend models can serve it.
        let opts = ModelManagement.pickerOptions(capabilityRole: "ocr", overview: overview())
        let ids = Set(opts.map(\.id))
        XCTAssertEqual(ids, ["northstar/dots-ocr", "northstar/llama-vision-8b"])
    }

    func testAgentOptionsIncludeAnthropicCatalogAndBackend() {
        let opts = ModelManagement.pickerOptions(capabilityRole: "agent", overview: overview())
        let ids = Set(opts.map(\.id))
        XCTAssertTrue(ids.contains("anthropic/anthropic/claude-sonnet-5"))
        XCTAssertTrue(ids.contains("anthropic/anthropic/claude-fable-5"))
        XCTAssertTrue(ids.contains("northstar/llama-vision-8b"))
    }

    func testPrivacyReviewerCatalogActivationTargetsReviewerCapability() {
        let opts = ModelManagement.pickerOptions(capabilityRole: "privacy-reviewer", overview: overview())
        let anthropic = opts.first { $0.providerId == "anthropic" }
        XCTAssertEqual(
            anthropic?.apply,
            .activate(
                catalogId: "anthropic/claude-sonnet-5",
                catalogRole: "agent",
                capabilityRole: "privacy-reviewer"
            )
        )
    }

    func testAgentOptionsIncludeConfiguredCodexModels() {
        let opts = ModelManagement.pickerOptions(capabilityRole: "agent", overview: overviewWithCodex())
        let codex = opts.filter { $0.providerId == "codex" }
        XCTAssertEqual(codex.map(\.id), ["codex/gpt-example-frontier", "codex/gpt-example-mini"])
        XCTAssertEqual(codex.first?.label, "GPT Example Frontier")
        XCTAssertEqual(codex.first?.apply, .assign(value: "codex/gpt-example-frontier"))
    }

    func testCodexOptionsServeAgentLikeRolesAndRequireConfiguredBackend() {
        XCTAssertTrue(
            ModelManagement.pickerOptions(capabilityRole: "background-agent", overview: overviewWithCodex())
                .contains { $0.providerId == "codex" }
        )
        XCTAssertFalse(
            ModelManagement.pickerOptions(capabilityRole: "embedder", overview: overviewWithCodex())
                .contains { $0.providerId == "codex" }
        )
        XCTAssertFalse(
            ModelManagement.pickerOptions(capabilityRole: "agent", overview: overviewWithCodex(configured: false))
                .contains { $0.providerId == "codex" }
        )
    }

    func testCodexLoginAutoPollOnlyRunsForVisiblePendingFlow() {
        let pending = CodexLoginFlow(id: "flow_1", status: "pending")
        let complete = CodexLoginFlow(id: "flow_1", status: "complete")
        let loggedOut = CodexBackendStatus(configured: true, status: "unreachable", loggedIn: false, models: [])
        let loggedIn = CodexBackendStatus(configured: true, status: "ok", loggedIn: true, models: ["gpt-example-frontier"])

        XCTAssertTrue(BackendsContent.shouldAutoPollCodexLogin(showSheet: true, flow: pending, status: loggedOut))
        XCTAssertTrue(BackendsContent.shouldAutoPollCodexLogin(showSheet: true, flow: pending, status: nil))
        XCTAssertFalse(BackendsContent.shouldAutoPollCodexLogin(showSheet: false, flow: pending, status: loggedOut))
        XCTAssertFalse(BackendsContent.shouldAutoPollCodexLogin(showSheet: true, flow: complete, status: loggedOut))
        XCTAssertFalse(BackendsContent.shouldAutoPollCodexLogin(showSheet: true, flow: nil, status: loggedOut))
        XCTAssertFalse(BackendsContent.shouldAutoPollCodexLogin(showSheet: true, flow: pending, status: loggedIn))
    }

    // MARK: - Picker backend grid (two-level flow)

    func testPickerBackendsGroupsLocalAnthropicThenHttp() {
        // Agent role: the local GGUF doesn't serve `agent`, so no Local tile;
        // the anthropic catalog entry + the northstar backend's agent model do.
        let backends = ModelManagement.pickerBackends(capabilityRole: "agent", overview: overview())
        let ids = backends.map(\.providerId)
        XCTAssertEqual(ids, ["anthropic", "northstar"], "anthropic first, then HTTP backends by key")
        let anthropic = backends.first { $0.providerId == "anthropic" }
        XCTAssertEqual(anthropic?.optionCount, 2)
        XCTAssertFalse(anthropic?.isHttp ?? true)
        let northstar = backends.first { $0.providerId == "northstar" }
        XCTAssertTrue(northstar?.isHttp ?? false)
        XCTAssertEqual(northstar?.url, "http://example.local:9000/v1")
    }

    func testPickerBackendsIncludesCodexOnlyWhenConfiguredForAgent() {
        let backends = ModelManagement.pickerBackends(capabilityRole: "agent", overview: overviewWithCodex())
        XCTAssertEqual(backends.map(\.providerId), ["codex", "anthropic", "northstar"])
        XCTAssertEqual(backends.first { $0.providerId == "codex" }?.optionCount, 2)
        XCTAssertFalse(
            ModelManagement.pickerBackends(capabilityRole: "agent", overview: overviewWithCodex(configured: false))
                .contains { $0.providerId == "codex" }
        )
    }

    func testPickerBackendsIncludeLocalTileWhenRoleMatches() {
        // Embedder role: the installed GGUF serves `embed`, so a Local tile shows
        // with a count of 1; northstar's `embed-model` is the HTTP tile.
        let backends = ModelManagement.pickerBackends(capabilityRole: "embedder", overview: overview())
        let local = backends.first { $0.providerId == "local" }
        XCTAssertNotNil(local)
        XCTAssertEqual(local?.optionCount, 1)
        XCTAssertEqual(backends.first?.providerId, "local", "Local tile leads")
    }

    func testPickerBackendsKeepHttpBackendWithZeroMatches() {
        // Transcriber role: northstar advertises no transcriber model, but the
        // HTTP tile still appears (count 0) so the user can type a custom id.
        let backends = ModelManagement.pickerBackends(capabilityRole: "transcriber", overview: overview())
        let northstar = backends.first { $0.providerId == "northstar" }
        XCTAssertNotNil(northstar, "HTTP backend listed even with no role-matching models")
        XCTAssertEqual(northstar?.optionCount, 0)
    }

    func testFilteredPickerOptionsByProviderAndSearch() {
        // The model-list pane filters by providerId then a case-insensitive search.
        let all = ModelManagement.pickerOptions(
            capabilityRole: "ocr",
            overview: overview(),
            forProviderId: "northstar",
            search: ""
        )
        XCTAssertEqual(Set(all.map(\.id)), ["northstar/dots-ocr", "northstar/llama-vision-8b"])
        let filtered = ModelManagement.pickerOptions(
            capabilityRole: "ocr",
            overview: overview(),
            forProviderId: "northstar",
            search: "DOTS"
        )
        XCTAssertEqual(filtered.map(\.id), ["northstar/dots-ocr"])
    }

    func testPickerSearchMatchesEveryTokenAcrossLabelAndId() {
        // "llama vision" is not a substring of the id, but both tokens occur —
        // the same fuzzy rule as the portal (finds DeepSeek-V4-Flash by
        // "deepseek flash"). Token order does not matter; every token must match.
        let forward = ModelManagement.pickerOptions(
            capabilityRole: "agent",
            overview: overview(),
            forProviderId: "northstar",
            search: "llama vision"
        )
        XCTAssertEqual(forward.map(\.id), ["northstar/llama-vision-8b"])
        let backward = ModelManagement.pickerOptions(
            capabilityRole: "agent",
            overview: overview(),
            forProviderId: "northstar",
            search: "vision llama"
        )
        XCTAssertEqual(backward.map(\.id), ["northstar/llama-vision-8b"])
        let missing = ModelManagement.pickerOptions(
            capabilityRole: "agent",
            overview: overview(),
            forProviderId: "northstar",
            search: "llama nomatch"
        )
        XCTAssertTrue(missing.isEmpty)
    }

    func testFuzzyMatchModelIdVectors() {
        XCTAssertTrue(ModelManagement.fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", query: "deepseek flash"))
        XCTAssertTrue(ModelManagement.fuzzyMatchModelId("gpt-4o-mini", query: "gpt-4o"))
        XCTAssertTrue(ModelManagement.fuzzyMatchModelId("anything", query: ""))
        XCTAssertTrue(ModelManagement.fuzzyMatchModelId("anything", query: "   "))
        XCTAssertTrue(ModelManagement.fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", query: "  deepseek   flash  "))
        XCTAssertTrue(ModelManagement.fuzzyMatchModelId("Qwen/Qwen3-8B", query: "qwen 8b"))
        XCTAssertFalse(ModelManagement.fuzzyMatchModelId("deepseek-ai/DeepSeek-V4-Flash-0731", query: "deepseek grok"))
        XCTAssertFalse(ModelManagement.fuzzyMatchModelId("gpt-4o", query: "gpt claude"))
    }

    func testFuzzyMatchFieldsLetsTokensSpanFields() {
        XCTAssertTrue(ModelManagement.fuzzyMatchFields(["gpt-4o", "GPT Example"], query: "example 4o"))
        XCTAssertFalse(ModelManagement.fuzzyMatchFields(["gpt-4o", "GPT Example"], query: "example grok"))
        XCTAssertTrue(ModelManagement.fuzzyMatchFields(["gpt-4o", nil], query: "gpt"))
    }

    // MARK: - Recently used entries (GET /admin/models/recent)

    func testRecentPickerOptionMapsAssignEntries() {
        let option = ModelManagement.recentPickerOption(
            capabilityRole: "agent",
            entry: RecentModelEntry(
                assignment: "northstar/llama-vision-8b",
                providerId: "northstar",
                providerLabel: "Studio Northstar",
                modelName: "llama-vision-8b",
                apply: RecentModelApply(type: "assign", value: "northstar/llama-vision-8b")
            )
        )
        XCTAssertEqual(option?.id, "northstar/llama-vision-8b")
        XCTAssertEqual(option?.providerId, "northstar")
        XCTAssertEqual(option?.label, "llama-vision-8b")
        XCTAssertEqual(option?.apply, .assign(value: "northstar/llama-vision-8b"))
    }

    func testRecentPickerOptionMapsActivateEntries() {
        let option = ModelManagement.recentPickerOption(
            capabilityRole: "agent",
            entry: RecentModelEntry(
                assignment: "anthropic/anthropic/claude-sonnet-5",
                providerId: "anthropic",
                providerLabel: "Anthropic",
                modelName: "Claude Sonnet 5",
                apply: RecentModelApply(
                    type: "activate",
                    catalogId: "anthropic/claude-sonnet-5",
                    catalogRole: "agent"
                )
            )
        )
        XCTAssertEqual(
            option?.apply,
            .activate(catalogId: "anthropic/claude-sonnet-5", catalogRole: "agent", capabilityRole: "agent")
        )
    }

    func testRecentPickerOptionSkipsIncompleteEntries() {
        // Missing apply payload details → nil so the UI skips the row.
        XCTAssertNil(ModelManagement.recentPickerOption(
            capabilityRole: "agent",
            entry: RecentModelEntry(assignment: "x/y", apply: RecentModelApply(type: "assign"))
        ))
        XCTAssertNil(ModelManagement.recentPickerOption(
            capabilityRole: "agent",
            entry: RecentModelEntry(assignment: "local/z", apply: RecentModelApply(type: "activate"))
        ))
        XCTAssertNil(ModelManagement.recentPickerOption(
            capabilityRole: "agent",
            entry: RecentModelEntry(assignment: "x/y", apply: RecentModelApply(type: "bogus", value: "x/y"))
        ))
    }

    // MARK: - Recently used fetching (GET /admin/models/recent)

    private final class StubSession: URLSessionLike, @unchecked Sendable {
        var status = 200
        var body = "{}"
        var failure: Error?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            if let failure { throw failure }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
    }

    private func recentClient(_ session: StubSession) -> AdminClient {
        AdminClient(baseURL: URL(string: "http://mac.local:7600")!, token: "omn_t", session: session)
    }

    func testLoadRecentReturnsEntriesOnSuccess() async {
        let session = StubSession()
        session.body = """
        {
          "capability": "agent",
          "entries": [
            {
              "assignment": "northstar/llama-vision-8b",
              "providerId": "northstar",
              "providerLabel": "Studio Northstar",
              "modelName": "llama-vision-8b",
              "apply": {"type": "assign", "value": "northstar/llama-vision-8b"}
            }
          ]
        }
        """
        let entries = await ModelManagement.loadRecent(client: recentClient(session), capability: "agent")
        XCTAssertEqual(entries.map(\.assignment), ["northstar/llama-vision-8b"])
    }

    func testLoadRecentHidesSectionOnNotFound() async {
        // An older gateway without the route answers 404 — the picker hides
        // the section instead of failing.
        let session = StubSession()
        session.status = 404
        let entries = await ModelManagement.loadRecent(client: recentClient(session), capability: "agent")
        XCTAssertTrue(entries.isEmpty)
    }

    func testLoadRecentHidesSectionOnTransportFailure() async {
        let session = StubSession()
        session.failure = URLError(.cannotConnectToHost)
        let entries = await ModelManagement.loadRecent(client: recentClient(session), capability: "agent")
        XCTAssertTrue(entries.isEmpty)
    }

    // MARK: - Backend-name validation (mirrors model-config.js nameValid)

    func testBackendNameValidationAcceptsOrdinaryNames() {
        XCTAssertNil(ModelManagement.validateBackendName("my-vllm"))
        XCTAssertNil(ModelManagement.validateBackendName("studio_local"))
        // Leading/trailing whitespace is trimmed before validating.
        XCTAssertNil(ModelManagement.validateBackendName("  ollama  "))
    }

    func testBackendNameValidationRejectsReservedAndSlash() {
        XCTAssertNotNil(ModelManagement.validateBackendName("local"))
        XCTAssertNotNil(ModelManagement.validateBackendName("anthropic"))
        XCTAssertNotNil(ModelManagement.validateBackendName("codex"))
        XCTAssertNotNil(ModelManagement.validateBackendName("replay"))
        XCTAssertNotNil(ModelManagement.validateBackendName("foo/bar"))
        XCTAssertNotNil(ModelManagement.validateBackendName(""))
        XCTAssertNotNil(ModelManagement.validateBackendName("   "))
    }

    // MARK: - HTTP backends list

    func testHttpBackendsExcludesAnthropicAndSortsByKey() {
        let rows = ModelManagement.httpBackends(overview())
        // The anthropic (non-http) backend is filtered out; only `northstar` remains.
        XCTAssertEqual(rows.map(\.key), ["northstar"])
        XCTAssertEqual(rows.first?.status.type, "http")
    }

    // MARK: - Behavioral capability verify targets

    func testVerifyTargetsOnlyVerifiableRolesSortedByModelThenRole() throws {
        let row = try XCTUnwrap(ModelManagement.httpBackends(overview()).first { $0.key == "northstar" })
        let targets = ModelManagement.verifyTargets(row)
        // `dots-ocr` is OCR-only → no verifiable role → excluded entirely.
        // `llama-vision-8b` claims ocr+agent → only `agent` is verifiable.
        // `embed-model` claims embedder → verifiable.
        // Sorted by model then role: embed-model/embedder, llama-vision-8b/agent.
        XCTAssertEqual(
            targets.map(\.id),
            ["northstar/embed-model/embedder", "northstar/llama-vision-8b/agent"]
        )
    }

    func testVerifyTargetsEmptyWhenNoVerifiableRoleModel() {
        // An OCR-only / unreachable backend (empty modelRoles) offers no targets.
        let row = ModelManagement.BackendRow(
            key: "ocr-only",
            status: BackendStatus(
                type: "http",
                status: "ok",
                models: ["dots-ocr"],
                modelRoles: ["dots-ocr": ["ocr"]]
            )
        )
        XCTAssertTrue(ModelManagement.verifyTargets(row).isEmpty)
    }

    func testRoleLabelFallsBackToRawId() {
        XCTAssertEqual(ModelManagement.roleLabel("embedder"), "Embedder")
        XCTAssertEqual(ModelManagement.roleLabel("agent"), "Agent")
        XCTAssertEqual(ModelManagement.roleLabel("privacy-reviewer"), "Privacy reviewer")
        XCTAssertEqual(ModelManagement.roleLabel("future-role"), "future-role")
    }

    // MARK: - Credential-field validation (mirrors validateCredentialFields)

    private func anthropicSpec() -> CredentialSpec {
        CredentialSpec(fields: [
            CredentialField(
                name: "apiKey",
                label: "API Key",
                placeholder: "sk-ant-…",
                secret: true,
                pattern: "^sk-ant-[A-Za-z0-9_-]+$",
                patternHint: "API keys start with sk-ant-."
            ),
        ])
    }

    func testCredentialValidationAcceptsMatchingTrimmedValue() {
        let result = ModelManagement.validateCredentialFields(
            ["apiKey": "  sk-ant-example0000  "],
            spec: anthropicSpec()
        )
        guard case .valid(let cleaned) = result else {
            return XCTFail("expected valid, got \(result)")
        }
        // Whitespace trimmed; only declared fields returned.
        XCTAssertEqual(cleaned, ["apiKey": "sk-ant-example0000"])
    }

    func testCredentialValidationRejectsMissingRequiredField() {
        let result = ModelManagement.validateCredentialFields([:], spec: anthropicSpec())
        guard case .invalid(let reason) = result else {
            return XCTFail("expected invalid")
        }
        XCTAssertTrue(reason.contains("API Key"))
    }

    func testCredentialValidationRejectsPatternMismatchWithHint() {
        let result = ModelManagement.validateCredentialFields(
            ["apiKey": "not-a-real-key"],
            spec: anthropicSpec()
        )
        guard case .invalid(let reason) = result else {
            return XCTFail("expected invalid")
        }
        XCTAssertEqual(reason, "API keys start with sk-ant-.")
    }

    func testCredentialValidationAllowsFieldWithoutPattern() {
        let spec = CredentialSpec(fields: [CredentialField(name: "apiKey", label: "API Key", secret: true)])
        let result = ModelManagement.validateCredentialFields(["apiKey": "anything-goes"], spec: spec)
        guard case .valid(let cleaned) = result else {
            return XCTFail("expected valid")
        }
        XCTAssertEqual(cleaned, ["apiKey": "anything-goes"])
    }

    // MARK: - Local-model lifecycle helpers (mirrors lib/model-format.js)

    func testFormatBytes() {
        XCTAssertEqual(ModelManagement.formatBytes(nil), "—")
        XCTAssertEqual(ModelManagement.formatBytes(512), "512 B")
        XCTAssertEqual(ModelManagement.formatBytes(2048), "2.0 KB")
        XCTAssertEqual(ModelManagement.formatBytes(5 * 1024 * 1024), "5.0 MB")
        XCTAssertEqual(ModelManagement.formatBytes(2 * 1024 * 1024 * 1024), "2.00 GB")
    }

    func testDownloadPercentClampsAndFloors() {
        XCTAssertEqual(
            ModelManagement.downloadPercent(DownloadProgress(downloadedBytes: 0, totalBytes: 0, speedBytesPerSec: 0, etaMs: -1)),
            0
        )
        XCTAssertEqual(
            ModelManagement.downloadPercent(DownloadProgress(downloadedBytes: 50, totalBytes: 200, speedBytesPerSec: 1, etaMs: 1)),
            25
        )
        // Floors, not rounds: 99.6% → 99.
        XCTAssertEqual(
            ModelManagement.downloadPercent(DownloadProgress(downloadedBytes: 996, totalBytes: 1000, speedBytesPerSec: 1, etaMs: 1)),
            99
        )
        // Over-reported bytes clamp to 100.
        XCTAssertEqual(
            ModelManagement.downloadPercent(DownloadProgress(downloadedBytes: 1200, totalBytes: 1000, speedBytesPerSec: 1, etaMs: 1)),
            100
        )
    }

    private func ggufEntry(id: String, sizeBytes: Int?, minRamGb: Double?) -> CatalogEntry {
        CatalogEntry(kind: "gguf", id: id, name: id, roles: ["embed"], sizeBytes: sizeBytes, minRamGb: minRamGb)
    }

    func testFitWarningsRamAndDisk() {
        let entry = ggufEntry(id: "m", sizeBytes: 50 * 1024 * 1024 * 1024, minRamGb: 8)
        let sys = SystemInfo(totalRamGb: 16, freeRamGb: 4, modelsDirFreeGb: 10)
        let warnings = ModelManagement.fitWarnings(entry, system: sys)
        XCTAssertEqual(warnings.count, 2)
        XCTAssertTrue(warnings.contains { $0.text.contains("8 GB free RAM") })
        XCTAssertTrue(warnings.contains { $0.text.contains("Disk free") })
    }

    func testFitWarningsEmptyWhenFitsOrNoSnapshot() {
        let entry = ggufEntry(id: "m", sizeBytes: 1024 * 1024 * 1024, minRamGb: 2)
        let roomy = SystemInfo(totalRamGb: 32, freeRamGb: 16, modelsDirFreeGb: 100)
        XCTAssertTrue(ModelManagement.fitWarnings(entry, system: roomy).isEmpty)
        XCTAssertTrue(ModelManagement.fitWarnings(entry, system: nil).isEmpty)
    }

    func testLocalModelRowsDeriveState() {
        let overview = ModelsOverview(
            assignmentDisplays: [:],
            capabilities: [],
            inference: InferenceOverview(backends: [:], assignments: [:]),
            catalog: [
                ggufEntry(id: "installed-one", sizeBytes: 100, minRamGb: nil),
                ggufEntry(id: "downloading-one", sizeBytes: 200, minRamGb: nil),
                ggufEntry(id: "available-one", sizeBytes: 300, minRamGb: nil),
                CatalogEntry(kind: "gguf", id: "agent-only", name: "agent-only", roles: ["agent"]),
            ],
            installed: [ManifestEntry(id: "installed-one")],
            activeDownloads: [
                ActiveDownload(
                    downloadId: "d1",
                    modelId: "downloading-one",
                    filename: "downloading-one.gguf",
                    progress: DownloadProgress(downloadedBytes: 100, totalBytes: 200, speedBytesPerSec: 1, etaMs: 1),
                    startedAt: "2026-01-01T00:00:00Z"
                ),
            ]
        )
        let rows = ModelManagement.localModelRows(capabilityRole: "embedder", overview: overview, system: nil)
        // Only embed-role GGUFs; the agent-only one is excluded.
        XCTAssertEqual(rows.map(\.entry.id), ["installed-one", "downloading-one", "available-one"])
        XCTAssertEqual(rows[0].state, .installed)
        XCTAssertEqual(rows[1].state, .downloading(percent: 50))
        XCTAssertEqual(rows[2].state, .available)
    }

    func testLocalModelRowsEmptyForRolesWithoutCatalogRole() {
        let overview = ModelsOverview(
            assignmentDisplays: [:],
            capabilities: [],
            inference: InferenceOverview(backends: [:], assignments: [:]),
            catalog: [ggufEntry(id: "m", sizeBytes: 1, minRamGb: nil)],
            installed: []
        )
        // ocr has no catalog role → no local GGUF list.
        XCTAssertTrue(ModelManagement.localModelRows(capabilityRole: "ocr", overview: overview, system: nil).isEmpty)
    }
}
#endif
