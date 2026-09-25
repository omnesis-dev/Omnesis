// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
enum ModelsPreviewData {
    static let capabilities: [CapabilityMeta] = [
        CapabilityMeta(
            role: "embedder",
            title: "Embedder",
            description: "Turns your documents into vectors so search can find things by meaning.",
            icon: "binary",
            section: "core"
        ),
        CapabilityMeta(
            role: "agent",
            title: "Agent",
            description: "The conversational model that answers questions over your corpus.",
            icon: "bot",
            section: "cognition"
        ),
        CapabilityMeta(
            role: "privacy-reviewer",
            title: "Privacy reviewer",
            description: "Reviews answers before they leave the Omnesis sandbox.",
            icon: "shield-check"
        ),
        CapabilityMeta(
            role: "transcriber",
            title: "Transcriber",
            description: "Converts voice notes and audio into searchable text.",
            icon: "mic",
            section: "core"
        ),
        CapabilityMeta(
            role: "ocr",
            title: "OCR",
            description: "Reads text out of images and scanned PDFs.",
            icon: "scan-text",
            section: "core"
        ),
        CapabilityMeta(
            role: "background-agent",
            title: "Background agent",
            description: "The model behind Omnesis Briefs: it runs headlessly to maintain open loops and surface briefs.",
            icon: "bot",
            experimental: true,
            section: "cognition"
        ),
        CapabilityMeta(
            role: "entailment-verifier",
            title: "Entailment verifier",
            description: "Checks that a memory claim is supported by its quoted evidence before it persists.",
            icon: "shield-check",
            experimental: true,
            section: "cognition"
        ),
        CapabilityMeta(
            role: "brief-judge",
            title: "Brief judge",
            description: "Decides whether a candidate brief is worth interrupting you for.",
            icon: "shield-check",
            experimental: true,
            section: "cognition"
        ),
    ]

    static func overview() -> ModelsOverview {
        ModelsOverview(
            assignmentDisplays: assignmentDisplays(),
            capabilities: capabilities,
            inference: inference(),
            catalog: catalog(),
            installed: [ManifestEntry(id: "nomic-embed-text-v1.5.Q8_0")],
            activeDownloads: activeDownloads(),
            presets: BackendsPreviewData.presets(),
            modelControls: ["openai/gpt-example-frontier": PreviewMocks.modelReasoningControls],
            modelSettings: [
                "agent": ModelSettings(
                    assignment: "openai/gpt-example-frontier",
                    values: PreviewMocks.modelReasoningValues
                ),
            ]
        )
    }

    static func overviewWithoutControls() -> ModelsOverview {
        let base = overview()
        return ModelsOverview(
            assignmentDisplays: base.assignmentDisplays,
            capabilities: base.capabilities,
            inference: base.inference,
            catalog: base.catalog,
            installed: base.installed,
            activeDownloads: base.activeDownloads,
            presets: base.presets,
            modelControls: [:],
            modelSettings: [
                "agent": ModelSettings(
                    assignment: "openai/gpt-example-frontier",
                    values: ModelBehaviorValues()
                ),
            ]
        )
    }

    private static func assignmentDisplays() -> [String: ModelDisplay] {
        [
            "embedder": ModelDisplay(
                providerId: "local",
                providerLabel: "Local",
                modelName: "nomic-embed-text-v1.5",
                available: true,
                configured: true
            ),
            "agent": ModelDisplay(
                providerId: "openai",
                providerLabel: "OpenAI",
                modelName: "GPT Example Frontier",
                available: true,
                configured: true
            ),
            "privacy-reviewer": ModelDisplay(
                providerId: "codex",
                providerLabel: "Codex",
                modelName: "GPT Example Frontier",
                available: true,
                configured: true
            ),
            "ocr": ModelDisplay(
                providerId: "http",
                providerLabel: "Studio Northstar",
                modelName: "dots-ocr",
                available: false,
                configured: true
            ),
            "background-agent": ModelDisplay(
                providerId: "codex",
                providerLabel: "Codex",
                modelName: "GPT Example Frontier",
                available: true,
                configured: true
            ),
        ]
    }

