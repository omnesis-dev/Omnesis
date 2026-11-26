// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Omnesis
import SwiftUI

enum DesktopSettingsPrerequisite: Hashable { case startup, power, services }

struct DesktopSettingsView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @State private var showStopConfirmation = false
    @State private var prerequisiteOrder: [DesktopSettingsPrerequisite] = []

    static func orderedPrerequisites(
        startupReady: Bool,
        powerReady: Bool,
        servicesReady: Bool,
        home: Bool
    )
        -> [DesktopSettingsPrerequisite] {
        let entries: [(DesktopSettingsPrerequisite, Bool)] = [(.startup, startupReady)] + (home ? [
            (.power, powerReady),
            (.services, servicesReady),
        ] : [])
        return entries.filter { !$0.1 }.map(\.0) + entries.filter(\.1).map(\.0)
    }

    private var currentPrerequisiteOrder: [DesktopSettingsPrerequisite] {
        Self.orderedPrerequisites(
            startupReady: store.applicationInstallationCurrent && store.automaticStartup.ready,
            powerReady: store.serverPower.ready,
            servicesReady: store.homeServices.storage == .ready && store.homeServices.route == .ready,
            home: store.state.mode == "home"
        )
    }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            DesktopBrandHeading(subtitle: "Settings").padding(22).background(DesktopTheme.sidebar)
            TabView(selection: $store.settingsTab) {
                Form {
                    ForEach(prerequisiteOrder.isEmpty ? currentPrerequisiteOrder : prerequisiteOrder, id: \.self) { section in
                        prerequisite(section)
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
                    }
                    Section("Protection and collection access") {
                        Button("Access on this Mac…") { store.accessFocus = nil
                            store.presentAccess = true
                            openWindow(id: "main", value: DesktopWindowIdentity.main)
                        }
                        Button("Recovery protection…") {
                            store.recoveryStatus = nil
                            store.recoveryDraft = nil
                            store.recoverySaved = false
                            store.presentRecovery = true
                            openWindow(id: "main", value: DesktopWindowIdentity.main)
                        }.disabled(store.busy)
                    }
                    Section("Maintenance") {
                        Text("Stopping or removing Omnesis is separate from protecting your library or choosing what it may collect.")
                            .font(.callout).foregroundStyle(DesktopTheme.secondary)
                        Button("Stop Omnesis on this Mac", role: .destructive) { showStopConfirmation = true }
                        Button("Remove Omnesis from this Mac…", role: .destructive) {
                            store.removalPlan = nil
                            store.removalOutcome = nil
                            store.presentRemoval = true
                            openWindow(id: "main", value: DesktopWindowIdentity.main)
                        }.disabled(store.busy)
                    }
                }.formStyle(.grouped).omnesisTheme().onAppear { prerequisiteOrder = currentPrerequisiteOrder }
                    .onChange(of: store.state.mode) { prerequisiteOrder = currentPrerequisiteOrder }.tabItem { Label(
                        "General",
                        systemImage: "gearshape"
                    ) }.tag("general")
                DesktopModelsView().tabItem { Label("AI", systemImage: "sparkles") }.tag("ai")
                DesktopBackupsView().tabItem { Label("Backups", systemImage: "externaldrive") }.tag("backups")
                DesktopMemoryView().tabItem { Label("Memory", systemImage: "memorychip") }.tag("memory")
                DesktopUpdatesView().tabItem { Label("Updates", systemImage: "arrow.down.circle") }.tag("updates")
                DesktopStorageView().tabItem { Label("Storage", systemImage: "internaldrive") }.tag("storage")
                Form {
                    Text(
                        "Your library is stored on your chosen Mac. The connection service carries encrypted traffic between your devices."
                    )
                    Text(
                        "When you choose a cloud AI provider, information needed for your question is sent to that provider. You can use search without a cloud model."
                    )
                    .foregroundStyle(DesktopTheme.secondary)
                    Button("Open the web portal") { store.openPortal() }
                }.formStyle(.grouped).omnesisTheme().tabItem { Label("Privacy", systemImage: "hand.raised") }.tag("privacy")
            }.padding(12)
        }.frame(minWidth: 640, minHeight: 500).omnesisTheme().omnesisWindowChrome()
            .onChange(of: store.settingsTab) { if store.settingsTab == "general" { prerequisiteOrder = currentPrerequisiteOrder } }
            .confirmationDialog("Stop Omnesis on this Mac?", isPresented: $showStopConfirmation) {
                Button("Stop Omnesis", role: .destructive) { store.command("stop") }
            } message: {
                Text(
                    "Your information stays on disk. If this Mac keeps your library, your other devices cannot use it until Omnesis starts again."
                )
            }
    }

    @ViewBuilder
    private func prerequisite(_ section: DesktopSettingsPrerequisite) -> some View {
        switch section {
        case .startup:
            Section {
                DesktopStartupPrerequisiteView()
                Text(
                    "Closing the window keeps collection running while this Mac is awake. Automatic startup starts Omnesis at sign-in; it does not prevent sleep."
                )
                .font(.callout).foregroundStyle(DesktopTheme.secondary)
            } header: { Text("Launch at sign-in").accessibilityIdentifier("settings-prerequisite-startup") }
        case .power:
            Section {
                DesktopMacServerPrerequisite(
                    flow: store.serverPower,
                    primaryAction: DesktopSetupRepair.first(in: store) == .power,
                    compactReady: true,
                    compactChecking: true
                )
            } header: { Text("Library Mac power · Required").accessibilityIdentifier("settings-prerequisite-power") }
        case .services:
            Section {
                DesktopHomeServicePrerequisites(compactReady: true)
            } header: { Text("Library storage and connection · Required").accessibilityIdentifier("settings-prerequisite-services") }
        }
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
    var loadModels = true
    init(initialOverview: ModelsOverview? = nil, loadModels: Bool = true) {
        _overview = State(initialValue: initialOverview)
        self.loadModels = loadModels
    }

    var body: some View {
        Form {
            Section("Choose how Omnesis answers") {
                Text("Start with an AI provider you already use. You can skip this and keep searching your library.")
                Text(
                    "A model running on your library Mac keeps its work there. A cloud model receives the information needed for each answer. Provider API keys can incur usage charges; check your provider’s pricing before connecting."
                )
                .font(.callout).foregroundStyle(DesktopTheme.secondary)
                if store.reviewModelsAfterRestore {
                    Text("After restoring, your saved connections stay available but no model is used until you choose it below.")
                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                }
            }
            Button("Refresh model connections") { Task { await refreshModels() } }.disabled(loading || store.api == nil)
            if let overview, let api = store.api {
                if store.reviewModelsAfterRestore || overview.assignmentDisplays.values.contains(where: \.configured)
                    || overview.capabilities.contains(where: { !DesktopModelSelection.choices(for: $0.role, overview: overview).isEmpty }) {
                    DesktopModelRolesView(overview: overview, api: api, updated: {
                        guard store.api === api else { return }
                        refreshGeneration = UUID()
                        store.observeModelOverview($0)
                        self.overview = $0
                    }, reviewingRestoredLibrary: store.reviewModelsAfterRestore)
                }
                DesktopModelCredentialsView(entries: credentialEntries, api: api) { await refreshModels() }
            }
            if overview?.inference.codex != nil || login != nil {
                Section("ChatGPT sign-in") {
                    Text(
                        "Your chosen provider receives the information needed to answer your questions. Local search keeps working if you skip this step."
                    )
                    .foregroundStyle(DesktopTheme.secondary)
                    if overview?.inference.codex?.runtime?.supported == true {
                        if overview?.inference.codex?.loggedIn != true {
                            Button("Sign in with ChatGPT") { Task { await startLogin() } }.disabled(loading)
                        }
                        if overview?.inference.codex?.loggedIn == true {
                            Button("Sign out of ChatGPT…") { confirmingSignOut = true }.disabled(loading)
                        }
                    }
                    if let status = overview?.inference.codex, status.status != "ok", let reason = status.reason {
                        Text(reason).font(.callout).foregroundStyle(DesktopTheme.secondary)
                    }
                    if let login {
                        if let code = login.userCode { Text(code).font(.title.monospaced()).textSelection(.enabled) }
                        if let link = login.verificationUri,
                           let url = URL(string: link) { Button("Open sign-in page") { store.openBrowser(url) } }
                        Text(login.reason ?? login.status).foregroundStyle(DesktopTheme.secondary)
                        Button("Check sign-in") { Task { await checkLogin() } }
                        Button("Cancel sign-in") { Task { _ = try? await store.api?.admin.cancelCodexLogin()
                            self.login = nil
                        } }
                    }
                }
            }
            Section("Use a provider key") {
                Text(
                    "Choose the provider whose API key you have, then a chat model listed in that provider’s dashboard. Your ChatGPT subscription and provider API billing can be separate. You can change the model later."
                )
                .font(.callout).foregroundStyle(DesktopTheme.secondary)
                Picker("Provider", selection: $provider) {
                    Text("Choose a provider").tag("")
                    ForEach((overview?.presets ?? []).filter { $0.defaultUrl != nil }, id: \.id) { preset in
                        Text(preset.name).tag(preset.id)
                    }
                }
                Text(
                    "Connecting allows models you select outside your library Mac to receive information for their work, including any other cloud models you have already selected."
                )
                .font(.callout).foregroundStyle(DesktopTheme.secondary)
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
            if let error { Text(error).foregroundStyle(DesktopTheme.danger) }
            if loading { ProgressView("Updating AI settings…") }
        }.formStyle(.grouped).omnesisTheme()
            .task(id: store.api.map { ObjectIdentifier($0) }) { if loadModels { await refreshModels() } }
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
            store.observeModelOverview(result.0)
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
