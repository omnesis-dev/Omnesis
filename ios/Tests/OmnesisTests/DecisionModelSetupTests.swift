// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Fixtures shared by the Decision model logic tests: providers as the
/// gateway's presets describe them, backends as `/admin/models` reports them,
/// and overviews built around them.
enum DecisionFixtures {
    static func decisionOnly(
        _ id: String,
        name: String,
        kind: String = "cloud",
        _ decision: ProviderDecisionPreset
    )
        -> ProviderPreset {
        ProviderPreset(id: id, name: name, kind: kind, capabilities: ["decision"], decision: decision)
    }

    static let ollaya = decisionOnly("ollaya", name: "Ollaya", kind: "local", ProviderDecisionPreset(
        url: "http://127.0.0.1:11435/v1/systemone",
        models: [DecisionModelOption(id: "kev", source: "preset"), DecisionModelOption(id: "laya", source: "preset")]
    ))
    static let typesafe = ProviderPreset(
        id: "typesafe",
        name: "TypeSafe",
        capabilities: ["decision"],
        decision: ProviderDecisionPreset(
            url: "https://api.typesafe.ai/v1/systemone",
            keyRequired: true,
            models: [DecisionModelOption(id: "jev-1.14.0", source: "preset")]
        ),
        builtIn: "typesafe"
    )
    /// Chat and decision models behind one key.
    static let openRouter = ProviderPreset(
        id: "openrouter",
        name: "OpenRouter",
        defaultUrl: "https://openrouter.ai/api",
        capabilities: ["agent", "decision"],
        decision: ProviderDecisionPreset(
            url: "https://openrouter.ai/api/v1/systemone",
            keyRequired: true,
            models: [
                DecisionModelOption(id: "liquid/d1.1", contextTokens: 131_072, inputCostPerMillion: 0.05, source: "preset"),
            ]
        )
    )
    static let fireworks = ProviderPreset(
        id: "fireworks",
        name: "Fireworks AI",
        defaultUrl: "https://api.fireworks.ai/inference",
        capabilities: ["agent", "embed", "decision"],
        decision: ProviderDecisionPreset(
            url: "https://api.fireworks.ai/inference/v1/systemone",
            keyRequired: true,
            models: [DecisionModelOption(id: "accounts/fireworks/models/rune", source: "preset")]
        )
    )
    static let groq = ProviderPreset(id: "groq", name: "Groq", defaultUrl: "https://api.groq.com/openai", capabilities: ["agent"])
    static let cloudflare = decisionOnly("cloudflare", name: "Cloudflare Workers AI", ProviderDecisionPreset(
        url: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
        protocol: "workers-ai",
        keyRequired: true,
        urlParams: [DecisionPresetURLParam(key: "account", label: "Account ID")]
    ))
    static let fastino = decisionOnly("fastino", name: "Fastino", ProviderDecisionPreset(
        url: "https://api.fastino.ai/v1/systemone",
        auth: "x-api-key",
        scoreField: "expected_level",
        keyRequired: true
    ))
    static let ollama = decisionOnly("ollama", name: "Ollama", kind: "local", ProviderDecisionPreset(
        url: "http://127.0.0.1:11434/v1/systemone"
    ))

    /// `presets` as the gateway sends it: providers with an OpenAI-compatible API.
    static let openAIPresets = [openRouter, fireworks, groq]
    /// `decisionProviders`: providers that serve only decision models.
    static let decisionProviders = [ollaya, typesafe, cloudflare, ollama]
    static let presets = openAIPresets + decisionProviders

    static let decisionCap = CapabilityMeta(
        role: "decision", title: "Decision model", description: "d", icon: "scale", backendFamily: "typed-decision"
    )

    /// A backend that serves only decision models.
    static func decisionBackend(
        _ url: String,
        preset: String? = nil,
        hasApiKey: Bool = false,
        _ decision: BackendDecisionStatus? = nil
    )
        -> BackendStatus {
        BackendStatus(
            type: "http",
            status: "ok",
            hasApiKey: hasApiKey,
            preset: preset,
            decision: decision ?? BackendDecisionStatus(url: url, hasApiKey: hasApiKey)
        )
    }

    /// A backend that serves OpenAI-compatible models, with a decision API when given.
    static func chatBackend(
        _ url: String,
        preset: String? = nil,
        hasApiKey: Bool = true,
        decision: BackendDecisionStatus? = nil
    )
        -> BackendStatus {
        BackendStatus(type: "http", status: "ok", url: url, hasApiKey: hasApiKey, preset: preset, decision: decision)
    }

