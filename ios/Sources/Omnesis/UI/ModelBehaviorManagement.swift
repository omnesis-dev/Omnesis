// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Provider-specific HTTP chat controls shared by the mobile Models screen.
extension ModelManagement {
    /// These capabilities issue chat-model requests. Embeddings, speech and
    /// OCR use distinct inference paths that do not carry reasoning settings.
    static let behaviorRoles: Set<String> = [
        "agent", "privacy-reviewer", "background-agent", "watch-judge",
        "entailment-verifier", "brief-judge",
    ]

    /// Preserve the configured backend key for selection while showing the
    /// serving provider's logo when at least one listed model matches the
    /// catalog. Custom backend names can still resolve to a known provider.
    static func logoProviderId(for backendKey: String, overview: ModelsOverview) -> String {
        let prefix = "\(backendKey)/"
        let matched = overview.modelControls.first { $0.key.hasPrefix(prefix) && $0.value.source == "models.dev" }
        return matched?.value.providerId ?? backendKey
    }

    /// Only the active assignment's controls are editable. A stale or unknown
    /// assignment must not show controls for a different model.
    static func activeControls(role: String, overview: ModelsOverview) -> ModelControls? {
        guard behaviorRoles.contains(role) else { return nil }
        guard let kind = overview.inference.assignments[role]?.kind,
              ["http", "codex"].contains(kind) else { return nil }
        guard let assignment = overview.modelSettings[role]?.assignment else { return nil }
        return overview.modelControls[assignment]
    }

    struct ActiveBehavior {
        let assignment: String
        let metadata: ModelControls
        let values: ModelBehaviorValues
    }

    /// The picker always confirms an assigned chat model, even when that
    /// model has no configurable inference controls.
    static func assignedBehavior(
        role: String,
        overview: ModelsOverview
    )
        -> ActiveBehavior? {
        guard behaviorRoles.contains(role),
              let kind = overview.inference.assignments[role]?.kind,
              ["http", "codex"].contains(kind),
              let settings = overview.modelSettings[role],
              let assignment = settings.assignment else { return nil }
        let metadata = overview.modelControls[assignment] ?? ModelControls(
            providerId: "unknown",
            source: "unknown",
            reasoning: nil,
            controls: []
        )
        return ActiveBehavior(assignment: assignment, metadata: metadata, values: settings.values)
    }

    /// A saved override must remain recoverable after a catalog refresh even
    /// when the model no longer advertises any controls.
    static func activeBehavior(
        role: String,
        overview: ModelsOverview
    )
        -> ActiveBehavior? {
        guard let behavior = assignedBehavior(role: role, overview: overview),
              !behavior.metadata.controls.isEmpty || behavior.values != ModelBehaviorValues()
        else { return nil }
        return behavior
    }

    static func staleBehaviorMessage(metadata: ModelControls, values: ModelBehaviorValues) -> String? {
        guard values != ModelBehaviorValues() else { return nil }
        let enabled = metadata.controls.first { $0.key == "reasoningEnabled" && $0.type == "boolean" }
        let effort = metadata.controls.first { $0.key == "reasoningEffort" && $0.type == "enum" }
        let budget = metadata.controls.first { $0.key == "reasoningBudgetTokens" && $0.type == "integer" }
        let budgetOutOfRange = values.reasoningBudgetTokens.map {
            $0 < (budget?.min ?? 0) || $0 > (budget?.max ?? Int.max)
        } ?? false
        let effortUnknown = values.reasoningEffort.map {
            !(effort?.values ?? []).contains($0)
        } ?? false
        guard (values.reasoningEnabled != nil && enabled == nil) ||
            effortUnknown ||
            (values.reasoningBudgetTokens != nil && (budget == nil || budgetOutOfRange))
        else { return nil }
        return metadata.controls.isEmpty
            ? "This model no longer advertises inference settings. Reset to use its model default."
            : requiresExplicitReset(metadata: metadata, values: values)
            ? "A saved setting is no longer offered for this model. Reset to model default."
            : "A saved value is no longer offered for this model. Choose an offered value or Default."
    }

    /// Offered controls can clear themselves with Default (or a blank budget).
    /// Only overrides whose controls disappeared need a separate reset action.
    static func requiresExplicitReset(metadata: ModelControls, values: ModelBehaviorValues) -> Bool {
        let keys = Set(metadata.controls.map(\.key))
        return (values.reasoningEnabled != nil && !keys.contains("reasoningEnabled")) ||
            (values.reasoningEffort != nil && !keys.contains("reasoningEffort")) ||
            (values.reasoningBudgetTokens != nil && !keys.contains("reasoningBudgetTokens"))
    }

