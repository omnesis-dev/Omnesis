// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Omnesis
import ServiceManagement
import SwiftUI

struct DesktopSettingsView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @State private var backgroundEnabled = false
    @State private var showStopConfirmation = false
    @State private var error: String?
    var body: some View {
        @Bindable var store = store
        TabView(selection: $store.settingsTab) {
            Form {
                Section("Background operation") {
                    Toggle("Keep Omnesis running when I sign in", isOn: Binding(
                        get: { backgroundEnabled }, set: { configureBackground($0) }
                    ))
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
                    if store.state.encrypted == true { Label(
                        store.state
                            .mode == "joined" ? "This Mac and your library use encrypted storage" :
                            "Your library on this Mac uses encrypted storage",
                        systemImage: "lock.shield"
                    ) }
                    Button("Recovery protection…") {
                        store.recoveryStatus = nil
                        store.recoveryDraft = nil
                        store.recoverySaved = false
                        store.presentRecovery = true
                        openWindow(id: "main")
                    }.disabled(store.busy)
                    Button("Stop Omnesis on this Mac", role: .destructive) { showStopConfirmation = true }
                    Button("Remove Omnesis from this Mac…", role: .destructive) {
                        store.removalPlan = nil
                        store.removalOutcome = nil
                        store.presentRemoval = true
                        openWindow(id: "main")
                    }.disabled(store.busy)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }.formStyle(.grouped).tabItem { Label("General", systemImage: "gearshape") }.tag("general")
            DesktopModelsView().tabItem { Label("AI", systemImage: "sparkles") }.tag("ai")
            DesktopBackupsView().tabItem { Label("Backups", systemImage: "externaldrive") }.tag("backups")
            DesktopMemoryView().tabItem { Label("Memory", systemImage: "memorychip") }.tag("memory")
            DesktopUpdatesView().tabItem { Label("Updates", systemImage: "arrow.down.circle") }.tag("updates")
            DesktopStorageView().tabItem { Label("Storage", systemImage: "internaldrive") }.tag("storage")
            Form {
                Text("Your library is stored on your chosen Mac. The connection service carries encrypted traffic between your devices.")
                Text(
                    "When you choose a cloud AI provider, information needed for your question is sent to that provider. You can use search without a cloud model."
                )
                .foregroundStyle(.secondary)
                Button("Open privacy and access settings") { store.openPortal() }
                Button("Open the web portal") { store.openPortal() }
            }.formStyle(.grouped).tabItem { Label("Privacy", systemImage: "hand.raised") }.tag("privacy")
        }.padding(12).frame(minWidth: 640, minHeight: 500)
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
            backgroundEnabled = enabled
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
    @State private var credentialEntries: [ModelCredentialEntry] = []
    @State private var refreshGeneration = UUID()
    @State private var confirmingSignOut = false
    var body: some View {
        Form {
            Button("Refresh model connections") { Task { await refreshModels() } }.disabled(loading || store.api == nil)
            if let overview, let api = store.api {
                DesktopModelRolesView(overview: overview, api: api) {
                    guard store.api === api else { return }
                    refreshGeneration = UUID()
                    self.overview = $0
                }
                DesktopModelCredentialsView(entries: credentialEntries, api: api) { await refreshModels() }
            }
            Section("Ask with a cloud AI model") {
                Text(
                    "Your chosen provider receives the information needed to answer your questions. Local search keeps working if you skip this step."
                )
                .foregroundStyle(.secondary)
                if overview?.inference.codex?.runtime?.supported == true {
                    if overview?.inference.codex?.loggedIn != true {
                        Button("Sign in with ChatGPT") { Task { await startLogin() } }.disabled(loading)
                    }
                    Button("Sign out of ChatGPT…") { confirmingSignOut = true }.disabled(loading)
                }
                if let status = overview?.inference.codex, status.status != "ok", let reason = status.reason {
                    Text(reason).font(.callout).foregroundStyle(.secondary)
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
                Text(
                    "Enabling an off-Mac provider permits all models assigned away from your library Mac to receive information for their tasks."
                )
                .font(.callout).foregroundStyle(.secondary)
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
            if loading { ProgressView("Updating AI settings…") }
        }.formStyle(.grouped)
            .task(id: store.api.map { ObjectIdentifier($0) }) { await refreshModels() }
            .confirmationDialog("Sign out of ChatGPT?", isPresented: $confirmingSignOut) {
                Button("Sign out of ChatGPT", role: .destructive) { Task { await signOut() } }
            } message: {
                Text(
                    "This removes Omnesis’s ChatGPT sign-in and its model assignments. Running Omnesis ChatGPT tasks finish before the sign-in is removed. Your separate Codex app or terminal sign-in is not changed."
                )
            }
    }

    private func refreshModels() async {
        let generation = UUID()
        refreshGeneration = generation
        guard let api = store.api else {
            overview = nil
            credentialEntries = []
            login = nil
            return
        }
        do {
            async let models = api.admin.modelOverview()
            async let credentials = api.admin.listModelCredentials()
            let result = try await (models, credentials)
            guard !Task.isCancelled, refreshGeneration == generation, store.api === api else { return }
            overview = result.0
            credentialEntries = result.1
            error = nil
        } catch is CancellationError { } catch {
            guard refreshGeneration == generation, store.api === api else { return }
            self.error = error.localizedDescription
        }
    }

    private func startLogin() async {
        loading = true
        defer { loading = false }
        do { login = try await store.api?.admin.startCodexLogin() } catch { self.error = error.localizedDescription }
    }

    private func signOut() async {
        guard let api = store.api else { return }
        loading = true
        defer { loading = false }
        do {
            _ = try await api.admin.removeCodexBackend()
            guard store.api === api else { return }
            login = nil
            await refreshModels()
        } catch {
            self.error = "Sign-out could not be confirmed. Refresh model connections before trying again. \(error.localizedDescription)"
        }
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
                await refreshModels()
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
            await refreshModels()
        } catch { self.error = error.localizedDescription }
    }
}