    private static func inference() -> InferenceOverview {
        InferenceOverview(
            backends: [
                "openai": BackendStatus(
                    type: "http",
                    status: "ok",
                    url: "https://api.example.com/v1",
                    models: ["gpt-example-frontier"],
                    modelRoles: ["gpt-example-frontier": ["agent", "privacy-reviewer"]],
                    hasApiKey: true
                ),
                "northstar": BackendStatus(
                    type: "http",
                    status: "ok",
                    url: "http://example.local:9000/v1",
                    models: ["dots-ocr", "llama-vision-8b"],
                    modelRoles: [
                        "dots-ocr": ["ocr"],
                        "llama-vision-8b": ["ocr", "agent", "privacy-reviewer"],
                    ],
                    hasApiKey: false
                ),
                "vllm": BackendStatus(
                    type: "http",
                    status: "ok",
                    url: "http://example.local:8000/v1",
                    models: ["llama-3.3-70b", "qwen-embed-0.6b"],
                    modelRoles: [
                        "llama-3.3-70b": ["agent", "privacy-reviewer"],
                        "qwen-embed-0.6b": ["embedder"],
                    ],
                    hasApiKey: false
                ),
            ],
            codex: CodexBackendStatus(
                configured: true,
                status: "ok",
                loggedIn: true,
                models: ["gpt-example-frontier", "gpt-example-mini"],
                modelDetails: [
                    CodexModelStatus(
                        id: "gpt-example-frontier",
                        name: "GPT Example Frontier",
                        description: "Example Codex model.",
                        recommended: true
                    ),
                    CodexModelStatus(id: "gpt-example-mini", name: "GPT Example Mini"),
                ],
                modelRoles: [
                    "gpt-example-frontier": ["agent", "privacy-reviewer", "background-agent"],
                    "gpt-example-mini": ["agent", "privacy-reviewer", "background-agent"],
                ],
                refreshedAt: "2026-07-03T12:00:00Z"
            ),
            assignments: [
                "embedder": ResolvedAssignment(kind: "local", available: true),
                "agent": ResolvedAssignment(kind: "http", available: true),
                "privacy-reviewer": ResolvedAssignment(kind: "codex", available: true),
                "transcriber": ResolvedAssignment(kind: "unresolved"),
                "ocr": ResolvedAssignment(kind: "http", available: false, reason: "Backend unreachable"),
                "background-agent": ResolvedAssignment(kind: "codex", available: true),
                "entailment-verifier": ResolvedAssignment(kind: "unresolved"),
            ]
        )
    }

    private static func catalog() -> [CatalogEntry] {
        [
            CatalogEntry(
                kind: "gguf",
                id: "nomic-embed-text-v1.5.Q8_0",
                name: "nomic-embed-text-v1.5",
                roles: ["embed"],
                sizeBytes: 274_000_000,
                minRamGb: 2,
                recommendedRamGb: 4,
                quant: "Q8_0",
                params: "137M",
                recommended: true
            ),
            CatalogEntry(
                kind: "gguf",
                id: "example-embed-v1.Q4_K_M",
                name: "example-embed-v1",
                roles: ["embed"],
                sizeBytes: 512_000_000,
                minRamGb: 8,
                recommendedRamGb: 12,
                quant: "Q4_K_M",
                params: "560M"
            ),
            CatalogEntry(
                kind: "gguf",
                id: "example-embed-large.Q8_0",
                name: "example-embed-large",
                roles: ["embed"],
                sizeBytes: 1_200_000_000,
                minRamGb: 4,
                quant: "Q8_0",
                params: "1.2B"
            ),
            CatalogEntry(
                kind: "anthropic-api",
                id: "anthropic/claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                roles: ["agent"]
            ),
        ]
    }

    private static func activeDownloads() -> [ActiveDownload] {
        [
            ActiveDownload(
                downloadId: "dl-1",
                modelId: "example-embed-v1.Q4_K_M",
                filename: "example-embed-v1.Q4_K_M.gguf",
                progress: DownloadProgress(
                    downloadedBytes: 215_000_000,
                    totalBytes: 512_000_000,
                    speedBytesPerSec: 8_400_000,
                    etaMs: 35000
                ),
                startedAt: "2026-01-01T00:00:00Z"
            ),
        ]
    }

    static func systemInfo() -> SystemInfo {
        SystemInfo(totalRamGb: 16, freeRamGb: 6, modelsDirFreeGb: 40)
    }

    /// Invented "Recently used" entries for the picker preview/snapshot: an
    /// assign-type Codex model, an activate-type local model, and an
    /// incomplete entry (exercising the skip path — it renders nothing).
    static func recentEntries() -> [RecentModelEntry] {
        [
            RecentModelEntry(
                assignment: "codex/gpt-example-frontier",
                providerId: "codex",
                providerLabel: "Codex",
                modelName: "GPT Example Frontier",
                apply: RecentModelApply(type: "assign", value: "codex/gpt-example-frontier")
            ),
            RecentModelEntry(
                assignment: "local/northstar-chat-1b",
                providerId: "local",
                providerLabel: "Local",
                modelName: "Northstar Chat",
                apply: RecentModelApply(
                    type: "activate",
                    catalogId: "northstar-chat-1b",
                    catalogRole: "agent"
                )
            ),
            RecentModelEntry(
                assignment: "northstar/llama-vision-8b",
                providerId: "northstar",
                providerLabel: "Studio Northstar",
                modelName: "llama-vision-8b",
                apply: RecentModelApply(type: "assign", value: "northstar/llama-vision-8b")
            ),
            RecentModelEntry(
                assignment: "local/incomplete",
                providerId: "local",
                providerLabel: "Local",
                modelName: "",
                apply: RecentModelApply(type: "activate")
            ),
        ]
    }
}

#endif
