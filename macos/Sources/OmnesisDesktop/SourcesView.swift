// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI

struct DesktopSourcesView: View {
    @Environment(DesktopStore.self) private var store
    @State private var showPicker = false
    var body: some View {
        Group {
            if store.sources.isEmpty {
                ContentUnavailableView {
                    Label("Bring your information together", systemImage: "square.stack.3d.up")
                } description: { Text("Connect an account or information on this Mac. Your originals stay where they are.") }
                    actions: { Button("Add a source") { showPicker = true }.buttonStyle(.borderedProminent) }
            } else {
                List(store.sources) { source in
                    HStack {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(store.descriptors.first(where: { $0.id == source.type })?.name ?? source.type).font(.headline)
                            Text(source.accountId).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(source.enabled ? "Connected" : "Paused").foregroundStyle(source.enabled ? Color.green : Color.secondary)
                        Button(source.enabled ? "Pause" : "Resume") {
                            Task {
                                do {
                                    try await store.api?.mutate(
                                        "PATCH",
                                        "admin/sources/\(pathPart(source.id))",
                                        body: ["enabled": !source.enabled]
                                    )
                                    await store.refresh()
                                } catch { store.failure = error.localizedDescription }
                            }
                        }
                    }.padding(.vertical, 8)
                }
            }
        }.navigationTitle("Sources")
            .toolbar {
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.refresh() } }
                Button("Add a source", systemImage: "plus") { showPicker = true }.accessibilityIdentifier("add-source")
            }
            .sheet(isPresented: $showPicker) { SourcePickerView().environment(store) }
    }
}

struct SourcePickerView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var selected: String?
    var body: some View {
        NavigationStack {
            List(store.descriptors) { descriptor in
                NavigationLink {
                    if let api = store.api { SourceSetupView(flow: DesktopSourceFlow(descriptor: descriptor, api: api)).environment(store) }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(descriptor.name).font(.headline)
                        Text(descriptor.description).font(.callout).foregroundStyle(.secondary)
                    }.padding(.vertical, 6)
                }
            }.overlay {
                if store.descriptors.isEmpty { ContentUnavailableView(
                    "Finding available sources",
                    systemImage: "clock",
                    description: Text("Keep this Mac connected. Sources appear once Omnesis has finished starting.")
                ) }
            }
            .navigationTitle("Add a source")
            .toolbar { Button("Done") { dismiss() } }
        }.frame(width: 680, height: 620)
    }
}

