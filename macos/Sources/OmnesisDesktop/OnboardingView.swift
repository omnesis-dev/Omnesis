// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import SwiftUI

struct DesktopOnboardingView: View {
    @Environment(DesktopStore.self) private var store
    @State private var showNewLibrary = false
    @State private var firstLibraryConfirmed = false
    @State private var accountIntent = DesktopAccountIntent.existing
    @State private var invitation = ""
    @State private var termsAccepted = false
    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Image(systemName: "circle.hexagongrid.fill").font(.system(size: 48)).foregroundStyle(.tint)
                    Text(store.state.statusLabel).font(.largeTitle.bold())
                    switch store.state.phase {
                    case .welcome, .chooseHome:
                        Text(
                            "Omnesis brings your information together in a private library. Sign in to find a library you already keep on another Mac, or start one here."
                        )
                        .foregroundStyle(.secondary)
                        Button("Find my library") {
                            accountIntent = .existing
                            store.command("connect", params: accountIntent.parameters(invite: "", termsAccepted: false))
                        }.buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("find-library")
                        if store.state.phase == .welcome {
                            Button("Create a new library") {
                                accountIntent = .create
                                showNewLibrary = true
                            }.accessibilityIdentifier("create-library")
                        }
                        if store.state.phase == .chooseHome || showNewLibrary {
                            GroupBox {
                                VStack(alignment: .leading, spacing: 14) {
                                    Label("Keep your library on this Mac?", systemImage: "desktopcomputer").font(.headline)
                                    Text(
                                        "Choose the Mac you leave at home and keep awake. Your other devices use this Mac to search and ask questions. Moving your library to another Mac is not available yet."
                                    )
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("home-location-warning")
                                    if let free = availableStorage {
                                        Text("\(free) available on this Mac").font(.callout).foregroundStyle(.secondary)
                                    }
                                    if showNewLibrary {
                                        Text("Already have an Omnesis library? Choose Find my library above to connect to it instead.")
                                            .font(.callout).foregroundStyle(.secondary)
                                        Toggle("This is my first Omnesis library", isOn: $firstLibraryConfirmed)
                                            .accessibilityIdentifier("confirm-first-library")
                                    }
                                    Button("Use this Mac") {
                                        store.command(
                                            "prepare",
                                            params: ["mode": .string("home"), "name": .string(Host.current().localizedName ?? "My Mac")]
                                        )
                                    }.disabled(showNewLibrary && !firstLibraryConfirmed)
                                        .accessibilityIdentifier("use-this-mac")
                                    Button("I’ll set up another Mac first") { store.command("prepare", params: ["mode": .string("joined")])
                                    }
                                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    case .accountRequired:
                        Text("An Omnesis account connects your devices securely, at home and away. Your private library stays on your Mac.")
                        Picker("Omnesis account", selection: $accountIntent) {
                            Text("I have an account").tag(DesktopAccountIntent.existing)
                            Text("Create an account").tag(DesktopAccountIntent.create)
                        }.pickerStyle(.segmented)
                        if accountIntent == .create, store.state.signup?.policy != "open" {
                            TextField("Invitation code (if required)", text: $invitation)
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("invitation-code")
                            Text("New accounts may need an invitation. You can paste either the invitation link or its code.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        Toggle("Allow Omnesis to create my secure address under the certificate authority’s terms", isOn: $termsAccepted)
                            .accessibilityIdentifier("account-terms")
                        HStack {
                            if let terms = store.state.signup?.acmeTermsUrl, terms.scheme == "https" {
                                Link("Certificate authority terms", destination: terms)
                            }
                            Link("Privacy policy", destination: URL(string: "https://omnesis.dev/privacy")!)
                        }.font(.callout)
                        Button(accountIntent == .create ? "Create my Omnesis account" : "Sign in to my Omnesis account") {
                            store.command("connect", params: accountIntent.parameters(invite: invitation, termsAccepted: termsAccepted))
                        }.buttonStyle(.borderedProminent).disabled(!termsAccepted)
                            .accessibilityIdentifier("connect-account")
                        Text("Complete sign-in in your browser, then return to Omnesis. Your connection is encrypted end to end.")
                            .font(.callout).foregroundStyle(.secondary)
                    case .preparing:
                        if let model = store.state.searchModel, let downloaded = model.downloadedBytes, let total = model.totalBytes,
                           total > 0 {
                            ProgressView(value: Double(min(downloaded, total)), total: Double(total))
                            Text(
                                "Downloaded \(ByteCountFormatter.string(fromByteCount: downloaded, countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))"
                            )
                            .font(.callout).foregroundStyle(.secondary)
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
                                Button("Set up Omnesis again") { store.command("connect") }.buttonStyle(.borderedProminent)
                            }
                        } else {
                            ContentUnavailableView(
                                "Your library is not connected yet",
                                systemImage: "laptopcomputer",
                                description: Text(
                                    "Open Omnesis on the Mac that keeps your library. If it has not been set up yet, start there first."
                                )
                            )
                            Button("Look again") { store.command("connect") }.buttonStyle(.borderedProminent)
                        }
                    case .ready:
                        ProgressView("Verifying your protected library…")
                    case .error:
                        Text("Your information is kept safe. Try reconnecting, or reopen the app if the problem continues.")
                        if store.state.searchModel?.state == "needs-download" {
                            Button("Retry search model download") { store.command("prepare", params: ["mode": .string("home")]) }
                                .buttonStyle(.borderedProminent)
                        } else {
                            Button("Try again") { store.command("status") }.buttonStyle(.borderedProminent)
                        }
                    }
                    if let message = store.state.message { Text(message).foregroundStyle(.secondary).textSelection(.enabled) }
                    if store.busy, store.state.phase != .preparing {
                        ProgressView(store.launchingRuntime ? "Preparing the Omnesis app…" : "Working…")
                    }
                }.frame(maxWidth: 600, alignment: .leading).padding(48).frame(maxWidth: .infinity)
            }.disabled(store.busy || store.startupCancelled)
            if store.launchingRuntime {
                Button(store.cancellingStartup ? "Cancelling preparation…" : "Cancel preparation") {
                    Task { await store.cancelStartup() }
                }.disabled(store.cancellingStartup).padding(.bottom, 24)
            }
        }
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
                Text("Continue securely in your browser, then return to Omnesis.").foregroundStyle(.secondary)
                Button("Open sign-in page") { store.openBrowser(url) }.buttonStyle(.borderedProminent)
            }
            ForEach(interaction.choices ?? []) { choice in
                Button(choice.name) { store.respond(choice.id) }.buttonStyle(.bordered)
            }
            if interaction.kind == "compareCode" {
                Text("Only approve if the same code is shown on your other device.")
                Button("The codes match") { store.respond("approve") }.buttonStyle(.borderedProminent)
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
    var body: some View {
        Form {
            Section("Your Omnesis setup") {
                Label("Your library is connected", systemImage: "checkmark.circle.fill")
                Label(
                    store.state
                        .encrypted == true ?
                        (store.state
                            .mode == "joined" ? "This Mac and your library are encrypted" : "Your library on this Mac is encrypted") :
                        "Checking your library’s encryption",
                    systemImage: "lock.shield"
                )
                Button(store.sources.isEmpty ? "Add your first source" : "Manage your sources") { store.destination = .sources }
                Label("\(store.sources.filter(\.enabled).count) sources enabled", systemImage: "square.stack.3d.up")
                Button("Connect your phone") { store.destination = .devices }
                Button("Choose how you ask Omnesis") { store.openPortal() }
                Button("Connect ChatGPT or another assistant") { store.destination = .assistants }
            }
            Section {
                Text("You can return to these steps any time. Adding a model, a phone, or an external assistant is optional.")
                    .foregroundStyle(.secondary)
            }
        }.formStyle(.grouped).navigationTitle("Setup")
    }
}
