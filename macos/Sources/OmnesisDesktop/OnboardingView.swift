// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Omnesis
import SwiftUI

struct DesktopOnboardingView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.openSettings) private var openSettings
    @State private var showNewLibrary = false
    @State private var firstLibraryConfirmed = false
    @State private var accountIntent = DesktopAccountIntent.existing
    @State private var invitation = ""
    @State private var termsAccepted = false
    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        DesktopBrandMark(size: 48)
                        Text(store.state.statusLabel).font(.system(size: 32, weight: .semibold))
                        if store.backgroundStartupBlock == .ownerMismatch || store.backgroundStartupBlock == .originRequired {
                            VStack(alignment: .leading, spacing: 16) {
                                Text("Review app recovery").font(.title2.weight(.semibold))
                                Text(
                                    "Omnesis is finishing an app or library change. Review recovery before starting collection from this copy. Your existing library is kept."
                                )
                                .foregroundStyle(DesktopTheme.secondary)
                                Button("Review recovery") { store.settingsTab = "updates"
                                    openSettings()
                                }
                                .buttonStyle(DesktopButtonStyle(primary: true)).accessibilityIdentifier("background-review-recovery")
                                Button("Retry background connection") { store.start() }.buttonStyle(DesktopButtonStyle())
                            }
                        } else if store.startupRepairRequired {
                            DesktopStartupRepairView(flow: store.automaticStartup, retry: { store.start() })
                        } else {
                            switch store.state.phase {
                            case .welcome, .chooseHome:
                                Text(
                                    "Omnesis brings your information together in a private library. Sign in to find a library you already keep on another Mac, or start one here."
                                )
                                .foregroundStyle(DesktopTheme.secondary)
                                HStack(spacing: 12) {
                                    Button("Find my library") {
                                        accountIntent = .existing
                                        store.command("connect", params: accountIntent.parameters(invite: "", termsAccepted: false))
                                    }.buttonStyle(DesktopButtonStyle(primary: true))
                                        .accessibilityIdentifier("find-library")
                                    if store.state.phase == .welcome {
                                        Button("Create a new library") {
                                            accountIntent = .create
                                            showNewLibrary = true
                                        }.buttonStyle(DesktopButtonStyle()).accessibilityIdentifier("create-library")
                                    }
                                }
                                if store.state.phase == .chooseHome || showNewLibrary {
                                    GroupBox {
                                        VStack(alignment: .leading, spacing: 14) {
                                            Label("Keep your library on this Mac?", systemImage: "desktopcomputer").font(.headline)
                                            Text(
                                                "A desktop Mac you leave powered on, such as a Mac mini, is a good home for your library. This Mac must stay awake and start Omnesis when you sign in. Setup will guide and verify those required settings. Your other devices use this Mac to search and ask questions. Moving your library to another Mac is not available yet."
                                            )
                                            .fixedSize(horizontal: false, vertical: true)
                                            .accessibilityIdentifier("home-location-warning")
                                            DesktopMacServerTip(compact: true)
                                            if let free = availableStorage {
                                                Text("\(free) available on this Mac").font(.callout).foregroundStyle(DesktopTheme.secondary)
                                            }
                                            if showNewLibrary {
                                                Text(
                                                    "Already have an Omnesis library? Choose Find my library above to connect to it instead."
                                                )
                                                .font(.callout).foregroundStyle(DesktopTheme.secondary)
                                                Toggle("This is my first Omnesis library", isOn: $firstLibraryConfirmed)
                                                    .accessibilityIdentifier("confirm-first-library")
                                            }
                                            Button("Use this Mac") {
                                                store.command(
                                                    "prepare",
                                                    params: [
                                                        "mode": .string("home"),
                                                        "name": .string(Host.current().localizedName ?? "My Mac"),
                                                    ]
                                                )
                                            }.buttonStyle(DesktopButtonStyle(primary: true)).controlSize(.large)
                                                .disabled(showNewLibrary && !firstLibraryConfirmed)
                                                .accessibilityIdentifier("use-this-mac")
                                            Button("I’ll set up another Mac first") { store.command(
                                                "prepare",
                                                params: ["mode": .string("joined")]
                                            )
                                            }
                                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }
                            case .accountRequired:
                                Text(
                                    "An Omnesis account connects your devices securely, at home and away. Your private library stays on your Mac."
                                )
                                Picker("Omnesis account", selection: $accountIntent) {
                                    Text("I have an account").tag(DesktopAccountIntent.existing)
                                    Text("Create an account").tag(DesktopAccountIntent.create)
                                }.pickerStyle(.segmented)
                                if accountIntent == .create, store.state.signup?.policy != "open" {
                                    TextField("Invitation code (if required)", text: $invitation)
                                        .textFieldStyle(.roundedBorder)
                                        .accessibilityIdentifier("invitation-code")
                                    Text("New accounts may need an invitation. You can paste either the invitation link or its code.")
                                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                                }
                                Text(
                                    "A certificate authority issues the certificate for your private address, so your devices can verify this Mac when they connect."
                                )
                                .font(.callout).foregroundStyle(DesktopTheme.secondary)
                                Toggle("I accept the certificate authority’s terms for my secure address", isOn: $termsAccepted)
                                    .disabled(store.state.signup?.readableTermsURL == nil)
                                    .accessibilityIdentifier("account-terms")
                                HStack {
                                    if let terms = store.state.signup?.readableTermsURL {
                                        Link("Certificate authority terms", destination: terms)
                                    }
                                    Link("Privacy policy", destination: URL(string: "https://omnesis.dev/privacy")!)
                                }.font(.callout)
                                if store.state.signup?.readableTermsURL == nil {
                                    VStack(alignment: .leading, spacing: 10) {
                                        Label("Read the terms before continuing", systemImage: "exclamationmark.triangle")
                                            .font(.headline).foregroundStyle(.orange)
                                        Text(
                                            "The certificate authority’s terms could not be loaded. Check your internet connection and try again. Sign-in stays paused until you can read them."
                                        )
                                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                                        Button("Load terms again") { store.command("status") }
                                    }.padding(14).background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                                }
                                Button(accountIntent == .create ? "Create my Omnesis account" : "Sign in to my Omnesis account") {
                                    store.command(
                                        "connect",
                                        params: accountIntent.parameters(invite: invitation, termsAccepted: termsAccepted)
                                    )
                                }.buttonStyle(DesktopButtonStyle(primary: true))
                                    .disabled(!termsAccepted || store.state.signup?.readableTermsURL == nil)
                                    .accessibilityIdentifier("connect-account")
                                Text("Complete sign-in in your browser, then return to Omnesis. Your connection is encrypted end to end.")
                                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                            case .preparing:
                                if let model = store.state.searchModel, let downloaded = model.downloadedBytes,
                                   let total = model.totalBytes,
                                   total > 0 {
                                    ProgressView(value: Double(min(downloaded, total)), total: Double(total))
                                    Text(
                                        "Downloaded \(ByteCountFormatter.string(fromByteCount: downloaded, countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))"
                                    )
                                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                                } else { ProgressView().controlSize(.large) }
                                Text(
                                    "Omnesis is protecting your library and preparing local search. This may take a few minutes. You can keep this window open to follow its progress."
                                )
                            case .waiting:
                                if store.state.retired == true {
                                    ContentUnavailableView(
                                        "Omnesis is stopped on this Mac",
                                        systemImage: "app.badge.checkmark",
                                        description: Text(store.state
                                            .message ?? "Your removal choice is kept. Omnesis will not start in the background.")
                                    )
                                    Button("Review removal") {
                                        store.removalPlan = nil
                                        store.removalOutcome = nil
                                        store.presentRemoval = true
                                    }
                                    if store.state.retirement?.mode == "keep-data", store.state.retirement?.phase == "complete" {
                                        Button("Set up Omnesis again") { store.command("connect") }
                                            .buttonStyle(DesktopButtonStyle(primary: true))
                                    }
                                } else if store.state.waitingForLocalLibrary {
                                    ProgressView("Starting your library on this Mac…")
                                    Text(
                                        "Keep Omnesis open while your library starts. If it does not connect, check again or reopen the app. Your saved library stays on this Mac."
                                    )
                                    .foregroundStyle(DesktopTheme.secondary)
                                    Button("Check this Mac’s library") { store.command("connect") }
                                        .buttonStyle(DesktopButtonStyle(primary: true))
                                } else {
                                    ContentUnavailableView(
                                        "Your library is not connected yet",
                                        systemImage: "laptopcomputer",
                                        description: Text(
                                            "Open Omnesis on the Mac that keeps your library. If it has not been set up yet, start there first."
                                        )
                                    )
                                    Button("Look again") { store.command("connect") }.buttonStyle(DesktopButtonStyle(primary: true))
                                    if store.state.canChangeUnpreparedChoice {
                                        Button("Change setup choice") { store.command("status") }
                                    }
                                }
                            case .ready:
                                ProgressView("Verifying your protected library…")
                            case .error:
                                Text("Your information is kept safe. Try reconnecting, or reopen the app if the problem continues.")
                                if store.state.searchModel?.state == "needs-download" {
                                    Button("Retry search model download") { store.command("prepare", params: ["mode": .string("home")]) }
                                        .buttonStyle(DesktopButtonStyle(primary: true))
                                } else {
                                    Button("Try again") { store.command("status") }.buttonStyle(DesktopButtonStyle(primary: true))
                                }
                            }
                        }
                        if let message = store.state
                            .message { Text(message).foregroundStyle(DesktopTheme.secondary).textSelection(.enabled) }
                        if store.busy, store.state.phase != .preparing {
                            ProgressView(store.launchingRuntime ? "Preparing the Omnesis app…" : "Working…")
                        }
                    }.frame(maxWidth: 600, alignment: .leading).padding(48).frame(maxWidth: .infinity)
                        .frame(minHeight: geometry.size.height)
                }.disabled(store.busy || store.startupCancelled)
            }
            if store.launchingRuntime {
                Button(store.cancellingStartup ? "Cancelling preparation…" : "Cancel preparation") {
                    Task { await store.cancelStartup() }
                }.disabled(store.cancellingStartup).padding(.bottom, 24)
            }
        }.onChange(of: store.state.signup?.readableTermsURL) { termsAccepted = false }
            .omnesisTheme()
    }

    private var availableStorage: String? {
        guard let values = try? FileManager.default.homeDirectoryForCurrentUser
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
            let bytes = values.volumeAvailableCapacityForImportantUsage else { return nil }
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

struct RuntimeInteractionView: View {
    @Environment(DesktopStore.self) private var store
    let interaction: RuntimeInteraction
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(title).font(.title2.bold())
            if let message = interaction.message { Text(message) }
            if let code = interaction
                .code { Text(code).font(.largeTitle.monospaced()).textSelection(.enabled).accessibilityIdentifier("comparison-code") }
            if let url = interaction.url {
                Text("Continue securely in your browser, then return to Omnesis.").foregroundStyle(DesktopTheme.secondary)
                Button("Open sign-in page") { store.openBrowser(url) }.buttonStyle(DesktopButtonStyle(primary: true))
            }
            ForEach(interaction.choices ?? []) { choice in
                Button(choice.name) { store.respond(choice.id) }.buttonStyle(.bordered)
            }
            if interaction.kind == "compareCode" {
                Text("Only approve if the same code is shown on your other device.")
                Button("The codes match") { store.respond("approve") }.buttonStyle(DesktopButtonStyle(primary: true))
            }
            HStack {
                Button("Cancel") { store.command("cancel")
                    store.interaction = nil
                }.keyboardShortcut(.cancelAction)
                Spacer()
                if interaction.kind == "openBrowser" || interaction.kind == "connectCode" {
                    Button("I’ve finished in the browser") { store.respond("continue") }
                }
            }
        }.padding(30).frame(width: 480)
    }

    private var title: String {
        switch interaction.kind {
        case "chooseGateway": "Choose your library"
        case "compareCode": "Confirm this is your device"
        default: "Connect your Omnesis account"
        }
    }
}