    static func overview(
        decision: ResolvedAssignment? = nil,
        backends: [String: BackendStatus] = [:],
        allowRemoteInference: Bool? = false,
        typesafeOnHost: Bool = false,
        presets: [ProviderPreset] = openAIPresets,
        decisionProviders: [ProviderPreset] = decisionProviders
    )
        -> ModelsOverview {
        ModelsOverview(
            assignmentDisplays: [:],
            capabilities: [decisionCap],
            inference: InferenceOverview(
                backends: backends,
                assignments: decision.map { ["decision": $0] } ?? [:],
                allowRemoteInference: allowRemoteInference,
                typesafe: TypeSafeEndpointStatus(url: typesafe.decision?.url, selfHosted: false, onHost: typesafeOnHost)
            ),
            catalog: [],
            installed: [],
            presets: presets,
            decisionProviders: decisionProviders
        )
    }

    /// The patch as the JSON object the gateway receives.
    static func json(_ patch: some Encodable) throws -> NSDictionary {
        let data = try JSONEncoder().encode(patch)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }
}

final class DecisionModelSetupTests: XCTestCase {
    private typealias Setup = DecisionModelSetup

    // MARK: - Configurability and providers

    func testDecisionCardIsConfigurableOnlyWhenAPresetDescribesADecisionAPI() {
        let cap = DecisionFixtures.decisionCap
        XCTAssertTrue(Setup.isConfigurable(cap, in: DecisionFixtures.overview()))
        let older = DecisionFixtures.overview(presets: [DecisionFixtures.groq], decisionProviders: [])
        XCTAssertFalse(Setup.isConfigurable(cap, in: older))
        XCTAssertFalse(Setup.isConfigurable(cap, in: DecisionFixtures.overview(presets: [], decisionProviders: [])))
        // A provider with both APIs in `presets` is enough on its own.
        XCTAssertTrue(Setup.isConfigurable(cap, in: DecisionFixtures.overview(decisionProviders: [])))
        let agent = CapabilityMeta(role: "agent", title: "Agent", description: "d", icon: "bot")
        XCTAssertTrue(Setup.isConfigurable(agent, in: older))
        let unknownFamily = CapabilityMeta(role: "x", title: "X", description: "d", icon: "bot", backendFamily: "other")
        XCTAssertFalse(Setup.isConfigurable(unknownFamily, in: DecisionFixtures.overview()))
    }

    func testProviderListOrdersDecisionBackendsThenExistingKeysThenTypeSafeThenProviders() {
        let overview = DecisionFixtures.overview(backends: [
            "zeta": DecisionFixtures.decisionBackend("https://decide.example.com/v1/systemone"),
            "ollaya": DecisionFixtures.decisionBackend("http://127.0.0.1:11435/v1/systemone", preset: "ollaya"),
            "fireworks": DecisionFixtures.chatBackend("https://api.fireworks.ai/inference", preset: "fireworks"),
            "openrouter": DecisionFixtures.chatBackend(
                "https://openrouter.ai/api",
                preset: "openrouter",
                decision: BackendDecisionStatus(url: "https://openrouter.ai/api/v1/systemone", hasApiKey: true)
            ),
            // Chat backends whose provider has no decision API, or none known.
            "groq": DecisionFixtures.chatBackend("https://api.groq.com/openai", preset: "groq"),
            "vllm": DecisionFixtures.chatBackend("http://127.0.0.1:8000"),
            // The gateway refuses a decision API on a backend called typesafe.
            "typesafe": DecisionFixtures.chatBackend("https://openrouter.ai/api", preset: "openrouter"),
            "anthropic": BackendStatus(type: "anthropic", status: "ok"),
        ])
        let groups = Setup.providerGroups(overview)
        XCTAssertEqual(groups.existing.map(\.key), ["ollaya", "openrouter", "zeta"])
        XCTAssertEqual(groups.existing.first?.preset?.id, "ollaya")
        XCTAssertTrue(groups.existing[0].listsModels)
        XCTAssertFalse(groups.existing[1].listsModels, "a hosted provider is never asked for its models")
        // A hand-added server may list its models wherever it runs.
        XCTAssertNil(groups.existing[2].preset)
        XCTAssertTrue(groups.existing[2].listsModels)
        XCTAssertEqual(groups.enable.map(\.key), ["fireworks"])
        XCTAssertEqual(groups.typesafe?.id, "typesafe")
        // A provider a backend was made from is offered as that backend only.
        XCTAssertEqual(groups.add.map(\.id), ["ollama", "cloudflare"])
    }

    func testAddAProviderOmitsEveryPresetABackendWasMadeFrom() {
        let overview = DecisionFixtures.overview(backends: [
            // Answering decisions already.
            "ollaya": DecisionFixtures.decisionBackend("http://127.0.0.1:11435/v1/systemone", preset: "ollaya"),
            // Offered under "Use a backend you have".
            "fireworks": DecisionFixtures.chatBackend("https://api.fireworks.ai/inference", preset: "fireworks"),
            // Named anything: its preset still counts.
            "team-router": DecisionFixtures.chatBackend(
                "https://openrouter.ai/api",
                preset: "openrouter",
                decision: BackendDecisionStatus(url: "https://openrouter.ai/api/v1/systemone")
            ),
        ])
        let groups = Setup.providerGroups(overview)
        XCTAssertEqual(groups.existing.map(\.key), ["ollaya", "team-router"])
        XCTAssertEqual(groups.enable.map(\.key), ["fireworks"])
        XCTAssertEqual(groups.typesafe?.id, "typesafe")
        XCTAssertEqual(groups.add.map(\.id), ["ollama", "cloudflare"])
    }

