// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@available(iOS 17.0, *)
final class ModelBehaviorManagementTests: XCTestCase {
    func testSummaryUsesTheActiveHttpModelOnly() {
        let controls = metadata("openai", controls: [
            ModelControl(key: "reasoningEnabled", type: "boolean", label: "Reasoning"),
            ModelControl(key: "reasoningEffort", type: "enum", label: "Effort", values: ["low", "high"]),
        ])
        let inference = InferenceOverview(
            backends: sampleOverview().inference.backends,
            assignments: [
                "agent": ResolvedAssignment(kind: "http", available: true),
                "privacy-reviewer": ResolvedAssignment(kind: "http", available: true),
                "embedder": ResolvedAssignment(kind: "http", available: true),
                "transcriber": ResolvedAssignment(kind: "http", available: true),
                "ocr": ResolvedAssignment(kind: "http", available: true),
            ]
        )
        let settings = [
            "agent": ModelSettings(
                assignment: "openai/gpt-example",
                values: ModelBehaviorValues(reasoningEnabled: true, reasoningEffort: "high")
            ),
            "privacy-reviewer": ModelSettings(
                assignment: "openai/other",
                values: ModelBehaviorValues(reasoningEnabled: false, reasoningEffort: "low")
            ),
        ]
        let overview = makeOverview(
            inference: inference,
            controls: ["openai/gpt-example": controls, "openai/other": controls],
            settings: settings
        )
        XCTAssertEqual(ModelManagement.behaviorSummary(role: "agent", overview: overview), "Reasoning on · Effort: high")
        XCTAssertEqual(ModelManagement.behaviorSummary(role: "privacy-reviewer", overview: overview), "Reasoning off")
        for role in ["embedder", "transcriber", "ocr"] {
            XCTAssertNil(ModelManagement.activeControls(role: role, overview: overview))
            XCTAssertNil(ModelManagement.behaviorSummary(role: role, overview: overview))
        }
        let defaults = makeOverview(
            inference: inference,
            controls: ["openai/gpt-example": controls],
            settings: ["agent": ModelSettings(assignment: "openai/gpt-example", values: ModelBehaviorValues())]
        )
        XCTAssertEqual(ModelManagement.behaviorSummary(role: "agent", overview: defaults), "Provider defaults")
    }

    func testCodexSupportsBehaviorWhileOtherNonHttpAssignmentsHideIt() {
        let controls = metadata("openai", controls: [
            ModelControl(key: "reasoningEnabled", type: "boolean", label: "Reasoning"),
        ])
        let inference = InferenceOverview(
            backends: sampleOverview().inference.backends,
            assignments: [
                "agent": ResolvedAssignment(kind: "codex", available: true),
                "privacy-reviewer": ResolvedAssignment(kind: "anthropic", available: true),
            ]
        )
        let overview = makeOverview(
            inference: inference,
            controls: ["openai/gpt-example": controls],
            settings: [
                "agent": ModelSettings(
                    assignment: "openai/gpt-example",
                    values: ModelBehaviorValues(reasoningEnabled: true)
                ),
                "privacy-reviewer": ModelSettings(
                    assignment: "openai/gpt-example",
                    values: ModelBehaviorValues(reasoningEnabled: true)
                ),
            ]
        )
        XCTAssertNotNil(ModelManagement.activeControls(role: "agent", overview: overview))
        XCTAssertEqual(ModelManagement.behaviorSummary(role: "agent", overview: overview), "Reasoning on")
        XCTAssertNil(ModelManagement.behaviorSummary(role: "privacy-reviewer", overview: overview))
    }

    func testSavedOverridesRemainResettableWhenCatalogOptionsDisappear() {
        let inference = InferenceOverview(
            backends: sampleOverview().inference.backends,
            assignments: ["agent": ResolvedAssignment(kind: "http", available: true)]
        )
        let saved = ModelSettings(
            assignment: "openai/gpt-example",
            values: ModelBehaviorValues(reasoningEffort: "retired-option")
        )
        let missing = makeOverview(inference: inference, settings: ["agent": saved])
        guard let behavior = ModelManagement.activeBehavior(role: "agent", overview: missing) else {
            XCTFail("Saved overrides must remain resettable")
            return
        }
        XCTAssertEqual(behavior.assignment, "openai/gpt-example")
        XCTAssertTrue(behavior.metadata.controls.isEmpty)
        XCTAssertNotNil(ModelManagement.staleBehaviorMessage(metadata: behavior.metadata, values: saved.values))
        XCTAssertTrue(ModelManagement.requiresExplicitReset(metadata: behavior.metadata, values: saved.values))
        XCTAssertEqual(ModelManagement.behaviorSummary(role: "agent", overview: missing), "Saved inference settings need reset")

        let defaults = makeOverview(
            inference: inference,
            settings: ["agent": ModelSettings(assignment: "openai/gpt-example", values: ModelBehaviorValues())]
        )
        XCTAssertNil(ModelManagement.activeBehavior(role: "agent", overview: defaults))
        XCTAssertEqual(
            ModelManagement.assignedBehavior(role: "agent", overview: defaults)?.assignment,
            "openai/gpt-example"
        )

        let offered = metadata("openai", controls: [
            ModelControl(key: "reasoningEffort", type: "enum", label: "Effort", values: ["low", "high"]),
        ])
        XCTAssertNotNil(ModelManagement.staleBehaviorMessage(metadata: offered, values: saved.values))
        XCTAssertFalse(ModelManagement.requiresExplicitReset(metadata: offered, values: saved.values))
        let retiredButOffered = makeOverview(
            inference: inference,
            controls: ["openai/gpt-example": offered],
            settings: ["agent": saved]
        )
        XCTAssertEqual(
            ModelManagement.behaviorSummary(role: "agent", overview: retiredButOffered),
            "Saved inference setting needs an offered value"
        )
        XCTAssertTrue(
            ModelManagement.requiresExplicitReset(
                metadata: offered,
                values: ModelBehaviorValues(reasoningBudgetTokens: 2048)
            )
        )
        XCTAssertNil(
            ModelManagement.staleBehaviorMessage(
                metadata: offered,
                values: ModelBehaviorValues(reasoningEffort: "high")
            )
        )
    }

