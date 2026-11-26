// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Omnesis
import SwiftUI

struct DesktopModelCredentialsView: View {
    let entries: [ModelCredentialEntry]
    let context: DesktopAPIContext
    let saved: () async -> Void
    var body: some View {
        ForEach(entries.filter { !$0.spec.fields.isEmpty }) { entry in
            Section("\(entry.providerName) API credentials") {
                DesktopModelCredentialForm(entry: entry, context: context, saved: saved)
            }
        }
    }
}

private struct DesktopModelCredentialForm: View {
    let entry: ModelCredentialEntry
    let context: DesktopAPIContext
    let saved: () async -> Void
    @State private var values: [String: String] = [:]
    @State private var loading = false
    @State private var error: String?
    @State private var savedKey = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if entry.configured { Label("API credentials saved", systemImage: "key") }
            Text(
                "Saving a key keeps the provider connection available. Choose a model for each task separately; saving does not enable a task."
            )
            .font(.callout).foregroundStyle(.secondary)
            ForEach(entry.spec.fields) { field in
                let binding = Binding(get: { values[field.name] ?? "" }, set: { values[field.name] = $0 })
                if field
                    .secret ==
                    true {
                    SecureField(field.label, text: binding).privacySensitive()
                        .accessibilityIdentifier("model-credential-" + entry.fileKey + "-" + field.name)
                } else {
                    TextField(field.label, text: binding).privacySensitive()
                        .accessibilityIdentifier("model-credential-" + entry.fileKey + "-" + field.name)
                }
                if let hint = field.patternHint { Text(hint).font(.caption).foregroundStyle(.secondary) }
            }
            Button(entry.configured ? "Replace API credentials" : "Save API credentials") { context.run { _ in await save() } }
                .accessibilityIdentifier("model-credential-save-" + entry.fileKey)
                .disabled(loading || entry.spec.fields
                    .contains { (values[$0.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } || values.values
                    .contains { $0.utf8.count > 16384 })
            if loading { ProgressView("Saving credentials…") }
            if savedKey { Text("Credentials saved. Select the tasks you want this provider to serve.").font(.callout) }
            if let error { Text(error).foregroundStyle(DesktopTheme.danger) }
        }.onDisappear { values.removeAll() }
    }

    private func save() async {
        loading = true
        error = nil
        savedKey = false
        let fields = values
        values.removeAll()
        defer { loading = false }
        do {
            try await context.perform { try await $0.admin.setModelCredentials(fileKey: entry.fileKey, fields: fields) }
            let current = try await context.perform { try await $0.admin.listModelCredentials() }
            guard current.first(where: { $0.fileKey == entry.fileKey })?.configured == true else {
                throw DesktopAPIError.message("The provider key could not be verified as saved. Try again.")
            }
            savedKey = true
            await saved()
        } catch { self.error = error.localizedDescription }
    }
}
