// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// MARK: - Provider-specific inference controls

/// Edits exactly the options advertised for the currently assigned model.
/// Unset values keep the provider default rather than guessing a universal
/// low/medium/high mapping.
@available(iOS 17.0, *)
struct ModelBehaviorEditor: View {
    let assignment: String
    let metadata: ModelControls
    let initialValues: ModelBehaviorValues

    @State private var reasoningChoice: String
    @State private var effortChoice: String?
    @State private var budgetText: String
    @State private var autosave: ModelBehaviorAutosaveController
    @State private var previewError: String?
    @FocusState private var budgetFocused: Bool

    init(
        assignment: String,
        metadata: ModelControls,
        initialValues: ModelBehaviorValues,
        onSave: @escaping (String, ModelBehaviorValues, ModelBehaviorValues) async throws -> String = { _, _, _ in "" }
    ) {
        self.assignment = assignment
        self.metadata = metadata
        self.initialValues = initialValues
        _reasoningChoice = State(initialValue: initialValues.reasoningEnabled.map { $0 ? "on" : "off" } ?? "default")
        _effortChoice = State(initialValue: initialValues.reasoningEffort)
        _budgetText = State(initialValue: initialValues.reasoningBudgetTokens.map(String.init) ?? "")
        _previewError = State(initialValue: nil)
        _autosave = State(initialValue: ModelBehaviorAutosaveController(
            initialValues: initialValues,
            messageForError: deviceGatewayMessage,
            save: { values, expectedValues in try await onSave(assignment, values, expectedValues) }
        ))
    }

    #if DEBUG
    init(
        assignment: String,
        metadata: ModelControls,
        initialValues: ModelBehaviorValues,
        previewError: String
    ) {
        self.init(assignment: assignment, metadata: metadata, initialValues: initialValues)
        _previewError = State(initialValue: previewError)
    }

    init(
        assignment: String,
        metadata: ModelControls,
        initialValues: ModelBehaviorValues,
        previewReasoningChoice: String
    ) {
        self.init(assignment: assignment, metadata: metadata, initialValues: initialValues)
        _reasoningChoice = State(initialValue: previewReasoningChoice)
    }

