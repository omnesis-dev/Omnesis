// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Decision model fixtures for previews and snapshots: a slice of the
/// gateway's provider presets (names and URLs as the gateway ships them, with
/// illustrative context sizes and prices), backends serving OpenAI-compatible models,
/// decision models or both, and the Models overview in each state the
/// Decision sheet renders.
@available(iOS 17.0, *)
enum DecisionPreviewData {
    static let ollaya = ProviderPreset(
        id: "ollaya",
        name: "Ollaya",
        kind: "local",
        capabilities: ["decision"],
        decision: ProviderDecisionPreset(
            url: "http://127.0.0.1:11435/v1/systemone",
            docsUrl: "https://ollaya.dev/docs/api",
            note: "Runs open decision models on this machine. Pull a model with `ollaya pull <model>` first.",
            models: ["kev", "laya", "d1"].map { DecisionModelOption(id: $0, source: "preset") }
        )
    )

    static let ollama = ProviderPreset(
        id: "ollama",
        name: "Ollama",
        kind: "local",
        capabilities: ["decision"],
        decision: ProviderDecisionPreset(
            url: "http://127.0.0.1:11434/v1/systemone",
            docsUrl: "https://docs.ollama.com/api/systemone",
            note: "Ollama serves decision models too. Pull a model with `ollama pull <model>` first.",
            models: ["d3:4b", "kev:4b-q8_0"].map { DecisionModelOption(id: $0, source: "preset") }
        )
    )

    static let typesafe = ProviderPreset(
        id: "typesafe",
        name: "TypeSafe",
        capabilities: ["decision"],
        decision: ProviderDecisionPreset(
            url: "https://api.typesafe.ai/v1/systemone",
            keyRequired: true,
            docsUrl: "https://docs.typesafe.ai/api",
            keyUrl: "https://console.typesafe.ai/keys",
            note: "Jev, the model every decision threshold was tuned on.",
            models: [
                DecisionModelOption(id: "jev-1.14.0", contextTokens: 32768, inputCostPerMillion: 0.2, source: "preset"),
                DecisionModelOption(id: "jev-1.13.0", source: "preset"),
            ]
        ),
        builtIn: "typesafe"
    )

    /// A provider with both APIs: OpenAI-compatible and decision models, one key.
    static let openRouter = ProviderPreset(
        id: "openrouter",
        name: "OpenRouter",
        modelsDevId: "openrouter",
        defaultUrl: "https://openrouter.ai/api",
        capabilities: ["agent", "decision"],
        decision: ProviderDecisionPreset(
            url: "https://openrouter.ai/api/v1/systemone",
            keyRequired: true,
            modelsDevId: "openrouter",
            docsUrl: "https://openrouter.ai/docs/guides/community/jev",
            keyUrl: "https://openrouter.ai/keys",
            note: "One key for most hosted decision models.",
            models: [
                DecisionModelOption(id: "typesafe/jev-1.14", contextTokens: 32768, inputCostPerMillion: 0.25, source: "preset"),
                DecisionModelOption(id: "liquid/d1.1", contextTokens: 131_072, inputCostPerMillion: 0.05, source: "preset"),
                DecisionModelOption(id: "cloudflare/clef-flash", contextTokens: 8192, inputCostPerMillion: 0, source: "models.dev"),
            ]
        )
    )

    /// Another provider with both APIs, set up below for chat only.
    static let fireworks = ProviderPreset(
        id: "fireworks",
        name: "Fireworks AI",
        modelsDevId: "fireworks-ai",
        defaultUrl: "https://api.fireworks.ai/inference",
        capabilities: ["agent", "embed", "decision"],
        decision: ProviderDecisionPreset(
            url: "https://api.fireworks.ai/inference/v1/systemone",
            keyRequired: true,
            docsUrl: "https://docs.fireworks.ai/api-reference/post-systemone",
            keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
            models: [DecisionModelOption(id: "accounts/fireworks/models/rune", source: "preset")]
        )
    )

    static let cloudflare = ProviderPreset(
        id: "cloudflare",
        name: "Cloudflare Workers AI",
        capabilities: ["decision"],
        decision: ProviderDecisionPreset(
            url: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run",
            protocol: "workers-ai",
            keyRequired: true,
            modelsDevId: "cloudflare-workers-ai",
            docsUrl: "https://developers.cloudflare.com/workers-ai/models/clef/",
            keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
            note: "Workers AI shortens long text to fit Clef's context without saying so.",
            urlParams: [
                DecisionPresetURLParam(key: "account", label: "Account ID", placeholder: "0123456789abcdef0123456789abcdef"),
            ],
            models: ["@cf/cloudflare/clef-flash", "@cf/cloudflare/clef"].map { DecisionModelOption(id: $0, source: "preset") }
        )
    )

