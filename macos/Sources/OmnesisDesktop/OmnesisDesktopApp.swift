// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import SwiftUI

enum DesktopWindowIdentity: String, Codable, Hashable {
    case main
}

@main
struct OmnesisDesktopApp: App {
    @NSApplicationDelegateAdaptor(DesktopApplicationDelegate.self) private var applicationDelegate
    @State private var store = DesktopStore()
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some Scene {
        let mainAction = openWindow
        let settingsAction = openSettings
        let _ = applicationDelegate.configure(store: store, actions: DesktopStatusMenu.Actions(
            openMain: { mainAction(id: "main", value: DesktopWindowIdentity.main)
                NSApp.activate()
            },
            openSettings: { settingsAction() },
            quit: { NSApp.terminate(nil) }
        ))
        WindowGroup("Omnesis", id: "main", for: DesktopWindowIdentity.self) { _ in
            DesktopRootView().environment(store).id(store.apiContextEpoch).frame(minWidth: 860, minHeight: 600)
        } defaultValue: { .main }
            .defaultSize(width: 1080, height: 740)
            .commands {
                CommandGroup(after: .appSettings) {
                    Button("Remove Omnesis from This Mac…") {
                        store.removalPlan = nil
                        store.removalOutcome = nil
                        store.presentRemoval = true
                        openWindow(id: "main", value: DesktopWindowIdentity.main)
                        NSApp.activate(ignoringOtherApps: true)
                    }.disabled(store.busy)
                }
                CommandGroup(replacing: .newItem) {
                    Button("New Conversation") {
                        store.destination = .ask
                        DesktopActionRouter.shared.newConversation = UUID()
                        openWindow(id: "main", value: DesktopWindowIdentity.main)
                    }.keyboardShortcut("n")
                }
            }
        Settings { DesktopSettingsView().environment(store).id(store.apiContextEpoch).frame(width: 720, height: 640) }
    }
}

