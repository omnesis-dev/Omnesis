// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Fixtures shared by the Decision model logic tests: providers as the
/// gateway's presets describe them, and overviews built around them.
enum DecisionFixtures {
    static let ollaya = DecisionPresetView(
        id: "ollaya",
        name: "Ollaya",
        kind: "local",
        url: "http://127.0.0.1:11435/v1/systemone",
        models: [DecisionModelOption(id: "kev", source: "preset"), DecisionModelOption(id: "laya", source: "preset")]
    )
    static let typesafe = DecisionPresetView(
        id: "typesafe",
        name: "TypeSafe",
        kind: "cloud",
        url: "https://api.typesafe.ai/v1/systemone",
        keyRequired: true,
        builtIn: "typesafe",
        models: [DecisionModelOption(id: "jev-1.14.0", source: "preset")]
    )
    static let openRouter = DecisionPresetView(
        id: "openrouter",
        name: "OpenRouter",
        kind: "cloud",
        url: "https://openrouter.ai/api/v1/systemone",
        keyRequired: true,
        models: [
            DecisionModelOption(id: "liquid/d1.1", contextTokens: 131_072, inputCostPerMillion: 0.05, source: "preset"),
        ]
    )
    static let cloudflare = DecisionPresetView(
        id: "cloudflare",
        name: "Cloudflare Workers AI",
        kind: "cloud",
        url: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
        protocol: "workers-ai",
        keyRequired: true,
        urlParams: [DecisionPresetURLParam(key: "account", label: "Account ID")]
    )
    static let fastino = DecisionPresetView(
        id: "fastino",
        name: "Fastino",
        kind: "cloud",
        url: "https://api.fastino.ai/v1/systemone",
        auth: "x-api-key",
        scoreField: "expected_level",
        keyRequired: true
    )
    static let ollama = DecisionPresetView(id: "ollama", name: "Ollama", kind: "local", url: "http://127.0.0.1:11434/v1/systemone")

    static let decisionCap = CapabilityMeta(
        role: "decision", title: "Decision model", description: "d", icon: "scale", backendFamily: "typed-decision"
    )

    static func overview(
        decision: ResolvedAssignment? = nil,
        decisionBackends: [String: DecisionBackendStatus]? = [:],
        httpBackends: [String: BackendStatus] = [:],
        allowRemoteInference: Bool? = false,
        typesafeOnHost: Bool = false,
        presets: [DecisionPresetView]? = [openRouter, ollaya, typesafe, cloudflare, ollama]
    )
        -> ModelsOverview {
        ModelsOverview(
            assignmentDisplays: [:],
            capabilities: [decisionCap],
            inference: InferenceOverview(
                backends: httpBackends,
                assignments: decision.map { ["decision": $0] } ?? [:],
                allowRemoteInference: allowRemoteInference,
                typesafe: TypeSafeEndpointStatus(url: typesafe.url, selfHosted: false, onHost: typesafeOnHost),
                decisionBackends: decisionBackends
            ),
            catalog: [],
            installed: [],
            decisionPresets: presets
        )
    }

    /// The patch as the JSON object the gateway receives.
    static func json(_ patch: DecisionConfigPatch) throws -> NSDictionary {
        let data = try JSONEncoder().encode(patch)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }
}

final class DecisionModelSetupTests: XCTestCase {
    private typealias Setup = DecisionModelSetup

    // MARK: - Configurability and providers

    func testDecisionCardIsConfigurableOnlyWhenTheGatewaySendsPresets() {
        let cap = DecisionFixtures.decisionCap
        XCTAssertTrue(Setup.isConfigurable(cap, in: DecisionFixtures.overview()))
        XCTAssertFalse(Setup.isConfigurable(cap, in: DecisionFixtures.overview(presets: nil)))
        let agent = CapabilityMeta(role: "agent", title: "Agent", description: "d", icon: "bot")
        XCTAssertTrue(Setup.isConfigurable(agent, in: DecisionFixtures.overview(presets: nil)))
        let unknownFamily = CapabilityMeta(role: "x", title: "X", description: "d", icon: "bot", backendFamily: "other")
        XCTAssertFalse(Setup.isConfigurable(unknownFamily, in: DecisionFixtures.overview()))
    }