    static func behaviorSummary(role: String, overview: ModelsOverview) -> String? {
        guard let behavior = activeBehavior(role: role, overview: overview) else { return nil }
        let controls = behavior.metadata
        let values = behavior.values
        if staleBehaviorMessage(metadata: controls, values: values) != nil {
            return requiresExplicitReset(metadata: controls, values: values)
                ? "Saved inference settings need reset"
                : "Saved inference setting needs an offered value"
        }
        if values.reasoningEnabled == false { return "Reasoning off" }
        var parts: [String] = []
        if values.reasoningEnabled == true { parts.append("Reasoning on") }
        if let effort = values.reasoningEffort { parts.append("Effort: \(effort)") }
        if let budget = values.reasoningBudgetTokens {
            parts.append(budget == -1 ? "No reasoning budget enforcement" : "Budget: \(budget) tokens")
        }
        return parts.isEmpty ? "Provider defaults" : parts.joined(separator: " · ")
    }

    enum BehaviorInputError: LocalizedError, Equatable {
        case effort
        case budget
        case conflict
        case stale

        var errorDescription: String? {
            switch self {
            case .effort: "Choose an effort offered for this model."
            case .budget: "Enter a token budget within this model's allowed range."
            case .conflict: "Choose one of this model's alternative reasoning settings."
            case .stale: "Reset a saved inference setting that is no longer offered for this model."
            }
        }
    }

    /// Convert the provider-specific editor's choices to a full replacement
    /// override map. Blank/default controls stay nil and leave model defaults
    /// in charge. Unknown controls are preserved from the current values.
    static func behaviorValues(
        metadata: ModelControls,
        initial: ModelBehaviorValues,
        reasoningChoice: String,
        effortChoice: String?,
        budgetText: String
    ) throws
        -> ModelBehaviorValues {
        var values = initial
        if metadata.controls.contains(where: { $0.key == "reasoningEnabled" && $0.type == "boolean" }) {
            values.reasoningEnabled = reasoningChoice == "default" ? nil : reasoningChoice == "on"
        }
        if let control = metadata.controls.first(where: { $0.key == "reasoningEffort" && $0.type == "enum" }) {
            guard effortChoice.map({ (control.values ?? []).contains($0) }) ?? true else {
                throw BehaviorInputError.effort
            }
            values.reasoningEffort = effortChoice
        }
        if let control = metadata.controls.first(where: { $0.key == "reasoningBudgetTokens" && $0.type == "integer" }) {
            let text = budgetText.trimmingCharacters(in: .whitespaces)
            if text.isEmpty {
                values.reasoningBudgetTokens = nil
            } else if let amount = Int(text),
                      amount >= (control.min ?? 0), amount <= (control.max ?? Int.max) {
                values.reasoningBudgetTokens = amount
            } else {
                throw BehaviorInputError.budget
            }
        }
        if values.reasoningEnabled == false {
            values.reasoningEffort = nil
            values.reasoningBudgetTokens = nil
        }
        let selected: Set<String> = Set([
            values.reasoningEnabled == true ? "reasoningEnabled" : nil,
            values.reasoningEffort == nil ? nil : "reasoningEffort",
            values.reasoningBudgetTokens == nil ? nil : "reasoningBudgetTokens",
        ].compactMap { $0 })
        for key in selected where !exclusiveKeys(for: key, metadata: metadata).isDisjoint(with: selected) {
            throw BehaviorInputError.conflict
        }
        return values
    }

    static func validatedBehaviorValues(
        metadata: ModelControls,
        initial: ModelBehaviorValues,
        reasoningChoice: String,
        effortChoice: String?,
        budgetText: String
    ) throws
        -> ModelBehaviorValues {
        let values = try behaviorValues(
            metadata: metadata,
            initial: initial,
            reasoningChoice: reasoningChoice,
            effortChoice: effortChoice,
            budgetText: budgetText
        )
        guard staleBehaviorMessage(metadata: metadata, values: values) == nil else {
            throw BehaviorInputError.stale
        }
        return values
    }

    static func exclusiveKeys(for key: String, metadata: ModelControls) -> Set<String> {
        let forward = metadata.controls.first { $0.key == key }?.exclusiveWith ?? []
        let reverse = metadata.controls.filter { ($0.exclusiveWith ?? []).contains(key) }.map(\.key)
        return Set(forward + reverse)
    }
}
