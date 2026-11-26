// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

struct SourceCredentialsView: View {
    @Bindable var flow: DesktopSourceFlow
    @Environment(DesktopStore.self) private var store
    var body: some View {
        if let spec = flow.descriptor.credentials {
            VStack(alignment: .leading, spacing: 16) {
                Text("Account access").font(.title2)
                if let wizard = spec.wizard {
                    Text(wizard.intro)
                    Text(wizard.why).font(.callout).foregroundStyle(DesktopTheme.secondary)
                    Text("About \(wizard.estMinutes) minutes").font(.caption).foregroundStyle(DesktopTheme.secondary)
                    if flow.credentialsStep < wizard.steps.count {
                        let step = wizard.steps[flow.credentialsStep]
                        Text("Step \(flow.credentialsStep + 1) of \(wizard.steps.count)").font(.caption)
                        Text(step.title).font(.headline)
                        Text(.init(flow.expand(step.body))).textSelection(.enabled)
                        if step.kind == "open-url", let url = step.url {
                            Button("Open in browser") { store.openBrowser(url) }
                        }
                        HStack {
                            if flow.credentialsStep > 0 { Button("Back") { flow.credentialsStep -= 1 } }
                            Button("Continue") { flow.credentialsStep += 1 }.buttonStyle(DesktopButtonStyle(primary: true))
                        }
                    } else { fields(spec) }
                } else { fields(spec) }
            }
        }
    }

    @ViewBuilder private func fields(_ spec: DesktopDescriptor.Credentials) -> some View {
        Text("Paste the values from your provider. Omnesis sends them securely to the selected device.")
            .font(.callout).foregroundStyle(DesktopTheme.secondary)
        ForEach(spec.fields) { field in
            VStack(alignment: .leading, spacing: 6) {
                Text(field.label + (field.required == false ? " (optional)" : ""))
                if field.secret == true {
                    SecureField(flow.expand(field.placeholder ?? field.label), text: binding(field.name))
                        .accessibilityLabel(field.label)
                        .accessibilityHint(field.required == false ? "Optional" : "Required")
                } else {
                    TextField(flow.expand(field.placeholder ?? field.label), text: binding(field.name))
                        .accessibilityLabel(field.label)
                        .accessibilityHint(field.required == false ? "Optional" : "Required")
                }
                if let hint = field.patternHint { Text(hint).font(.caption).foregroundStyle(DesktopTheme.secondary) }
            }.textFieldStyle(.roundedBorder)
        }
        HStack {
            if let wizard = spec.wizard, !wizard.steps.isEmpty { Button("Back") { flow.credentialsStep = wizard.steps.count - 1 } }
            Button("Connect account") { Task { await flow.continueCredentials() } }.buttonStyle(DesktopButtonStyle(primary: true))
        }
    }

    private func binding(_ name: String) -> Binding<String> {
        Binding(get: { flow.credentials[name] ?? "" }, set: { flow.credentials[name] = $0 })
    }
}

struct SourceChallengeField: View {
    let field: SourceConfigField
    @Binding var value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(field.label)
            switch field.kind {
            case "secret": SecureField(field.placeholder ?? field.label, text: $value).accessibilityLabel(field.label)
            case "boolean": Toggle(field.label, isOn: Binding(get: { value == "true" }, set: { value = $0 ? "true" : "false" }))
                .labelsHidden()
            case "select":
                Picker(field.label, selection: $value) {
                    Text("Choose…").tag("")
                    ForEach(field.options ?? []) { Text($0.label).tag($0.value) }
                }.labelsHidden()
            case "list": TextEditor(text: $value).frame(minHeight: 80).accessibilityLabel(field.label)
                .accessibilityHint(field.required == true ? "Required. Enter one value per line." : "Enter one value per line.")
            case "string", "path", "number": TextField(field.placeholder ?? field.label, text: $value).accessibilityLabel(field.label)
            default: Text("Update Omnesis to complete this sign-in step.").foregroundStyle(DesktopTheme.danger)
            }
            if let help = field.help { Text(help).font(.caption).foregroundStyle(DesktopTheme.secondary) }
        }.textFieldStyle(.roundedBorder)
    }
}