    func testRetiredEffortBlocksSavingUnrelatedChangesUntilReplaced() throws {
        let retired = ModelBehaviorValues(reasoningEffort: "retired-option")
        let controls = metadata("openai", controls: [
            ModelControl(key: "reasoningEnabled", type: "boolean", label: "Reasoning"),
            ModelControl(key: "reasoningEffort", type: "enum", label: "Effort", values: ["low", "high"]),
        ])
        XCTAssertThrowsError(try ModelManagement.validatedBehaviorValues(
            metadata: controls,
            initial: retired,
            reasoningChoice: "on",
            effortChoice: "retired-option",
            budgetText: ""
        )) { XCTAssertEqual($0 as? ModelManagement.BehaviorInputError, .effort) }
        XCTAssertEqual(
            try ModelManagement.validatedBehaviorValues(
                metadata: controls,
                initial: retired,
                reasoningChoice: "on",
                effortChoice: "high",
                budgetText: ""
            ),
            ModelBehaviorValues(reasoningEnabled: true, reasoningEffort: "high")
        )

        let removed = metadata("openai", controls: [
            ModelControl(key: "reasoningEnabled", type: "boolean", label: "Reasoning"),
        ])
        XCTAssertThrowsError(try ModelManagement.validatedBehaviorValues(
            metadata: removed,
            initial: retired,
            reasoningChoice: "on",
            effortChoice: "retired-option",
            budgetText: ""
        )) { XCTAssertEqual($0 as? ModelManagement.BehaviorInputError, .stale) }
    }

    func testCustomBackendKeepsSelectionKeyButUsesMatchedProviderLogo() {
        let overview = makeOverview(controls: [
            "northstar/llama-vision-8b": metadata("openai", controls: []),
        ])
        XCTAssertEqual(ModelManagement.logoProviderId(for: "northstar", overview: overview), "openai")
        XCTAssertEqual(ModelManagement.logoProviderId(for: "unmatched", overview: overview), "unmatched")
        let option = ModelManagement.pickerOptions(capabilityRole: "agent", overview: overview)
            .first { $0.id == "northstar/llama-vision-8b" }
        XCTAssertEqual(option?.providerId, "northstar", "brand identity must not change the selection key")
    }

    func testExactEffortBudgetDefaultsAndReasoningOff() throws {
        let controls = metadata("openai", controls: [
            ModelControl(key: "reasoningEnabled", type: "boolean", label: "Reasoning"),
            ModelControl(key: "reasoningEffort", type: "enum", label: "Effort", values: ["low", "xhigh"]),
            ModelControl(key: "reasoningBudgetTokens", type: "integer", label: "Budget", min: 128, max: 4096),
        ])
        let previous = ModelBehaviorValues(reasoningEnabled: true, reasoningEffort: "xhigh", reasoningBudgetTokens: 2048)
        let defaults = try values(controls, from: previous)
        XCTAssertEqual(defaults, ModelBehaviorValues(), "provider defaults clear all previous overrides")
        let chosen = try values(controls, from: defaults, reasoning: "on", effort: "low", budget: "128")
        XCTAssertEqual(chosen, ModelBehaviorValues(reasoningEnabled: true, reasoningEffort: "low", reasoningBudgetTokens: 128))
        let off = try values(controls, from: chosen, reasoning: "off", effort: "low", budget: "128")
        XCTAssertEqual(off, ModelBehaviorValues(reasoningEnabled: false), "Off clears effort and budget")
        XCTAssertThrowsError(try values(controls, reasoning: "on", effort: "medium", budget: "128")) {
            XCTAssertEqual($0 as? ModelManagement.BehaviorInputError, .effort)
        }
        XCTAssertThrowsError(try values(controls, reasoning: "on", effort: "xhigh", budget: "127")) {
            XCTAssertEqual($0 as? ModelManagement.BehaviorInputError, .budget)
        }
    }

