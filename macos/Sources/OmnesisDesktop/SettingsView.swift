// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Omnesis
import ServiceManagement
import SwiftUI

struct DesktopSettingsView: View {
    @Environment(DesktopStore.self) private var store
    @State private var backgroundEnabled = false
    @State private var showStopConfirmation = false
    @State private var error: String?
    var body: some View {
        TabView {
            Form {
                Section("Background operation") {
                    Toggle("Keep Omnesis running when I sign in", isOn: $backgroundEnabled)
                        .onChange(of: backgroundEnabled) { _, enabled in configureBackground(enabled) }
                    Text(
                        "Omnesis keeps connected sources up to date while its window is closed. This Mac must be awake for a library stored here to serve your other devices."
                    )
                    .font(.callout).foregroundStyle(.secondary)
                    if SMAppService.loginItem(identifier: "dev.omnesis.desktop.background").status == .requiresApproval {
                        Button("Allow in System Settings") { SMAppService.openSystemSettingsLoginItems() }
                    }
                }
                Section("Your library") {
                    LabeledContent("Connection", value: store.state.statusLabel)
                    if let name = store.state.homeName { LabeledContent("Library Mac", value: name) }
                    if store.state.encrypted == true { Label("Encrypted storage is on", systemImage: "lock.shield") }
                    Button("Stop Omnesis on this Mac", role: .destructive) { showStopConfirmation = true }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }.formStyle(.grouped).tabItem { Label("General", systemImage: "gearshape") }
            DesktopModelsView().tabItem { Label("AI", systemImage: "sparkles") }
            DesktopStorageView().tabItem { Label("Storage", systemImage: "internaldrive") }
            Form {
                Text("Your library is stored on your chosen Mac. The connection service carries encrypted traffic between your devices.")
                Text(
                    "When you choose a cloud AI provider, information needed for your question is sent to that provider. You can use search without a cloud model."
                )
                .foregroundStyle(.secondary)
                Button("Open privacy and access settings") { store.openPortal() }
                Button("Open the web portal") { store.openPortal() }
            }.formStyle(.grouped).tabItem { Label("Privacy", systemImage: "hand.raised") }
        }.padding(12)
            .onAppear { backgroundEnabled = SMAppService.loginItem(identifier: "dev.omnesis.desktop.background").status == .enabled }
            .confirmationDialog("Stop Omnesis on this Mac?", isPresented: $showStopConfirmation) {
                Button("Stop Omnesis", role: .destructive) { store.command("stop") }
            } message: {
                Text(
                    "Your information stays on disk. If this Mac keeps your library, your other devices cannot use it until Omnesis starts again."
                )
            }
    }

    private func configureBackground(_ enabled: Bool) {
        do {
            let service = SMAppService.loginItem(identifier: "dev.omnesis.desktop.background")
            if enabled { try service.register() } else { try service.unregister() }
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct DesktopModelsView: View {
    @Environment(DesktopStore.self) private var store
    @State private var login: CodexLoginFlow?
    @State private var error: String?
    @State private var loading = false
    @State private var provider = ""
    @State private var apiKey = ""
    @State private var selectedModel = ""
    @State private var overview: ModelsOverview?
    var body: some View {
        Form {
            Section("Ask with a cloud AI model") {
                Text(
                    "Your chosen provider receives the information needed to answer your questions. Local search keeps working if you skip this step."
                )
                .foregroundStyle(.secondary)
                if overview?.inference.codex?.runtime?.supported == true {
                    Button("Sign in with ChatGPT") { Task { await startLogin() } }.disabled(loading)
                }
                if let login {
                    if let code = login.userCode { Text(code).font(.title.monospaced()).textSelection(.enabled) }
                    if let link = login.verificationUri,
                       let url = URL(string: link) { Button("Open sign-in page") { store.openBrowser(url) } }
                    Text(login.reason ?? login.status).foregroundStyle(.secondary)
                    Button("Check sign-in") { Task { await checkLogin() } }
                    Button("Cancel sign-in") { Task { _ = try? await store.api?.admin.cancelCodexLogin()
                        self.login = nil
                    } }
                }
            }
            Section("Use a provider key") {
                Picker("Provider", selection: $provider) {
                    Text("Choose a provider").tag("")
                    ForEach((overview?.presets ?? []).filter { $0.defaultUrl != nil }, id: \.id) { preset in
                        Text(preset.name).tag(preset.id)
                    }
                }
                SecureField("API key", text: $apiKey)
                Picker("Model", selection: $selectedModel) {
                    Text("Choose a model").tag("")
                    ForEach(overview?.presets.first(where: { $0.id == provider })?.knownModels ?? [], id: \.self) { model in
                        Text(model).tag(model)
                    }
                }
                Button("Connect provider") { Task { await saveProvider() } }
                    .disabled(provider.isEmpty || apiKey.isEmpty || selectedModel.isEmpty || loading)
            }
            if let error { Text(error).foregroundStyle(.red) }
            if loading { ProgressView("Connecting…") }
        }.formStyle(.grouped)
            .task { do { overview = try await store.api?.admin.modelOverview() } catch { self.error = error.localizedDescription } }
    }

    private func startLogin() async {
        loading = true
        defer { loading = false }
        do { login = try await store.api?.admin.startCodexLogin() } catch { self.error = error.localizedDescription }
    }

    private func checkLogin() async {
        do {
            login = try await store.api?.admin.getCodexLogin()
            if login?.status == "complete", let api = store.api {
                let status = try await api.admin.refreshCodexBackend()
                guard let model = status.modelDetails?.first(where: { $0.recommended == true })?.id ?? status.models.first else {
                    throw DesktopAPIError.message("Sign-in finished, but no AI model is available for this account yet.")
                }
                try await api.mutate("POST", "admin/inference/codex/agent", body: ["model": model])
                login = nil
            }
        } catch { self.error = error.localizedDescription }
    }

    private func saveProvider() async {
        guard let api = store.api, let preset = overview?.presets.first(where: { $0.id == provider }),
              let providerURL = preset.defaultUrl else { return }
        loading = true
        defer { loading = false }
        do {
            try await api.mutate("PATCH", "admin/config", body: ["inference": [
                "allowRemoteInference": true,
                "backends": [preset.id: [
                    "type": "http",
                    "url": providerURL,
                    "preset": preset.id,
                    "apiKey": apiKey,
                    "apiPathPrefix": preset.apiPathPrefix ?? "/v1",
                ]],
                "assignments": ["agent": "\(preset.id)/\(selectedModel)"],
            ]])
            apiKey = ""
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct DesktopStorageView: View {
    @Environment(DesktopStore.self) private var store
    @State private var snapshot: StorageSnapshot?
    @State private var error: String?
    var body: some View {
        Form {
            Section("Library storage") {
                if let snapshot {
                    Text(snapshot.pressure
                        .state == "blocked" ? "New information is paused to protect your disk. You can still search and ask questions." :
                        "Omnesis watches available disk space and pauses new data when storage is low.")
                    if let used = snapshot.pressure.usageBytes { LabeledContent(
                        "Used",
                        value: ByteCountFormatter.string(fromByteCount: used, countStyle: .file)
                    ) }
                }
                Text(
                    "Removing original files is never part of automatic cleanup. Review your library’s limits and retained history before freeing space."
                )
                .foregroundStyle(.secondary)
                Button("Manage storage and cleanup") { store.openPortal() }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }.formStyle(.grouped).task {
            do { snapshot = try await store.api?.request("GET", "admin/storage") } catch { self.error = error.localizedDescription }
        }
    }

    struct StorageSnapshot: Decodable {
        let pressure: Pressure
        struct Pressure: Decodable { let state: String
            let usageBytes: Int64?
        }
    }
}