    func testProviderGroupsListBackendsFirstThenLocalThenTypeSafeFirst() {
        let overview = DecisionFixtures.overview(decisionBackends: [
            "zeta": DecisionBackendStatus(url: "https://decide.example.com/v1/systemone"),
            "ollaya": DecisionBackendStatus(preset: "ollaya", url: "http://127.0.0.1:11435/v1/systemone", onHost: true),
        ])
        let groups = Setup.providerGroups(overview)
        XCTAssertEqual(groups.existing.map(\.key), ["ollaya", "zeta"])
        XCTAssertEqual(groups.existing.first?.preset?.id, "ollaya")
        XCTAssertTrue(groups.existing[0].listsModels)
        // A hand-added server may list its models wherever it runs.
        XCTAssertNil(groups.existing[1].preset)
        XCTAssertTrue(groups.existing[1].listsModels)
        let hosted = Setup.ExistingBackend(
            key: "openrouter",
            status: DecisionBackendStatus(preset: "openrouter", url: "https://openrouter.ai/api/v1/systemone"),
            preset: DecisionFixtures.openRouter
        )
        XCTAssertFalse(hosted.listsModels)
        XCTAssertEqual(groups.local.map(\.id), ["ollaya", "ollama"])
        XCTAssertEqual(groups.cloud.map(\.id), ["typesafe", "openrouter", "cloudflare"])
    }

    // MARK: - Names

    func testNameValidationMirrorsTheGatewayRules() {
        let overview = DecisionFixtures.overview(
            decisionBackends: ["ollaya": DecisionBackendStatus(url: "http://127.0.0.1:11435/v1/systemone")],
            httpBackends: ["vllm": BackendStatus(type: "http", status: "ok")]
        )
        XCTAssertNil(Setup.validateName("my-decider", in: overview))
        XCTAssertNil(Setup.validateName("  ollama  ", in: overview))
        XCTAssertEqual(Setup.validateName("  ", in: overview), "Enter a name.")
        XCTAssertEqual(Setup.validateName("a/b", in: overview), "A name cannot contain “/”.")
        for reserved in ["local", "anthropic", "codex", "claude-code", "replay", "typesafe"] {
            XCTAssertEqual(Setup.validateName(reserved, in: overview), "“\(reserved)” is reserved. Pick another name.")
        }
        XCTAssertNil(Setup.validateName(String(repeating: "a", count: 64), in: overview))
        XCTAssertEqual(Setup.validateName(String(repeating: "a", count: 65), in: overview), "Use 64 characters or fewer.")
        // The gateway counts UTF-16 code units: each of these is two.
        XCTAssertNil(Setup.validateName(String(repeating: "😀", count: 32), in: overview))
        XCTAssertEqual(Setup.validateName(String(repeating: "😀", count: 33), in: overview), "Use 64 characters or fewer.")
        XCTAssertEqual(Setup.validateName(".", in: overview), "“.” cannot name a backend.")
        XCTAssertEqual(Setup.validateName(" .. ", in: overview), "“..” cannot name a backend.")
        XCTAssertNil(Setup.validateName("v1.2", in: overview))
        XCTAssertEqual(Setup.validateName("\n\t", in: overview), "Enter a name.")
        XCTAssertEqual(Setup.validateName("vllm", in: overview), "An HTTP backend is already called “vllm”.")
        XCTAssertEqual(
            Setup.validateName("ollaya", in: overview),
            "A decision backend is already called “ollaya”. Pick it from the list instead."
        )
    }