struct DesktopRootView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.desktopContrast) private var contrast
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var hadVerifiedSetup = false
    private var accessHealth: DesktopSourceHealthMonitor {
        store.collectionHealth
    }

    private var accessIssues: [DesktopCollectionAccessIssue] {
        DesktopCollectionAccessIssue.resolve(sources: store.sources, devices: store.devices, statuses: accessHealth.statuses)
    }

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            prerequisiteBanners
            Group {
                if store.state.canOpenLibrary { libraryNavigation }
                else {
                    VStack(spacing: 0) {
                        failureBanner
                        DesktopOnboardingView()
                    }
                }
            }
        }
        .omnesisSheet(isPresented: $store.presentAccess, onDismiss: { store.accessFocus = nil }) { DesktopAccessCoach().environment(store) }
        .omnesisSheet(isPresented: $store.presentRecovery) { DesktopRecoveryView().environment(store) }
        .omnesisSheet(isPresented: $store.presentRemoval) { DesktopRemovalView().environment(store) }
        .omnesisSheet(item: $store.interaction) { interaction in
            RuntimeInteractionView(interaction: interaction).environment(store)
        }
        .onChange(of: DesktopActionRouter.shared.newConversation) {
            store.destination = .ask
        }
        .onChange(of: store.requiredSetupReady) { if store.requiredSetupReady { hadVerifiedSetup = true } }
        .omnesisTheme().omnesisWindowChrome()
    }

    private var prerequisiteBanners: some View {
        VStack(spacing: 0) {
            if store.state.canOpenLibrary, !store.requiredSetupReady, store.requiredSetupNeedsAction || !hadVerifiedSetup {
                HStack {
                    Label(
                        DesktopSetupRepair.bannerTitle(in: store),
                        systemImage: "checklist"
                    ).font(.callout.weight(.medium)).accessibilityIdentifier("required-setup-label")
                    Spacer()
                    Button("Review setup") { store.destination = .setup }.buttonStyle(DesktopButtonStyle())
                        .accessibilityIdentifier("required-setup-review")
                }.padding(.horizontal, 20).padding(.vertical, 10).background(DesktopTheme.panel)
                    .accessibilityElement(children: .contain).accessibilityIdentifier("required-setup-banner")
            }
            if let issue = accessIssues.first {
                HStack(spacing: 14) {
                    Image(systemName: "lock.trianglebadge.exclamationmark")
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(issue.account) needs attention on \(issue.computer)").font(.callout.weight(.semibold))
                        Text(accessHealth
                            .failure == nil ?
                            "Your indexed information is kept. Review the affected source and computer before collecting again." :
                            "The last collection reported an access problem. Its current status could not be refreshed.")
                            .font(.callout).foregroundStyle(DesktopTheme.secondary)
                    }
                    Spacer()
                    Button(issue.target == nil ? "Review sources" : "Review access") {
                        if let target = issue.target { store.accessFocus = target
                            store.presentAccess = true
                        } else { store.destination = .sources }
                    }.buttonStyle(DesktopButtonStyle())
                }.padding(16).background(DesktopTheme.raised)
            }
        }
    }

    private var libraryNavigation: some View {
        @Bindable var store = store
        return NavigationSplitView(columnVisibility: $columns) {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 12) {
                    DesktopBrandMark(size: 30)
                    Text("Omnesis").font(.system(size: 18, weight: .semibold)).accessibilityIdentifier("library-brand-title")
                    Spacer()
                }.padding(.horizontal, 20).padding(.top, 28)
                List(selection: $store.destination) {
                    ForEach(DesktopStore.Destination.allCases) { item in
                        Label(item.rawValue, systemImage: item.symbol)
                            .font(.system(size: 14, weight: .medium)).padding(.vertical, 5).tag(item)
                            .listRowSeparator(.hidden)
                            .listRowBackground(store.destination == item ? DesktopTheme.selected : Color.clear)
                            .overlay(alignment: .leading) {
                                if store.destination == item {
                                    Capsule().fill(DesktopTheme.primary).frame(
                                        width: contrast == .increased ? 4 : 3,
                                        height: contrast == .increased ? 22 : 16
                                    )
                                    .offset(x: -10)
                                }
                            }
                    }
                }.listStyle(.sidebar).scrollContentBackground(.hidden)
                Label(store.state.statusLabel, systemImage: "checkmark.shield")
                    .font(.caption.weight(.medium)).foregroundStyle(DesktopTheme.teal)
                    .padding(.horizontal, 20).padding(.bottom, 24).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: .infinity)
                .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 260)
                .background(DesktopTheme.sidebar)
        } detail: {
            VStack(spacing: 0) {
                failureBanner
                switch store.destination ?? .ask {
                case .ask: DesktopAskView()
                case .search: DesktopSearchView(context: store.apiContext).id(store.apiContextEpoch)
                case .sources: DesktopSourcesView(context: store.apiContext).id(store.apiContextEpoch)
                case .devices: DesktopDevicesView()
                case .assistants: DesktopAssistantsView(context: store.apiContext).id(store.apiContextEpoch)
                case .setup: DesktopSetupChecklist()
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(DesktopTheme.canvas)
        }.navigationSplitViewStyle(.balanced).navigationTitle("Omnesis")
    }

    @ViewBuilder
    private var failureBanner: some View {
        if let failure = store.failure {
            HStack {
                Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
                Text(failure).textSelection(.enabled).accessibilityIdentifier("runtime-error")
                Spacer()
                Button("Retry") { store.start() }
            }.padding().background(.orange.opacity(0.12))
        }
    }
}

#Preview("Welcome") { DesktopRootView().environment(DesktopStore.preview()).frame(width: 1080, height: 740) }
#Preview("Waiting") { DesktopRootView().environment(DesktopStore.preview(phase: .waiting)).frame(width: 1080, height: 740) }
#Preview("Preparing") { DesktopRootView().environment(DesktopStore.preview(phase: .preparing)).frame(width: 1080, height: 740) }
