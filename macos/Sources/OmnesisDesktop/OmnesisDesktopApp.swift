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
                        DesktopActionRouter.shared.enqueue(question: nil)
                        openWindow(id: "main", value: DesktopWindowIdentity.main)
                    }.keyboardShortcut("n")
                }
            }
        Settings { DesktopSettingsView().environment(store).id(store.apiContextEpoch).frame(width: 720, height: 640) }
    }
}

struct DesktopRootView: View {
    @Environment(DesktopStore.self) private var store
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
        Group {
            if store.state.canOpenLibrary { libraryNavigation }
            else {
                VStack(spacing: 0) {
                    prerequisiteBanners
                    failureBanner
                    DesktopOnboardingView()
                }
            }
        }
        .omnesisSheet(isPresented: $store.presentAccess, onDismiss: { store.accessFocus = nil }) { DesktopAccessCoach().environment(store) }
        .omnesisSheet(isPresented: $store.presentRecovery) { DesktopRecoveryView().environment(store) }
        .omnesisSheet(isPresented: $store.presentRemoval) { DesktopRemovalView().environment(store) }
        .omnesisSheet(item: $store.interaction) { interaction in
            RuntimeInteractionView(interaction: interaction).environment(store)
        }
        .onChange(of: DesktopActionRouter.shared.pending?.id, initial: true) {
            if DesktopActionRouter.shared.pending != nil { store.destination = .ask }
        }
        .onChange(of: store.requiredSetupReady) { if store.requiredSetupReady { hadVerifiedSetup = true } }
        .omnesisTheme().omnesisWindowChrome()
    }

    private var prerequisiteBanners: some View {
        VStack(spacing: 0) {
            if store.state.canOpenLibrary, !store.requiredSetupReady, store.requiredSetupNeedsAction || !hadVerifiedSetup {
                HStack(alignment: .center, spacing: DesktopDesignTokens.Space.medium) {
                    Label(DesktopSetupRepair.bannerTitle(in: store), systemImage: "checklist")
                        .font(DesktopDesignTokens.Typography.secondary.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("required-setup-label")
                    Spacer(minLength: DesktopDesignTokens.Space.small)
                    Button("Review setup") { store.destination = .setup }.buttonStyle(DesktopButtonStyle())
                        .accessibilityIdentifier("required-setup-review")
                }.padding(.horizontal, DesktopDesignTokens.Layout.pageMargin).padding(.vertical, DesktopDesignTokens.Space.small)
                    .background(DesktopTheme.surface)
                    .accessibilityElement(children: .contain).accessibilityIdentifier("required-setup-banner")
            }
            if let issue = accessIssues.first {
                HStack(alignment: .top, spacing: DesktopDesignTokens.Space.medium) {
                    Image(systemName: "lock.trianglebadge.exclamationmark").foregroundStyle(DesktopTheme.warning)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(issue.account) needs attention on \(issue.computer)")
                            .font(DesktopDesignTokens.Typography.secondary.weight(.medium))
                        Text(accessHealth
                            .failure == nil ?
                            "Your indexed information is kept. Review the affected source and computer before collecting again." :
                            "The last collection reported an access problem. Its current status could not be refreshed.")
                            .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                    }
                    Spacer()
                    Button(issue.target == nil ? "Review sources" : "Review access") {
                        if let target = issue.target { store.accessFocus = target
                            store.presentAccess = true
                        } else { store.destination = .sources }
                    }.buttonStyle(DesktopButtonStyle())
                }.padding(.horizontal, DesktopDesignTokens.Layout.pageMargin).padding(.vertical, DesktopDesignTokens.Space.medium)
                    .background(DesktopTheme.surface)
            }
        }
    }

    private var libraryNavigation: some View {
        @Bindable var store = store
        return NavigationSplitView(columnVisibility: $columns) {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                HStack(spacing: DesktopDesignTokens.Space.small) {
                    DesktopBrandMark(size: 24)
                    Text("Omnesis").font(DesktopDesignTokens.Typography.body.weight(.semibold))
                        .accessibilityIdentifier("library-brand-title")
                    Spacer()
                }.padding(.horizontal, DesktopDesignTokens.Space.medium).padding(.top, DesktopDesignTokens.Space.regular)
                List(selection: $store.destination) {
                    ForEach(DesktopStore.Destination.allCases) { item in
                        Label(item.rawValue, systemImage: item.symbol)
                            .font(DesktopDesignTokens.Typography.navigation)
                            .foregroundStyle(store.destination == item ? DesktopTheme.ink : DesktopTheme.secondary)
                            .frame(minHeight: 34).tag(item)
                            .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
                            .listRowSeparator(.hidden)
                            .listRowBackground(RoundedRectangle(cornerRadius: DesktopDesignTokens.Radius.medium)
                                .fill(store.destination == item ? DesktopTheme.selected : .clear))
                    }
                }.listStyle(.sidebar).scrollContentBackground(.hidden)
                Label(store.state.statusLabel, systemImage: "checkmark.shield")
                    .font(DesktopDesignTokens.Typography.caption).foregroundStyle(DesktopTheme.secondary)
                    .padding(.horizontal, DesktopDesignTokens.Space.medium).padding(.bottom, DesktopDesignTokens.Space.medium)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: .infinity)
                .navigationSplitViewColumnWidth(min: 180, ideal: 216, max: 276)
                .background(DesktopTheme.sidebar)
        } detail: {
            VStack(spacing: 0) {
                prerequisiteBanners
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
                Image(systemName: "exclamationmark.triangle").foregroundStyle(DesktopTheme.danger).accessibilityHidden(true)
                Text(failure).textSelection(.enabled).accessibilityIdentifier("runtime-error")
                Spacer()
                Button("Retry") { store.start() }
            }.font(DesktopDesignTokens.Typography.secondary)
                .padding(.horizontal, DesktopDesignTokens.Layout.pageMargin).padding(.vertical, DesktopDesignTokens.Space.medium)
                .background(DesktopTheme.surface)
        }
    }
}

#Preview("Welcome") { DesktopRootView().environment(DesktopStore.preview()).frame(width: 1080, height: 740) }
#Preview("Waiting") { DesktopRootView().environment(DesktopStore.preview(phase: .waiting)).frame(width: 1080, height: 740) }
#Preview("Preparing") { DesktopRootView().environment(DesktopStore.preview(phase: .preparing)).frame(width: 1080, height: 740) }
