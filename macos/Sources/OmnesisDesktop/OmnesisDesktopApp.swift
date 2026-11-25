// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import SwiftUI

@main
struct OmnesisDesktopApp: App {
    @NSApplicationDelegateAdaptor(DesktopApplicationDelegate.self) private var applicationDelegate
    @State private var store = DesktopStore()
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        WindowGroup("Omnesis", id: "main") {
            DesktopRootView().environment(store).frame(minWidth: 860, minHeight: 600)
                .onAppear { applicationDelegate.store = store }
        }
        .defaultSize(width: 1080, height: 740)
        .commands {
            CommandGroup(after: .appSettings) {
                Button("Remove Omnesis from This Mac…") {
                    store.removalPlan = nil
                    store.removalOutcome = nil
                    store.presentRemoval = true
                    openWindow(id: "main")
                    NSApp.activate(ignoringOtherApps: true)
                }.disabled(store.busy)
            }
            CommandGroup(replacing: .newItem) {
                Button("New Conversation") {
                    store.destination = .ask
                    DesktopActionRouter.shared.newConversation = UUID()
                    openWindow(id: "main")
                }.keyboardShortcut("n")
            }
        }
        Settings { DesktopSettingsView().environment(store).frame(width: 720, height: 640) }
        MenuBarExtra("Omnesis", image: "OmnesisMark") {
            VStack(alignment: .leading, spacing: 14) {
                Label(store.state.statusLabel, systemImage: store.state.canOpenLibrary ? "checkmark.shield" : "clock")
                    .font(.headline)
                if let message = store.state.message { Text(message).font(.caption).foregroundStyle(.secondary) }
                Divider()
                menuButton("Ask Omnesis", destination: .ask)
                menuButton("Search", destination: .search)
                menuButton("Sources", destination: .sources)
                Button("Open Omnesis") { openWindow(id: "main")
                    NSApp.activate(ignoringOtherApps: true)
                }
                SettingsLink { Text("Settings…") }
                Divider()
                Button("Quit Omnesis") { NSApp.terminate(nil) }
            }.padding(18).frame(width: 300, alignment: .leading)
        }.menuBarExtraStyle(.window)
    }

    private func menuButton(_ label: String, destination: DesktopStore.Destination) -> some View {
        Button(label) {
            store.destination = destination
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }.disabled(!store.state.canOpenLibrary)
    }
}

struct DesktopRootView: View {
    @Environment(DesktopStore.self) private var store
    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            List(selection: $store.destination) {
                ForEach(DesktopStore.Destination.allCases) { item in
                    Label(item.rawValue, systemImage: item.symbol).tag(item)
                        .disabled(!store.state.canOpenLibrary && item != .setup)
                }
            }.navigationTitle("Omnesis")
                .safeAreaInset(edge: .bottom) {
                    Label(store.state.statusLabel, systemImage: store.state.canOpenLibrary ? "checkmark.shield" : "clock")
                        .font(.caption).foregroundStyle(.secondary).padding()
                }
        } detail: {
            VStack(spacing: 0) {
                if let failure = store.failure {
                    HStack {
                        Image(systemName: "exclamationmark.triangle")
                        Text(failure).textSelection(.enabled)
                        Spacer()
                        Button("Retry") { store.start() }
                    }.padding().background(.orange.opacity(0.12)).accessibilityIdentifier("runtime-error")
                }
                if store.state.canOpenLibrary {
                    switch store.destination ?? .ask {
                    case .ask: DesktopAskView()
                    case .search: DesktopSearchView()
                    case .sources: DesktopSourcesView()
                    case .devices: DesktopDevicesView()
                    case .assistants: DesktopAssistantsView()
                    case .setup: DesktopSetupChecklist()
                    }
                } else {
                    DesktopOnboardingView()
                }
            }
        }
        .sheet(isPresented: $store.presentRecovery) { DesktopRecoveryView().environment(store) }
        .sheet(isPresented: $store.presentRemoval) { DesktopRemovalView().environment(store) }
        .sheet(item: $store.interaction) { interaction in
            RuntimeInteractionView(interaction: interaction).environment(store)
        }
        .onChange(of: DesktopActionRouter.shared.newConversation) {
            store.destination = .ask
        }
    }
}

#Preview("Welcome") { DesktopRootView().environment(DesktopStore.preview()).frame(width: 1080, height: 740) }
#Preview("Waiting") { DesktopRootView().environment(DesktopStore.preview(phase: .waiting)).frame(width: 1080, height: 740) }
#Preview("Preparing") { DesktopRootView().environment(DesktopStore.preview(phase: .preparing)).frame(width: 1080, height: 740) }