struct DesktopSetupChecklist: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.openSettings) private var openSettings
    @State private var health = DesktopSourceHealthMonitor()
    @State private var model: ModelDisplay?
    var presentSettings: (() -> Void)?
    var loadStatus = true
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Set up Omnesis").font(.system(size: 30, weight: .bold))
                    Text("Complete the required checks, then choose the information you want to find. Optional connections can wait.")
                        .foregroundStyle(DesktopTheme.secondary)
                }
                if !store.requiredSetupReady {
                    HStack(spacing: 12) {
                        Image(systemName: store.state.canOpenLibrary ? "checkmark.shield.fill" : "clock")
                            .foregroundStyle(DesktopTheme.teal)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(store.state.canOpenLibrary ? "Your library is connected" : "Checking your library").font(.headline)
                            Text(store.state.encrypted == true
                                ?
                                (store.state
                                    .mode == "joined" ? "This Mac and your library use encrypted storage" : "Encrypted storage on this Mac")
                                : "Checking your library’s protection")
                                .font(.callout).foregroundStyle(DesktopTheme.secondary)
                        }
                    }
                }
                DesktopSetupReadinessView()
                GroupBox {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Your information").font(.title3.weight(.semibold))
                        Text(sourceSummary).foregroundStyle(DesktopTheme.secondary)
                        Button(store.sources.isEmpty ? "Add your first source" : "Review your sources") { store.destination = .sources }
                            .buttonStyle(DesktopButtonStyle(primary: !store.requiredSetupNeedsAction))
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Access on this Mac", systemImage: "lock.shield").font(.title3.weight(.semibold))
                        Text(
                            "Choose the information this Mac may collect. Omnesis checks only the access needed for those sources; search and answers from another Mac do not require broad local permissions."
                        )
                        .foregroundStyle(DesktopTheme.secondary)
                        Button("Review collection access") { store.accessFocus = nil
                            store.presentAccess = true
                        }
                        .buttonStyle(DesktopButtonStyle()).accessibilityIdentifier("setup-collection-access")
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                VStack(alignment: .leading, spacing: 20) {
                    Text("More ways to use your library").font(.title3.weight(.semibold))
                    optionalStep("Answers in this app", detail: modelSummary, symbol: "sparkles", action: "Set up answers") {
                        store.settingsTab = "ai"
                        if let presentSettings { presentSettings() } else { openSettings() }
                    }
                    Divider()
                    optionalStep("Your phone", detail: phoneSummary, symbol: "iphone", action: "Connect a phone") {
                        store.destination = .devices
                    }
                    Divider()
                    optionalStep(
                        "Omnesis in ChatGPT",
                        detail: "Let ChatGPT or another assistant search the sources you choose.",
                        symbol: "link",
                        action: "Connect an assistant"
                    ) { store.destination = .assistants }
                }
            }.padding(32).frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity)
        }.navigationTitle("Setup").omnesisTheme()
            .task(id: DesktopModelObservation(api: store.api.map(ObjectIdentifier.init), revision: store.modelConfigurationRevision)) {
                guard loadStatus, let api = store.api else { return }
                async let modelCheck: Void = checkModel(api)
                await health.observe(api: api)
                await modelCheck
            }
    }

    private var sourceSummary: String {
        guard !store.sources.isEmpty else { return "Connect an account or a folder. Your originals stay where they are." }
        guard health.failure == nil else { return "Collection status could not be refreshed. Open Sources to check your connection." }
        guard health.loaded else { return "Checking collection status…" }
        let active = store.sources.filter { $0.enabled && !DesktopSourceActionPolicy(source: $0, devices: store.devices).historical }
        guard !active.isEmpty else { return "Your saved sources are paused or no longer collecting. Open Sources to review them." }
        let statuses = active.compactMap { health.statuses[$0.id] }
        let reports = statuses.flatMap { report in
            if let members = report.members, !members.isEmpty { return members }
            return [report]
        }
        if reports.contains(where: \.needsAttention) { return "Some sources need your attention. Open Sources to see what to do next." }
        if reports
            .contains(where: { $0.state == "syncing" }) { return "Your information is being collected. You can follow progress in Sources."
        }
        let complete = statuses.filter { status in
            let members = status.members.flatMap { $0.isEmpty ? nil : $0 } ?? [status]
            return members.allSatisfy { $0.state == "synced" || $0.state == "completed" }
        }.count
        if complete == active.count { return "Your enabled sources finished their last collection. Open Sources to review them." }
        if complete >
            0 { return "\(complete) of \(active.count) enabled sources finished their last collection. Check Sources for the others." }
        if !reports.isEmpty,
           reports.allSatisfy({ $0.state == "idle" }) { return "Waiting for the first collection. Open Sources to check progress." }
        return "Open Sources to check collection progress for your enabled sources."
    }

    private var modelSummary: String {
        guard let model else { return "Choose an AI provider for questions and answers. Search works without one." }
        if model.configured, model.available { return "Ready · \(model.providerLabel) · \(model.modelName)" }
        if model.configured { return "Your selected model needs attention. Review its connection in Settings." }
        return "No model is in use. Choose a provider when you want to ask questions."
    }

    private var phoneSummary: String {
        let phones = store.devices.filter { ($0.revokedAt == nil || $0.needsPairing == true) && ["ios", "android"].contains($0.kind) }
        if phones
            .contains(where: { $0.needsPairing == true }) {
            return "A phone needs pairing again. Open Devices to repair its existing connection."
        }
        if phones.contains(where: { $0.online == true }) { return "A phone is connected to your library." }
        if !phones.isEmpty { return "A phone is paired. It is not connected right now." }
        return "Take your library with you and connect information from your phone."
    }

    private func checkModel(_ api: DesktopAPI) async {
        model = nil
        do {
            let observed: ModelDisplay = try await api.request("GET", "agent/model")
            guard !Task.isCancelled, store.api === api else { return }
            model = observed
        } catch { if !Task.isCancelled { model = nil } }
    }

    private func optionalStep(_ title: String, detail: String, symbol: String, action: String, perform: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: symbol).font(.system(size: 20)).foregroundStyle(DesktopTheme.accent).frame(width: 28)
            VStack(alignment: .leading, spacing: 7) {
                HStack { Text(title).font(.headline)
                    Text("Optional").font(.caption).foregroundStyle(DesktopTheme.secondary)
                }
                Text(detail).font(.callout).foregroundStyle(DesktopTheme.secondary)
                Button(action, action: perform).accessibilityIdentifier(title == "Answers in this app" ? "setup-models" : "setup-" + symbol)
            }
            Spacer(minLength: 0)
        }
    }
}
