// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Decision model fixtures for previews and snapshots: a slice of the
/// gateway's provider presets (names and URLs as the gateway ships them, with
/// illustrative context sizes and prices) and the Models overview in each
/// state the Decision sheet renders.
@available(iOS 17.0, *)
enum DecisionPreviewData {
    static let ollaya = DecisionPresetView(
        id: "ollaya",
        name: "Ollaya",
        kind: "local",
        url: "http://127.0.0.1:11435/v1/systemone",
        docsUrl: "https://ollaya.dev/docs/api",
        note: "Runs open decision models on this machine. Pull a model with `ollaya pull <model>` first.",
        models: ["kev", "laya", "d1"].map { DecisionModelOption(id: $0, source: "preset") }
    )

    static let ollama = DecisionPresetView(
        id: "ollama",
        name: "Ollama",
        kind: "local",
        url: "http://127.0.0.1:11434/v1/systemone",
        docsUrl: "https://docs.ollama.com/api/systemone",
        note: "Ollama 0.40 or later serves decision models. Pull a model with `ollama pull <model>` first.",
        models: ["d3:4b", "kev:4b-q8_0"].map { DecisionModelOption(id: $0, source: "preset") }
    )

    static let typesafe = DecisionPresetView(
        id: "typesafe",
        name: "TypeSafe",
        kind: "cloud",
        url: "https://api.typesafe.ai/v1/systemone",
        keyRequired: true,
        builtIn: "typesafe",
        docsUrl: "https://docs.typesafe.ai/systemone",
        keyUrl: "https://console.typesafe.ai/keys",
        note: "Jev, the model every decision threshold was tuned on.",
        models: [
            DecisionModelOption(id: "jev-1.14.0", contextTokens: 32768, inputCostPerMillion: 0.2, source: "preset"),
            DecisionModelOption(id: "jev-1.13.0", source: "preset"),
        ]
    )

    static let openRouter = DecisionPresetView(
        id: "openrouter",
        name: "OpenRouter",
        kind: "cloud",
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

    static let cloudflare = DecisionPresetView(
        id: "cloudflare",
        name: "Cloudflare Workers AI",
        kind: "cloud",
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

    static let fastino = DecisionPresetView(
        id: "fastino",
        name: "Fastino",
        kind: "cloud",
        url: "https://api.fastino.ai/v1/systemone",
        auth: "x-api-key",
        scoreField: "expected_level",
        keyRequired: true,
        docsUrl: "https://docs.fastino.ai/glide",
        keyUrl: "https://app.fastino.ai/api-keys",
        models: [DecisionModelOption(id: "fastino/GLiDE", source: "preset")]
    )

    static let presets = [ollaya, ollama, openRouter, typesafe, cloudflare, fastino]

    /// The local Ollaya backend, set up and not yet calibrated.
    static let ollayaBackend = DecisionBackendStatus(
        preset: "ollaya",
        url: "http://127.0.0.1:11435/v1/systemone",
        onHost: true
    )

    static let calibration = DecisionCalibration(
        reference: "jev-worth/email-worth-v1/jev-1.13.0",
        fittedAt: "2026-11-08T14:30:00Z",
        samples: 298,
        agreement: 0.92,
        agreementBefore: 0.71
    )

    /// An OpenRouter backend with a key and a calibration for one model.
    static let openRouterBackend = DecisionBackendStatus(
        preset: "openrouter",
        url: "https://openrouter.ai/api/v1/systemone",
        hasApiKey: true,
        calibrations: ["liquid/d1.1": calibration]
    )

    /// TypeSafe assigned, an Ollaya backend set up beside it.
    static func typesafeOverview() -> ModelsOverview {
        overview(
            assignment: ResolvedAssignment(kind: "typesafe", available: true, model: "jev-1.14.0", hasApiKey: true),
            display: ModelDisplay(
                providerId: "typesafe", providerLabel: "TypeSafe", modelName: "jev-1.14.0", available: true, configured: true
            ),
            backends: ["ollaya": ollayaBackend]
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
            backends: ["ollaya": ollayaBackend, "openrouter": openRouterBackend]
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

    static func overview(
        assignment: ResolvedAssignment,
        display: ModelDisplay,
        backends: [String: DecisionBackendStatus],
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
                backends: base.inference.backends,
                codex: base.inference.codex,
                assignments: assignments,
                health: base.inference.health,
                allowRemoteInference: allowRemoteInference,
                typesafe: TypeSafeEndpointStatus(url: typesafe.url, selfHosted: false, onHost: false),
                decisionBackends: backends
            ),
            catalog: base.catalog,
            installed: base.installed,
            activeDownloads: base.activeDownloads,
            presets: base.presets,
            modelControls: base.modelControls,
            modelSettings: base.modelSettings,
            decisionPresets: presets
        )
    }

    /// An OpenRouter backend whose stored key cannot be read.
    static var existingOpenRouterUnreadableKey: DecisionModelSetup.ExistingBackend {
        DecisionModelSetup.ExistingBackend(
            key: "openrouter",
            status: DecisionBackendStatus(
                preset: "openrouter",
                url: "https://openrouter.ai/api/v1/systemone",
                hasApiKey: false,
                apiKeySecretError: "Decision backend \"openrouter\" API key secret is missing or unreadable"
            ),
            preset: openRouter
        )
    }

    /// The local Ollaya backend as the provider list offers it for reuse.
    static var existingOllaya: DecisionModelSetup.ExistingBackend {
        DecisionModelSetup.ExistingBackend(key: "ollaya", status: ollayaBackend, preset: ollaya)
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