    func testDescriptorExclusivityRejectsConflictingOverrides() {
        let openRouter = metadata("openrouter", controls: [
            ModelControl(
                key: "reasoningEffort",
                type: "enum",
                label: "Effort",
                values: ["low"],
                exclusiveWith: ["reasoningBudgetTokens"]
            ),
            ModelControl(
                key: "reasoningBudgetTokens",
                type: "integer",
                label: "Budget",
                min: 1,
                max: 4096,
                exclusiveWith: ["reasoningEffort"]
            ),
        ])
        XCTAssertThrowsError(try values(openRouter, effort: "low", budget: "512")) {
            XCTAssertEqual($0 as? ModelManagement.BehaviorInputError, .conflict)
        }

        let google = metadata("google", controls: [
            ModelControl(
                key: "reasoningEnabled",
                type: "boolean",
                label: "Thinking",
                exclusiveWith: ["reasoningEffort", "reasoningBudgetTokens"]
            ),
            ModelControl(
                key: "reasoningEffort",
                type: "enum",
                label: "Effort",
                values: ["low"],
                exclusiveWith: ["reasoningEnabled"]
            ),
            ModelControl(
                key: "reasoningBudgetTokens",
                type: "integer",
                label: "Budget",
                min: 1,
                max: 4096,
                exclusiveWith: ["reasoningEnabled"]
            ),
        ])
        XCTAssertEqual(
            ModelManagement.exclusiveKeys(for: "reasoningEnabled", metadata: google),
            Set(["reasoningEffort", "reasoningBudgetTokens"])
        )
        XCTAssertThrowsError(try values(google, reasoning: "on", effort: "low")) {
            XCTAssertEqual($0 as? ModelManagement.BehaviorInputError, .conflict)
        }
        XCTAssertThrowsError(try values(google, reasoning: "on", budget: "512")) {
            XCTAssertEqual($0 as? ModelManagement.BehaviorInputError, .conflict)
        }
    }

    func testNvidiaMinusOneIsNoBudgetEnforcement() throws {
        let controls = metadata("nvidia", controls: [
            ModelControl(key: "reasoningBudgetTokens", type: "integer", label: "Budget", min: -1, max: 32768),
        ])
        XCTAssertEqual(
            try values(controls, budget: "-1"),
            ModelBehaviorValues(reasoningBudgetTokens: -1)
        )
        XCTAssertThrowsError(try values(controls, budget: "-2")) {
            XCTAssertEqual($0 as? ModelManagement.BehaviorInputError, .budget)
        }
        let inference = InferenceOverview(
            backends: sampleOverview().inference.backends,
            assignments: ["agent": ResolvedAssignment(kind: "http", available: true)]
        )
        let overview = makeOverview(
            inference: inference,
            controls: ["nvidia/nemotron-example": controls],
            settings: [
                "agent": ModelSettings(
                    assignment: "nvidia/nemotron-example",
                    values: ModelBehaviorValues(reasoningBudgetTokens: -1)
                ),
            ]
        )
        XCTAssertEqual(ModelManagement.behaviorSummary(role: "agent", overview: overview), "No reasoning budget enforcement")
    }

    private func metadata(_ providerId: String, controls: [ModelControl]) -> ModelControls {
        ModelControls(providerId: providerId, source: "models.dev", reasoning: true, controls: controls)
    }

    private func values(
        _ metadata: ModelControls,
        from initial: ModelBehaviorValues = ModelBehaviorValues(),
        reasoning: String = "default",
        effort: String? = nil,
        budget: String = ""
    ) throws
        -> ModelBehaviorValues {
        try ModelManagement.behaviorValues(
            metadata: metadata,
            initial: initial,
            reasoningChoice: reasoning,
            effortChoice: effort,
            budgetText: budget
        )
    }

    private func makeOverview(
        inference: InferenceOverview? = nil,
        controls: [String: ModelControls] = [:],
        settings: [String: ModelSettings] = [:]
    )
        -> ModelsOverview {
        let base = sampleOverview()
        return ModelsOverview(
            assignmentDisplays: base.assignmentDisplays,
            capabilities: base.capabilities,
            inference: inference ?? base.inference,
            catalog: base.catalog,
            installed: base.installed,
            modelControls: controls,
            modelSettings: settings
        )
    }

    private func sampleOverview() -> ModelsOverview {
        ModelsOverview(
            assignmentDisplays: [:],
            capabilities: [],
            inference: InferenceOverview(
                backends: [
                    "northstar": BackendStatus(
                        type: "http",
                        status: "ok",
                        url: "https://example.com/v1",
                        models: ["llama-vision-8b"],
                        modelRoles: ["llama-vision-8b": ["agent"]]
                    ),
                ],
                assignments: [:]
            ),
            catalog: [],
            installed: []
        )
    }
}