    func testProviderListWithoutBackendsOffersEveryDecisionProvider() {
        let groups = Setup.providerGroups(DecisionFixtures.overview())
        XCTAssertEqual(groups.existing, [])
        XCTAssertEqual(groups.enable, [])
        XCTAssertEqual(groups.add.map(\.id), ["ollaya", "ollama", "openrouter", "fireworks", "cloudflare"])
        XCTAssertNil(Setup.providerGroups(DecisionFixtures.overview(decisionProviders: [])).typesafe)
    }

    // MARK: - Names

    func testNameValidationMirrorsTheGatewayRules() {
        let overview = DecisionFixtures.overview(backends: [
            "ollaya": DecisionFixtures.decisionBackend("http://127.0.0.1:11435/v1/systemone"),
            "vllm": BackendStatus(type: "http", status: "ok"),
        ])
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
        XCTAssertEqual(Setup.validateName("vllm", in: overview), "A backend is already called “vllm”.")
        XCTAssertEqual(Setup.validateName("ollaya", in: overview), "A backend is already called “ollaya”.")
    }

    func testDefaultNameIsThePresetIdOrTheNextFreeSuffix() {
        XCTAssertEqual(Setup.defaultName(for: DecisionFixtures.ollaya, in: DecisionFixtures.overview()), "ollaya")
        let taken = DecisionFixtures.overview(backends: [
            "ollaya": DecisionFixtures.decisionBackend("http://127.0.0.1:11435/v1/systemone"),
            "ollaya-2": BackendStatus(type: "http", status: "ok"),
        ])
        XCTAssertEqual(Setup.defaultName(for: DecisionFixtures.ollaya, in: taken), "ollaya-3")
    }

    // MARK: - URLs and consent

    func testFillURLEncodesEachParameterLikeEncodeURIComponent() throws {
        let preset = try XCTUnwrap(DecisionFixtures.cloudflare.decision)
        let ollaya = try XCTUnwrap(DecisionFixtures.ollaya.decision)
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
        XCTAssertEqual(Setup.fillURL(ollaya, values: [:]), .ready("http://127.0.0.1:11435/v1/systemone"))
        let undeclared = ProviderDecisionPreset(url: "https://{region}.example.com/v1")
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
        let off = DecisionFixtures.overview(allowRemoteInference: false)
        XCTAssertTrue(Setup.needsRemoteConsent(urls: [remote], in: off))
        XCTAssertTrue(Setup.needsRemoteConsent(urls: [remote], in: DecisionFixtures.overview(allowRemoteInference: nil)))
        XCTAssertFalse(Setup.needsRemoteConsent(urls: [remote], in: DecisionFixtures.overview(allowRemoteInference: true)))
        XCTAssertFalse(Setup.needsRemoteConsent(urls: [local], in: off))
        // A provider with both APIs asks when either leaves the host.
        XCTAssertTrue(Setup.needsRemoteConsent(urls: [local, "https://openrouter.ai/api"], in: off))
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
        let status = DecisionFixtures.decisionBackend("http://127.0.0.1:11435/v1/systemone", preset: "ollaya")
        let backend = Setup.ExistingBackend(key: "ollaya", status: status, preset: DecisionFixtures.ollaya)
        let inUse = DecisionFixtures.overview(
            decision: ResolvedAssignment(kind: "decision", model: "laya", backendKey: "ollaya"),
            backends: ["ollaya": status]
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
        let fireworks = Setup.ExistingBackend(
            key: "fw",
            status: DecisionFixtures.chatBackend("https://api.fireworks.ai/inference", preset: "fireworks"),
            preset: DecisionFixtures.fireworks
        )
        XCTAssertEqual(
            Setup.formDefaults(.enable(fireworks), in: inUse),
            Setup.FormDefaults(
                name: "fw",
                url: "https://api.fireworks.ai/inference/v1/systemone",
                model: "accounts/fireworks/models/rune"
            )
        )
        let typesafeInUse = DecisionFixtures.overview(decision: ResolvedAssignment(kind: "typesafe", model: "jev-1.13.0"))
        XCTAssertEqual(
            Setup.formDefaults(.preset(DecisionFixtures.typesafe), in: typesafeInUse),
            Setup.FormDefaults(name: "", url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0")
        )
        XCTAssertEqual(Setup.formDefaults(.custom, in: inUse), Setup.FormDefaults(name: "", url: "", model: ""))
    }
}