    init(
        assignment: String,
        metadata: ModelControls,
        initialValues: ModelBehaviorValues,
        previewConflict: Bool,
        previewEffortChoice: String
    ) {
        self.init(assignment: assignment, metadata: metadata, initialValues: initialValues)
        let controller = ModelBehaviorAutosaveController(initialValues: initialValues) { _, _ in "" }
        controller.hasConflict = previewConflict
        controller.error = previewConflict ? ModelBehaviorAutosaveController.conflictMessage : nil
        _autosave = State(initialValue: controller)
        _effortChoice = State(initialValue: previewEffortChoice)
    }
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if !metadata.controls.isEmpty,
               let staleMessage = ModelManagement.staleBehaviorMessage(metadata: metadata, values: autosave.acknowledgedValues) {
                Text(staleMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ForEach(metadata.controls) { control in
                controlField(control)
                    .disabled(autosave.hasConflict || ModelManagement.requiresExplicitReset(
                        metadata: metadata,
                        values: autosave.acknowledgedValues
                    ))
            }

            if metadata.controls.contains(where: { !($0.exclusiveWith ?? []).isEmpty }) {
                Text("Some settings are alternatives for this model. Choosing one clears the other.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }

            if let error = previewError ?? autosave.error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                if !autosave.hasConflict, !metadata.controls.isEmpty,
                   !ModelManagement.requiresExplicitReset(metadata: metadata, values: autosave.acknowledgedValues) {
                    Button("Retry") { autosave.submit(candidate()) }
                        .font(.system(size: 11))
                }
            } else if autosave.isSaving {
                HStack(spacing: 6) {
                    ProgressView()
                    Text("Saving…")
                }
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
            } else if let notice = autosave.notice {
                Text(notice)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.success)
            }

            if ModelManagement.requiresExplicitReset(metadata: metadata, values: autosave.acknowledgedValues) {
                Button("Reset to model default") {
                    reset()
                }
                .buttonStyle(.bordered)
                .disabled(autosave.hasConflict)
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") {
                    budgetFocused = false
                    autosave.submit(candidate())
                }
            }
        }
        .onChange(of: autosave.resetGeneration) { _, _ in
            reasoningChoice = "default"
            effortChoice = nil
            budgetText = ""
        }
        .onChange(of: initialValues) { _, fresh in
            adoptExternalIfIdle(fresh)
        }
        .onChange(of: autosave.isSaving) { _, busy in
            if !busy,
               autosave.retryDeferredExternal(initialValues, hasLocalDraft: hasLocalDraft) {
                syncChoices(initialValues)
            }
        }
    }

    private func adoptExternalIfIdle(_ fresh: ModelBehaviorValues) {
        guard fresh != autosave.acknowledgedValues,
              autosave.reconcileExternal(fresh, hasLocalDraft: hasLocalDraft) else { return }
        syncChoices(fresh)
    }

    private func syncChoices(_ fresh: ModelBehaviorValues) {
        reasoningChoice = fresh.reasoningEnabled.map { $0 ? "on" : "off" } ?? "default"
        effortChoice = fresh.reasoningEffort
        budgetText = fresh.reasoningBudgetTokens.map(String.init) ?? ""
    }

    private var hasLocalDraft: Bool {
        reasoningChoice != (autosave.acknowledgedValues.reasoningEnabled.map { $0 ? "on" : "off" } ?? "default") ||
            effortChoice != autosave.acknowledgedValues.reasoningEffort ||
            budgetText != (autosave.acknowledgedValues.reasoningBudgetTokens.map(String.init) ?? "")
    }

    @ViewBuilder
    private func controlField(_ control: ModelControl) -> some View {
        switch (control.key, control.type) {
        case ("reasoningEnabled", "boolean"):
            booleanField(control)
        case ("reasoningEffort", "enum"):
            effortField(control)
        case ("reasoningBudgetTokens", "integer"):
            budgetField(control)
        default:
            EmptyView()
        }
    }

    private func booleanField(_ control: ModelControl) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(control.label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
            Picker(control.label, selection: Binding(
                get: { reasoningChoice },
                set: { choice in
                    reasoningChoice = choice
                    if choice == "off" {
                        effortChoice = nil
                        budgetText = ""
                    } else if choice == "on" {
                        clearExclusiveValues(for: "reasoningEnabled")
                    }
                    autosave.submit(candidate())
                }
            )) {
                Text("Default").tag("default")
                Text("On").tag("on")
                Text("Off").tag("off")
            }
            .pickerStyle(.segmented)
        }
    }

    private func effortField(_ control: ModelControl) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            let compact = (control.values ?? []).count + 1 <= 4
            let picker = Picker(control.label, selection: Binding(
                get: { effortChoice },
                set: { value in
                    effortChoice = value
                    if value != nil {
                        clearExclusiveValues(for: "reasoningEffort")
                    }
                    autosave.submit(candidate())
                }
            )) {
                Text(compact ? "Default" : "Provider default").tag(String?.none)
                ForEach(control.values ?? [], id: \.self) { value in
                    Text(value).tag(Optional(value))
                }
            }
            if compact {
                Text(control.label)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                picker.pickerStyle(.segmented)
                    .tint(Theme.accent)
                    .disabled(reasoningChoice == "off")
            } else {
                HStack(spacing: 8) {
                    Text(control.label)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                    Spacer(minLength: 0)
                    picker.pickerStyle(.menu)
                        .tint(Theme.accent)
                        .font(.system(size: 12))
                        .controlSize(.small)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            (reasoningChoice == "off" ? Theme.textMuted : Theme.accent).opacity(0.10),
                            in: Capsule()
                        )
                        .disabled(reasoningChoice == "off")
                }
            }
            if let saved = autosave.acknowledgedValues.reasoningEffort,
               !(control.values ?? []).contains(saved) {
                Text("Saved effort \(saved) is no longer listed; choose an offered value or default.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.warning)
            }
        }
    }

    private func budgetField(_ control: ModelControl) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(control.label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
            if control.min == -1 {
                Toggle("No reasoning budget enforcement", isOn: Binding(
                    get: { budgetText == "-1" },
                    set: { noEnforcement in
                        budgetText = noEnforcement ? "-1" : ""
                        if noEnforcement { clearExclusiveValues(for: "reasoningBudgetTokens") }
                        autosave.submit(candidate())
                    }
                ))
                .font(.system(size: 11))
                .tint(Theme.accent)
                .disabled(reasoningChoice == "off")
            }
            if !(control.min == -1 && budgetText == "-1") {
                TextField("Provider default", text: Binding(
                    get: { budgetText },
                    set: { value in
                        budgetText = value
                        if !value.trimmingCharacters(in: .whitespaces).isEmpty {
                            clearExclusiveValues(for: "reasoningBudgetTokens")
                        }
                        autosave.debounceBudget(candidate())
                    }
                ))
                .keyboardType(.numberPad)
                .focused($budgetFocused)
                .textFieldStyle(.roundedBorder)
                .disabled(reasoningChoice == "off")
            }
            if control.min != nil || control.max != nil {
                let minimum = (control.min == -1 ? 0 : control.min).map(String.init) ?? "any"
                let maximum = control.max.map(String.init) ?? "any"
                Text("Allowed tokens: \(minimum)–\(maximum)")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    private func candidate() -> Result<ModelBehaviorValues, Error> {
        do {
            return try .success(ModelManagement.validatedBehaviorValues(
                metadata: metadata,
                initial: autosave.acknowledgedValues,
                reasoningChoice: reasoningChoice,
                effortChoice: effortChoice,
                budgetText: budgetText
            ))
        } catch {
            return .failure(error)
        }
    }

    private func clearExclusiveValues(for key: String) {
        let peers = ModelManagement.exclusiveKeys(for: key, metadata: metadata)
        if peers.contains("reasoningEnabled") { reasoningChoice = "default" }
        if peers.contains("reasoningEffort") { effortChoice = nil }
        if peers.contains("reasoningBudgetTokens") { budgetText = "" }
    }

    private func reset() {
        budgetFocused = false
        autosave.reset()
    }
}

/// The assigned model and its controls share one selected-model card in the
/// picker, including when the backend is temporarily unavailable.
@available(iOS 17.0, *)
struct AssignedModelBehaviorCard: View {
    let behavior: ModelManagement.ActiveBehavior
    let display: ModelDisplay?
    let unavailableReason: String?
    var onSave: (String, ModelBehaviorValues, ModelBehaviorValues) async throws -> String = { _, _, _ in "" }

    private var brandId: String {
        behavior.metadata.source == "models.dev"
            ? behavior.metadata.providerId
            : display?.providerId ?? "http"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                BackendBrandIcon(key: brandId, size: 24)
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Assigned model")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                    Text(display?.modelName ?? behavior.assignment)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                    Text(display?.providerLabel ?? behavior.assignment)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer(minLength: 0)
                Image(systemName: display?.available == false ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(display?.available == false ? Theme.warning : Theme.success)
            }
            if let unavailableReason, !unavailableReason.isEmpty {
                Text(unavailableReason)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.warning)
            }
            if !behavior.metadata.controls.isEmpty || behavior.values != ModelBehaviorValues() {
                Divider()
                ModelBehaviorEditor(
                    assignment: behavior.assignment,
                    metadata: behavior.metadata,
                    initialValues: behavior.values,
                    onSave: onSave
                )
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.success.opacity(0.45), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }
}

#if DEBUG
@available(iOS 17.0, *)
extension ModelBehaviorEditor {
    static let previewCompactControls = ModelControls(
        providerId: "openai",
        source: "models.dev",
        reasoning: true,
        controls: [
            ModelControl(key: "reasoningEnabled", type: "boolean", label: "Reasoning"),
            ModelControl(key: "reasoningEffort", type: "enum", label: "Reasoning effort", values: ["low", "medium", "high"]),
        ]
    )
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — saved overrides") {
    ModelBehaviorEditor(
        assignment: "openai/gpt-example-frontier",
        metadata: PreviewMocks.modelReasoningControls,
        initialValues: PreviewMocks.modelReasoningValues
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — provider defaults") {
    ModelBehaviorEditor(
        assignment: "openai/gpt-example-frontier",
        metadata: PreviewMocks.modelReasoningControls,
        initialValues: ModelBehaviorValues()
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — save error") {
    ModelBehaviorEditor(
        assignment: "openai/gpt-example-frontier",
        metadata: PreviewMocks.modelReasoningControls,
        initialValues: PreviewMocks.modelReasoningValues,
        previewError: "The model changed while these settings were open. Reload and try again."
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — light appearance") {
    ModelBehaviorEditor(
        assignment: "openai/gpt-example-frontier",
        metadata: PreviewMocks.modelReasoningControls,
        initialValues: PreviewMocks.modelReasoningValues
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.light)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — exclusive options") {
    ModelBehaviorEditor(
        assignment: "openrouter/fictional-reasoning-model",
        metadata: PreviewMocks.modelExclusiveReasoningControls,
        initialValues: ModelBehaviorValues(reasoningEffort: "high")
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — no budget enforcement") {
    ModelBehaviorEditor(
        assignment: "nvidia/nemotron-example",
        metadata: PreviewMocks.modelUnlimitedBudgetControls,
        initialValues: ModelBehaviorValues(reasoningBudgetTokens: -1)
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — catalog options missing") {
    ModelBehaviorEditor(
        assignment: "openai/gpt-example-frontier",
        metadata: ModelControls(providerId: "unknown", source: "unknown", reasoning: nil, controls: []),
        initialValues: ModelBehaviorValues(reasoningEffort: "retired-option")
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — retired effort blocks save") {
    ModelBehaviorEditor(
        assignment: "openai/gpt-example-frontier",
        metadata: PreviewMocks.modelReasoningControls,
        initialValues: ModelBehaviorValues(reasoningEffort: "retired-option"),
        previewReasoningChoice: "on"
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — Off greys compact effort") {
    ModelBehaviorEditor(
        assignment: "openai/gpt-example-frontier",
        metadata: ModelBehaviorEditor.previewCompactControls,
        initialValues: ModelBehaviorValues(reasoningEnabled: false)
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — removed control requires reset") {
    ModelBehaviorEditor(
        assignment: "openai/gpt-example-frontier",
        metadata: ModelControls(
            providerId: "openai",
            source: "models.dev",
            reasoning: true,
            controls: [ModelControl(key: "reasoningEnabled", type: "boolean", label: "Reasoning")]
        ),
        initialValues: ModelBehaviorValues(reasoningEffort: "retired-option")
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ModelBehaviorEditor — concurrent update conflict") {
    ModelBehaviorEditor(
        assignment: "openai/gpt-example-frontier",
        metadata: ModelBehaviorEditor.previewCompactControls,
        initialValues: ModelBehaviorValues(reasoningEffort: "high"),
        previewConflict: true,
        previewEffortChoice: "medium"
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Assigned model — controls beneath model") {
    AssignedModelBehaviorCard(
        behavior: ModelManagement.ActiveBehavior(
            assignment: "openai/gpt-example-frontier",
            metadata: PreviewMocks.modelReasoningControls,
            values: PreviewMocks.modelReasoningValues
        ),
        display: ModelDisplay(
            providerId: "openai",
            providerLabel: "OpenAI",
            modelName: "GPT Example Frontier",
            available: true,
            configured: true
        ),
        unavailableReason: nil
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Assigned model — no configurable controls") {
    AssignedModelBehaviorCard(
        behavior: ModelManagement.ActiveBehavior(
            assignment: "northstar/chat-v1",
            metadata: ModelControls(providerId: "unknown", source: "unknown", reasoning: nil, controls: []),
            values: ModelBehaviorValues()
        ),
        display: ModelDisplay(
            providerId: "northstar",
            providerLabel: "Northstar",
            modelName: "Chat V1",
            available: true,
            configured: true
        ),
        unavailableReason: nil
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}
#endif
#endif