struct SourceSetupView: View {
    @Environment(DesktopStore.self) private var store
    @State var flow: DesktopSourceFlow
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(flow.descriptor.description).foregroundStyle(.secondary)
                if flow.complete {
                    Label("Connected", systemImage: "checkmark.circle.fill").font(.title2).foregroundStyle(.green)
                    Text("Omnesis will keep this source up to date.")
                } else if let auth = flow.auth {
                    authView(auth)
                } else if !flow.accounts.isEmpty {
                    Text("Choose the accounts to connect").font(.headline)
                    ForEach(flow.accounts, id: \.self) { account in
                        Toggle(account, isOn: Binding(get: { flow.selectedAccounts.contains(account) }, set: { selected in
                            if selected { flow.selectedAccounts.insert(account) } else { flow.selectedAccounts.remove(account) }
                        }))
                    }
                    Button("Connect selected accounts") { Task { await flow.add()
                        await store.refresh()
                    } }.buttonStyle(.borderedProminent)
                } else {
                    if let hosts = flow.descriptor.devices, hosts.count > 1 {
                        Picker("Connect from", selection: $flow.deviceId) {
                            ForEach(hosts) { host in Text(host.name ?? "My Mac").tag(host.id) }
                        }
                    }
                    ForEach(flow.descriptor.params ?? []) { param in
                        SourceParameterField(
                            param: param,
                            value: binding(flow.params, key: param.name) { flow.params = $0 },
                            allowsFilePicker: flow.deviceId == flow.api.connection.collectorDeviceId
                        )
                    }
                    if let spec = flow.descriptor.credentials {
                        Text("Account access").font(.headline)
                        Text("If this provider needs an application key, enter it here. Keys are sent securely and are never shown again.")
                            .font(.callout).foregroundStyle(.secondary)
                        ForEach(spec.fields) { field in
                            VStack(alignment: .leading) {
                                Text(field.label)
                                if field.secret != false {
                                    SecureField(
                                        field.placeholder ?? field.label,
                                        text: binding(flow.credentials, key: field.name) { flow.credentials = $0 }
                                    )
                                } else {
                                    TextField(
                                        field.placeholder ?? field.label,
                                        text: binding(flow.credentials, key: field.name) { flow.credentials = $0 }
                                    )
                                }
                            }
                        }
                    }
                    Button("Continue") { Task { await flow.begin() } }.buttonStyle(.borderedProminent)
                }
                if let error = flow.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                if flow.busy { ProgressView("Connecting…") }
                Button("Open advanced setup") { store.openPortal() }.font(.callout)
            }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
        }.navigationTitle(flow.descriptor.name).disabled(flow.busy)
            .onChange(of: flow.complete) { if flow.complete { Task { await store.refresh() } } }
            .onDisappear { Task { await flow.cancel() } }
    }

    @ViewBuilder private func authView(_ auth: AuthSnapshot) -> some View {
        if let pending = auth.pendingChallenge {
            let challenge = pending.challenge
            Text(challenge.title).font(.headline)
            if let instructions = challenge.instructions { Text(instructions) }
            if let url = challenge.url { Button("Continue in your browser") { store.openBrowser(url) }.buttonStyle(.borderedProminent) }
            if let data = challenge.data { QRCodeView(payload: data) }
            ForEach(challenge.fields ?? []) { param in
                SourceParameterField(
                    param: param,
                    value: binding(flow.answer, key: param.name) { flow.answer = $0 },
                    allowsFilePicker: false
                )
            }
            if pending.expectsAnswer {
                if challenge.kind == "code" || challenge.kind == "redirect" {
                    SecureField(
                        challenge.kind == "code" ? "Confirmation code" : "Completed sign-in link",
                        text: binding(flow.answer, key: challenge.kind == "code" ? "code" : "url") { flow.answer = $0 }
                    )
                }
                Button("Continue") { Task { await flow.submitAnswer() } }.buttonStyle(.borderedProminent)
            } else { ProgressView("Waiting for confirmation…") }
        } else {
            if let url = auth.authUrl { Button("Continue in your browser") { store.openBrowser(url) } }
            if let data = auth.qrData { QRCodeView(payload: data) }
            ProgressView("Waiting for confirmation…")
        }
        Button("Cancel sign-in") { Task { await flow.cancel() } }
    }

    private func binding(_ values: [String: String], key: String, update: @escaping ([String: String]) -> Void) -> Binding<String> {
        Binding(get: { values[key] ?? "" }, set: { value in var next = values
            next[key] = value
            update(next)
        })
    }
}

struct SourceParameterField: View {
    let param: DesktopDescriptor.Param
    @Binding var value: String
    let allowsFilePicker: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(param.label)
            if param.type == "secret" { SecureField(param.placeholder ?? param.label, text: $value) }
            else if param.type == "select" {
                Picker(param.label, selection: $value) {
                    Text("Choose…").tag("")
                    ForEach(param.options ?? []) { option in Text(option.label).tag(option.value) }
                }.labelsHidden()
            } else {
                HStack {
                    TextField(param.placeholder ?? param.label, text: $value)
                    if param.type == "path", allowsFilePicker {
                        Button("Choose…") {
                            let panel = NSOpenPanel()
                            panel.canChooseDirectories = true
                            panel.canChooseFiles = true
                            if panel.runModal() == .OK, let url = panel.url { value = url.path }
                        }
                    }
                }
            }
            if let help = param.help { Text(help).font(.caption).foregroundStyle(.secondary) }
        }.textFieldStyle(.roundedBorder)
    }
}

struct QRCodeView: View {
    let payload: String
    var body: some View {
        if let image {
            Image(nsImage: image).interpolation(.none).resizable().frame(width: 220, height: 220)
                .padding(14).background(.white).clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel("Scan this code with the app you are connecting")
        }
    }

    private var image: NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        guard let output = filter.outputImage,
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: output.extent.width, height: output.extent.height))
    }
}