    /// A hosted provider that serves only decision models.
    static let fastino = ProviderPreset(
        id: "fastino",
        name: "Fastino",
        capabilities: ["decision"],
        decision: ProviderDecisionPreset(
            url: "https://api.fastino.ai/v1/systemone",
            auth: "x-api-key",
            scoreField: "expected_level",
            keyRequired: true,
            docsUrl: "https://docs.fastino.ai/inference/systemone",
            models: [DecisionModelOption(id: "fastino/GLiDE", source: "preset")]
        )
    )

    /// `presets` as the gateway sends it: providers with an OpenAI-compatible
    /// API, two of them with a decision API too.
    static var presets: [ProviderPreset] {
        BackendsPreviewData.presets() + [openRouter, fireworks]
    }

    /// `decisionProviders` as the gateway sends it: providers that serve only
    /// decision models, TypeSafe among them.
    static let decisionProviders = [ollaya, ollama, typesafe, cloudflare, fastino]

    /// The local Ollaya backend: decision models only, not yet calibrated.
    static let ollayaBackend = BackendStatus(
        type: "http",
        status: "ok",
        preset: "ollaya",
        decision: BackendDecisionStatus(url: "http://127.0.0.1:11435/v1/systemone", onHost: true)
    )

    /// A Fireworks AI backend set up for chat, whose decision API is not on yet.
    static let fireworksBackend = BackendStatus(
        type: "http",
        status: "ok",
        url: "https://api.fireworks.ai/inference",
        models: ["accounts/fireworks/models/example-chat"],
        modelRoles: ["accounts/fireworks/models/example-chat": ["agent"]],
        hasApiKey: true,
        preset: "fireworks"
    )

    /// An OpenRouter backend set up for its OpenAI-compatible models without
    /// a key: adding its decision models needs one.
    static let openRouterLabBackend = BackendStatus(
        type: "http",
        status: "ok",
        url: "https://openrouter.ai/api",
        models: [],
        hasApiKey: false,
        preset: "openrouter"
    )

    static let calibration = DecisionCalibration(
        reference: "jev-worth/email-worth-v1/jev-1.13.0",
        fittedAt: "2026-11-08T14:30:00Z",
        samples: 298,
        agreement: 0.92,
        agreementBefore: 0.71,
        keeps: 0.95,
        keepsBefore: 0.78,
        skips: 0.88,
        skipsBefore: 0.93
    )

    /// An OpenRouter backend serving chat and decision models with one key,
    /// and a calibration for one decision model.
    static let openRouterBackend = BackendStatus(
        type: "http",
        status: "ok",
        url: "https://openrouter.ai/api",
        models: ["example/chat-large"],
        modelRoles: ["example/chat-large": ["agent"]],
        hasApiKey: true,
        preset: "openrouter",
        decision: BackendDecisionStatus(
            url: "https://openrouter.ai/api/v1/systemone",
            hasApiKey: true,
            calibrations: ["liquid/d1.1": calibration]
        )
    )

    /// A Fastino backend: decision models only, hosted.
    static let fastinoBackend = BackendStatus(
        type: "http",
        status: "ok",
        hasApiKey: true,
        preset: "fastino",
        decision: BackendDecisionStatus(
            url: "https://api.fastino.ai/v1/systemone",
            auth: "x-api-key",
            hasApiKey: true
        )
    )

    /// TypeSafe assigned, a local Ollaya backend set up beside it, a Fireworks
    /// AI backend whose decision models can be turned on with its key, and a
    /// keyless OpenRouter backend whose decision models need one.
    static func typesafeOverview() -> ModelsOverview {
        overview(
            assignment: ResolvedAssignment(kind: "typesafe", available: true, model: "jev-1.14.0", hasApiKey: true),
            display: ModelDisplay(
                providerId: "typesafe", providerLabel: "TypeSafe", modelName: "jev-1.14.0", available: true, configured: true
            ),
            backends: ["ollaya": ollayaBackend, "fireworks": fireworksBackend, "openrouter-lab": openRouterLabBackend]
        )
    }