    func testDefaultNameIsThePresetIdOrTheNextFreeSuffix() {
        XCTAssertEqual(Setup.defaultName(for: DecisionFixtures.ollaya, in: DecisionFixtures.overview()), "ollaya")
        let taken = DecisionFixtures.overview(
            decisionBackends: ["ollaya": DecisionBackendStatus(url: "http://127.0.0.1:11435/v1/systemone")],
            httpBackends: ["ollaya-2": BackendStatus(type: "http", status: "ok")]
        )
        XCTAssertEqual(Setup.defaultName(for: DecisionFixtures.ollaya, in: taken), "ollaya-3")
    }

    // MARK: - URLs and consent

    func testFillURLEncodesEachParameterLikeEncodeURIComponent() {
        let preset = DecisionFixtures.cloudflare
        XCTAssertEqual(
            Setup.fillURL(preset, values: ["account": " 0123abcd "]),
            .ready("https://api.cloudflare.com/client/v4/accounts/0123abcd/ai/run")
        )
        XCTAssertEqual(
            Setup.fillURL(preset, values: ["account": "team a/b?c"]),
            .ready("https://api.cloudflare.com/client/v4/accounts/team%20a%2Fb%3Fc/ai/run")
        )
        XCTAssertEqual(Setup.fillURL(preset, values: [:]), .missing("Account ID"))
        XCTAssertEqual(Setup.fillURL(preset, values: ["account": "   "]), .missing("Account ID"))
        XCTAssertEqual(Setup.fillURL(DecisionFixtures.ollaya, values: [:]), .ready("http://127.0.0.1:11435/v1/systemone"))
        let undeclared = DecisionPresetView(id: "x", name: "X", kind: "cloud", url: "https://{region}.example.com/v1")
        XCTAssertEqual(Setup.fillURL(undeclared, values: [:]), .missing("region"))
    }

    func testURLValidationNeedsAnHTTPURLWithAHost() {
        XCTAssertNil(Setup.validateURL("http://127.0.0.1:8080/v1/systemone"))
        XCTAssertNil(Setup.validateURL(" https://decide.example.com/v1/systemone "))
        XCTAssertEqual(Setup.validateURL(""), "Enter the server's URL.")
        XCTAssertNotNil(Setup.validateURL("127.0.0.1:8080"))
        XCTAssertNotNil(Setup.validateURL("ftp://decide.example.com"))
    }

