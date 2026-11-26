// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Omnesis
import SwiftUI

struct DesktopModelRolesView: View {
    let overview: ModelsOverview
    let context: DesktopAPIContext
    let updated: (ModelsOverview) -> Void
    var reviewingRestoredLibrary = false
    var body: some View {
        Section("Choose which models to use") {
            Text(
                reviewingRestoredLibrary
                    ? "Your model connections were kept. Choose which models may use your restored information; nothing is turned back on automatically."
                    : "Start with a model for questions and answers. You can leave the other model choices unchanged."
            )
            .foregroundStyle(.secondary)
            ForEach(overview.capabilities.filter { !$0.experimental && $0.configurableOnDevice && $0.role == "agent" }) { capability in
                DesktopModelRoleRow(capability: capability, overview: overview, context: context, updated: updated)
            }
            DisclosureGroup("Other model choices") {
                ForEach(overview.capabilities.filter { !$0.experimental && $0.configurableOnDevice && $0.role != "agent" }) { capability in
                    DesktopModelRoleRow(capability: capability, overview: overview, context: context, updated: updated)
                }
            }
        }
    }
}

private struct DesktopModelRoleRow: View {
    let capability: CapabilityMeta
    let overview: ModelsOverview
    let context: DesktopAPIContext
    let updated: (ModelsOverview) -> Void
    @State private var selection = ""
    @State private var loading = false
    @State private var pending: DesktopModelChoice?
    @State private var error: String?
    @State private var notice: String?
    private var choices: [DesktopModelChoice] {
        DesktopModelSelection.choices(for: capability.role, overview: overview)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(capability.title).font(.headline)
            Text(capability.description).font(.callout).foregroundStyle(.secondary)
            if let current = overview.assignmentDisplays[capability.role], current.configured {
                Text("Selected: \(current.providerLabel) · \(current.modelName)")
                if !current
                    .available {
                    Text("This model is currently unavailable. Check its connection or choose another model.").foregroundStyle(.orange)
                }
            } else { Text("Not in use").foregroundStyle(.secondary) }
            Picker("Model for \(capability.title)", selection: $selection) {
                Text("Choose a model").tag("")
                Text("Do not use a model for this").tag("disabled")
                ForEach(choices) { choice in Text(choice.title).tag(choice.id) }
            }
            .accessibilityIdentifier("model-role-picker-" + capability.role)
            Button("Save selection") {
                if selection == "disabled" { context.run { _ in await apply(nil) } }
                else if let choice = choices.first(where: { $0.id == selection }) {
                    if choice.onHost { context.run { _ in await apply(choice) } } else { pending = choice }
                }
            }.accessibilityIdentifier("model-role-save-" + capability.role).disabled(loading || selection.isEmpty)
            if loading { ProgressView("Saving selection…") }
            if let notice { Text(notice).font(.callout).foregroundStyle(.secondary) }
            if let error { Text(error).foregroundStyle(DesktopTheme.danger) }
        }.padding(.vertical, 8)
            .confirmationDialog("Use a model outside your library server?", isPresented: Binding(
                get: { pending != nil }, set: { if !$0 { pending = nil } }
            ), presenting: pending) { choice in
                Button("Use this model") { pending = nil
                    context.run { _ in await apply(choice) }
                }.accessibilityIdentifier("model-role-confirm-" + capability.role)
            } message: { _ in
                Text(capability.role == "embedder" ?
                    "This sends documents to the selected provider as they are indexed for search. Allowing remote inference also permits other assigned remote models to run their tasks." :
                    "Information used for this task is sent to the selected provider. Allowing remote inference also permits other assigned remote models to run their tasks.")
            }
    }

    private func apply(_ choice: DesktopModelChoice?) async {
        loading = true
        error = nil
        notice = nil
        defer { loading = false }
        do {
            if let choice {
                if !choice.onHost, overview.inference.allowRemoteInference != true {
                    try await context.mutate("PATCH", "admin/config", body: ["inference": ["allowRemoteInference": true]])
                }
                switch choice.apply {
                case .assign(let value): try await context.perform { try await $0.admin.assignCapability(
                        role: capability.role,
                        assignment: value
                    ) }
                case .activate(let id, let role): try await context.perform { try await $0.admin.activateModel(
                        catalogId: id,
                        role: role,
                        capability: capability.role
                    ) }
                }
            } else { try await context.perform { try await $0.admin.assignCapability(role: capability.role, assignment: nil) } }
            let fresh = try await context.perform { try await $0.admin.modelOverview() }
            updated(fresh)
            notice = "Selection saved. Current availability is shown above."
            selection = ""
        } catch { self.error = error.localizedDescription }
    }
}