    /// The local Ollaya backend assigned and not calibrated.
    static func uncalibratedOverview() -> ModelsOverview {
        overview(
            assignment: ResolvedAssignment(
                kind: "decision",
                available: true,
                model: "kev",
                backendKey: "ollaya",
                preset: "ollaya",
                onHost: true,
                hasApiKey: false,
                calibrated: false
            ),
            display: ModelDisplay(providerId: "ollaya", providerLabel: "Ollaya", modelName: "kev", available: true, configured: true),
            backends: ["ollaya": ollayaBackend],
            allowRemoteInference: false
        )
    }

    /// OpenRouter assigned with a stored calibration.
    static func calibratedOverview() -> ModelsOverview {
        overview(
            assignment: ResolvedAssignment(
                kind: "decision",
                available: true,
                model: "liquid/d1.1",
                backendKey: "openrouter",
                preset: "openrouter",
                onHost: false,
                hasApiKey: true,
                calibrated: true
            ),
            display: ModelDisplay(
                providerId: "openrouter", providerLabel: "OpenRouter", modelName: "liquid/d1.1", available: true, configured: true
            ),
            backends: [
                "ollaya": ollayaBackend,
                "openrouter": openRouterBackend,
                "fireworks": fireworksBackend,
                "fastino": fastinoBackend,
            ]
        )
    }

    /// Nothing assigned and cloud inference off.
    static func unconfiguredOverview() -> ModelsOverview {
        overview(
            assignment: ResolvedAssignment(kind: "unresolved", reason: "No decision model is assigned."),
            display: ModelDisplay(providerId: "none", providerLabel: "", modelName: "", available: false, configured: false),
            backends: [:],
            allowRemoteInference: false
        )
    }

    /// The Models overview's own backends with `backends` added.
    static func overview(
        assignment: ResolvedAssignment,
        display: ModelDisplay,
        backends: [String: BackendStatus],
        allowRemoteInference: Bool = true
    )
        -> ModelsOverview {
        let base = ModelsPreviewData.overview()
        var assignments = base.inference.assignments
        assignments[DecisionModelSetup.role] = assignment
        var displays = base.assignmentDisplays
        displays[DecisionModelSetup.role] = display
        return ModelsOverview(
            assignmentDisplays: displays,
            capabilities: base.capabilities,
            inference: InferenceOverview(
                backends: base.inference.backends.merging(backends) { _, added in added },
                codex: base.inference.codex,
                assignments: assignments,
                health: base.inference.health,
                allowRemoteInference: allowRemoteInference,
                typesafe: TypeSafeEndpointStatus(url: typesafe.decision?.url, selfHosted: false, onHost: false)
            ),
            catalog: base.catalog,
            installed: base.installed,
            activeDownloads: base.activeDownloads,
            presets: base.presets,
            decisionProviders: base.decisionProviders,
            modelControls: base.modelControls,
            modelSettings: base.modelSettings
        )
    }

    /// The Backends list with backends serving OpenAI-compatible models, decision models,
    /// or both, and a decision-only backend whose key cannot be read.
    static func backendRows() -> [ModelManagement.BackendRow] {
        let unreadable = BackendStatus(
            type: "http",
            status: "unreachable",
            hasApiKey: true,
            decision: BackendDecisionStatus(
                url: "https://decide.example.com/v1/systemone",
                hasApiKey: true,
                apiKeySecretError: "Backend \"studio-decider\" API key secret is missing or unreadable"
            )
        )
        return (ModelManagement.httpBackends(calibratedOverview()) + [ModelManagement.BackendRow(
            key: "studio-decider",
            status: unreadable
        )])
        .sorted { $0.key < $1.key }
    }

    /// An OpenRouter backend whose stored key cannot be read.
    static var existingOpenRouterUnreadableKey: DecisionModelSetup.ExistingBackend {
        DecisionModelSetup.ExistingBackend(
            key: "openrouter",
            status: BackendStatus(
                type: "http",
                status: "ok",
                url: "https://openrouter.ai/api",
                hasApiKey: false,
                preset: "openrouter",
                decision: BackendDecisionStatus(
                    url: "https://openrouter.ai/api/v1/systemone",
                    apiKeySecretError: "Backend \"openrouter\" API key secret is missing or unreadable"
                )
            ),
            preset: openRouter
        )
    }

    /// The local Ollaya backend as the provider list offers it for reuse.
    static var existingOllaya: DecisionModelSetup.ExistingBackend {
        DecisionModelSetup.ExistingBackend(key: "ollaya", status: ollayaBackend, preset: ollaya)
    }