    func testLoopbackMatchesTheGatewaysDefinition() {
        for url in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:11435/v1",
            "http://127.4.5.6/v1",
            "http://[::1]:8080/v1",
            "http://decider.localhost/v1",
            "http://LOCALHOST/v1",
        ] {
            XCTAssertTrue(Setup.isLoopback(url), url)
        }
        for url in [
            "http://192.0.2.20:11434/v1",
            "https://openrouter.ai/api/v1/systemone",
            "http://127.example.com/v1",
            "http://127.0.0/v1",
            "not a url",
        ] {
            XCTAssertFalse(Setup.isLoopback(url), url)
        }
    }

    func testConsentIsNeededOnlyOffHostWhileCloudInferenceIsOff() {
        let remote = "https://openrouter.ai/api/v1/systemone"
        let local = "http://127.0.0.1:11435/v1/systemone"
        XCTAssertTrue(Setup.needsRemoteConsent(url: remote, in: DecisionFixtures.overview(allowRemoteInference: false)))
        XCTAssertTrue(Setup.needsRemoteConsent(url: remote, in: DecisionFixtures.overview(allowRemoteInference: nil)))
        XCTAssertFalse(Setup.needsRemoteConsent(url: remote, in: DecisionFixtures.overview(allowRemoteInference: true)))
        XCTAssertFalse(Setup.needsRemoteConsent(url: local, in: DecisionFixtures.overview(allowRemoteInference: false)))
        XCTAssertTrue(Setup.typesafeNeedsRemoteConsent(in: DecisionFixtures.overview(allowRemoteInference: false)))
        XCTAssertFalse(Setup.typesafeNeedsRemoteConsent(in: DecisionFixtures.overview(allowRemoteInference: true)))
        XCTAssertFalse(Setup.typesafeNeedsRemoteConsent(
            in: DecisionFixtures.overview(allowRemoteInference: false, typesafeOnHost: true)
        ))
        let message = Setup.consentMessage(model: "liquid/d1.1", provider: "OpenRouter")
        XCTAssertTrue(message.hasPrefix("Using liquid/d1.1 sends messages, conversation context, "), message)
        XCTAssertTrue(message.contains("Omnesis data and tool results to OpenRouter."), message)
    }

    // MARK: - Models

    func testModelOptionsPutServerModelsFirstWithoutDuplicates() {
        let options = Setup.modelOptions(preset: DecisionFixtures.ollaya, probed: ["winnow:e4b", "kev", "winnow:e4b"])
        XCTAssertEqual(options.map(\.id), ["winnow:e4b", "kev", "laya"])
        XCTAssertEqual(options[0].source, "probe")
        XCTAssertEqual(options[1].source, "preset")
        XCTAssertEqual(Setup.modelOptions(preset: nil, probed: []), [])
    }

    func testModelDetailShowsContextAndPriceWhenKnown() {
        XCTAssertEqual(
            Setup.modelDetail(DecisionModelOption(id: "m", contextTokens: 131_072, inputCostPerMillion: 0.05)),
            "128K context · $0.05 per million input tokens"
        )
        XCTAssertEqual(Setup.modelDetail(DecisionModelOption(id: "m", contextTokens: 200_000)), "200K context")
        XCTAssertEqual(Setup.modelDetail(DecisionModelOption(id: "m", contextTokens: 1_000_000)), "1M context")
        XCTAssertEqual(Setup.modelDetail(DecisionModelOption(id: "m", inputCostPerMillion: 0)), "free")
        XCTAssertEqual(Setup.modelDetail(DecisionModelOption(id: "m", inputCostPerMillion: 0.004)), "$0.004 per million input tokens")
        XCTAssertEqual(Setup.modelDetail(DecisionModelOption(id: "m", source: "probe")), "on the server")
        XCTAssertNil(Setup.modelDetail(DecisionModelOption(id: "m", source: "preset")))
    }

    func testFormDefaultsPrefillNameURLAndTheModelInUse() {
        let backend = Setup.ExistingBackend(
            key: "ollaya",
            status: DecisionBackendStatus(preset: "ollaya", url: "http://127.0.0.1:11435/v1/systemone", onHost: true),
            preset: DecisionFixtures.ollaya
        )
        let inUse = DecisionFixtures.overview(
            decision: ResolvedAssignment(kind: "decision", model: "laya", backendKey: "ollaya"),
            decisionBackends: ["ollaya": backend.status]
        )
        XCTAssertEqual(
            Setup.formDefaults(.existing(backend), in: inUse),
            Setup.FormDefaults(name: "ollaya", url: "http://127.0.0.1:11435/v1/systemone", model: "laya")
        )
        XCTAssertEqual(Setup.formDefaults(.existing(backend), in: DecisionFixtures.overview()).model, "kev")
        XCTAssertEqual(
            Setup.formDefaults(.preset(DecisionFixtures.ollaya), in: inUse),
            Setup.FormDefaults(name: "ollaya-2", url: "http://127.0.0.1:11435/v1/systemone", model: "kev")
        )
        let typesafeInUse = DecisionFixtures.overview(decision: ResolvedAssignment(kind: "typesafe", model: "jev-1.13.0"))
        XCTAssertEqual(
            Setup.formDefaults(.preset(DecisionFixtures.typesafe), in: typesafeInUse),
            Setup.FormDefaults(name: "", url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0")
        )
        XCTAssertEqual(Setup.formDefaults(.custom, in: inUse), Setup.FormDefaults(name: "", url: "", model: ""))
    }
}