    /// The OpenRouter backend, serving chat and decision models.
    static var existingOpenRouter: DecisionModelSetup.ExistingBackend {
        DecisionModelSetup.ExistingBackend(key: "openrouter", status: openRouterBackend, preset: openRouter)
    }

    /// The Fireworks AI backend, offered to add decision models with its key.
    static var fireworksForDecisions: DecisionModelSetup.ExistingBackend {
        DecisionModelSetup.ExistingBackend(key: "fireworks", status: fireworksBackend, preset: fireworks)
    }

    /// The keyless OpenRouter backend, offered to add decision models once given a key.
    static var openRouterLabForDecisions: DecisionModelSetup.ExistingBackend {
        DecisionModelSetup.ExistingBackend(key: "openrouter-lab", status: openRouterLabBackend, preset: openRouter)
    }
}

// MARK: - Previews

@available(iOS 17.0, *)
#Preview("Decision — TypeSafe, verified") {
    DecisionModelSheet(
        overview: DecisionPreviewData.typesafeOverview(),
        previewVerify: DecisionVerifyResult(ok: true, answeredBy: "jev-1.14.0", latencyMs: 240)
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — local, uncalibrated, verify failed") {
    DecisionModelSheet(
        overview: DecisionPreviewData.uncalibratedOverview(),
        previewVerify: DecisionVerifyResult(
            ok: false,
            reason: "Nothing answered at http://127.0.0.1:11435/v1/systemone. Is the server running? (fetch failed)"
        )
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — calibrating") {
    DecisionModelSheet(
        overview: DecisionPreviewData.uncalibratedOverview(),
        previewCalibration: DecisionCalibrationStatus(state: "running", assignment: "ollaya/kev", done: 120, total: 300, failed: 2)
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — calibrated") {
    DecisionModelSheet(overview: DecisionPreviewData.calibratedOverview())
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — not set up") {
    DecisionModelSheet(overview: DecisionPreviewData.unconfiguredOverview())
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — providers") {
    NavigationStack {
        DecisionProviderList(overview: DecisionPreviewData.typesafeOverview())
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — local server form") {
    NavigationStack {
        DecisionBackendForm(choice: .preset(DecisionPreviewData.ollama), overview: DecisionPreviewData.typesafeOverview())
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — hosted form with account ID") {
    NavigationStack {
        DecisionBackendForm(
            choice: .preset(DecisionPreviewData.cloudflare),
            overview: DecisionPreviewData.uncalibratedOverview(),
            previewParams: ["account": "4f1c2a9e7b3d4c5e8a6f0b1c2d3e4f5a"],
            previewApiKey: "example-key"
        )
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — set-up local backend") {
    NavigationStack {
        DecisionBackendForm(
            choice: .existing(DecisionPreviewData.existingOllaya),
            overview: DecisionPreviewData.uncalibratedOverview(),
            previewProbed: ["kev", "winnow:e4b"]
        )
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — backend you have, existing key") {
    NavigationStack {
        DecisionBackendForm(choice: .enable(DecisionPreviewData.fireworksForDecisions), overview: DecisionPreviewData.typesafeOverview())
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — backend you have, needs a key") {
    NavigationStack {
        DecisionBackendForm(
            choice: .enable(DecisionPreviewData.openRouterLabForDecisions),
            overview: DecisionPreviewData.typesafeOverview()
        )
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — new provider with both APIs") {
    NavigationStack {
        DecisionBackendForm(
            choice: .preset(DecisionPreviewData.openRouter),
            overview: DecisionPreviewData.typesafeOverview(),
            previewApiKey: "example-key"
        )
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — new decision-only provider") {
    NavigationStack {
        DecisionBackendForm(choice: .preset(DecisionPreviewData.fastino), overview: DecisionPreviewData.typesafeOverview())
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — chat backend answering decisions") {
    NavigationStack {
        DecisionBackendForm(choice: .existing(DecisionPreviewData.existingOpenRouter), overview: DecisionPreviewData.calibratedOverview())
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — TypeSafe form") {
    NavigationStack {
        DecisionBackendForm(
            choice: .preset(DecisionPreviewData.typesafe),
            overview: DecisionPreviewData.typesafeOverview(),
            previewTypeSafeListed: true
        )
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Decision — other server") {
    NavigationStack {
        DecisionBackendForm(
            choice: .custom,
            overview: DecisionPreviewData.typesafeOverview(),
            previewURL: "http://127.0.0.1:8080/v1/systemone",
            previewModel: "",
            previewProbed: ["studio-decider-small", "studio-decider-large"]
        )
    }
    .environment(AppStore.preview())
}
#endif
