// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

struct DesktopSetupReadinessView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.openSettings) private var openSettings
    @State private var showPowerSteps = false
    @State private var powerWasReady = false
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: store.requiredSetupReady ? 10 : 18) {
                Label(
                    store.requiredSetupReady ? "Required setup is complete on this Mac" : store
                        .requiredSetupNeedsAction ? "Finish setting up this Mac" : "Checking required settings",
                    systemImage: store.requiredSetupReady ? "checkmark.shield" : "checklist"
                )
                .font(.title3.weight(.semibold)).foregroundStyle(store.requiredSetupReady ? DesktopTheme.teal : DesktopTheme.ink)
                .accessibilityAddTraits(.isHeader)
                if store.state.canOpenLibrary, store.state.encrypted == true, store.installationIdentityReady {
                    ready("Library connected and protected")
                } else {
                    Text(
                        "This Mac’s setup has not been confirmed. Reconnect or reopen the installed app, then check again. Your library is kept."
                    )
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                    Button("Check this Mac’s connection") { store.command("status") }
                        .buttonStyle(DesktopButtonStyle(primary: DesktopSetupRepair.first(in: store) == .connection))
                }
                if let block = store.backgroundStartupBlock {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Background connection needs attention").font(.headline).accessibilityAddTraits(.isHeader)
                        Text(block == .ownerMismatch || block == .originRequired ?
                            "Review the app or library change before collection can resume. Information already opened in this app remains available." :
                            "Restore Omnesis’s background connection so collection can resume. Your indexed information is kept.")
                            .font(.callout).foregroundStyle(DesktopTheme.secondary)
                        if block == .ownerMismatch || block == .originRequired {
                            Button("Review recovery") { store.settingsTab = "updates"
                                openSettings()
                            }
                            .buttonStyle(DesktopButtonStyle(primary: DesktopSetupRepair.first(in: store) == .background))
                            .accessibilityIdentifier("background-review-recovery")
                        }
                        Button("Retry background connection") { store.start() }.buttonStyle(DesktopButtonStyle())
                            .accessibilityIdentifier("background-retry-connection")
                    }
                } else if !store.nativeOwnerReady {
                    checking("Checking Omnesis’s background connection…")
                }
                DesktopStartupPrerequisiteView()
                if store.state.mode == "home" {
                    if store.serverPower.ready || (powerWasReady && store.serverPower.status == .checking) {
                        HStack {
                            if store.serverPower.ready { ready("Automatic sleep is off while plugged in") }
                            else { checking("Checking automatic sleep settings…") }
                            Spacer()
                            Button("Show steps") { showPowerSteps = true }.buttonStyle(DesktopButtonStyle())
                                .accessibilityIdentifier("mac-server-steps")
                        }
                    } else { DesktopMacServerPrerequisite(
                        flow: store.serverPower,
                        primaryAction: DesktopSetupRepair.first(in: store) == .power
                    ) }
                    DesktopHomeServicePrerequisites()
                }
                if let message = store.sourceMetadataFailure {
                    Text(message).font(.callout).foregroundStyle(DesktopTheme.secondary)
                    Button("Check library connection again") { Task { await store.refreshPrerequisiteMetadata() } }
                        .buttonStyle(DesktopButtonStyle())
                }
                if !store.sourcesLoaded {
                    checking("Checking current sources and computers…")
                } else if store.sources.isEmpty {
                    ready("No local source permissions are needed yet")
                } else if store.api?.connection.collectorDeviceId == nil {
                    checking("Confirming this Mac’s collection connection…")
                } else if store.localCollectionSources.isEmpty {
                    ready("No sources are set to collect on this Mac")
                } else {
                    if store.sourceAccessReady { ready("Chosen-source file access checked") }
                    else {
                        checking(store.collectionAccess.flows.values.contains {
                            $0.memberAccessProblem || $0.unresolvedDenial || [.denied, .unavailable, .unsupported].contains($0.state)
                        } ? "Chosen-source access needs attention" : "Checking chosen-source access…")
                        Text(
                            "Review the access this Mac needs for your selected sources. Your indexed information and setup choices are kept."
                        )
                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                        Button("Review collection access") { store.accessFocus = nil
                            store.presentAccess = true
                        }.buttonStyle(DesktopButtonStyle(primary: DesktopSetupRepair.first(in: store) == .access))
                    }
                    if store.sourceConnectionsReady, store.localCollectionIdentityReady { ready("Chosen-source connections are ready") }
                    else {
                        Text(
                            "Review the sign-in or computer connection for the sources this Mac collects. A file-access check does not confirm a sign-in."
                        )
                        .font(.callout).foregroundStyle(DesktopTheme.secondary)
                        Button("Review sources") { store.destination = .sources }
                            .buttonStyle(DesktopButtonStyle(primary: DesktopSetupRepair.first(in: store) == .sources))
                    }
                }
                if store.sourcesLoaded, !store.localCollectionIdentityReady {
                    Text(
                        "This Mac’s collection connection needs attention. Repair its existing device connection; your indexed information is kept."
                    )
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
                    Button("Review devices") { store.destination = .devices }
                        .buttonStyle(DesktopButtonStyle(primary: DesktopSetupRepair.first(in: store) == .devices))
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { powerWasReady = store.serverPower.ready }
        .onChange(of: store.serverPower.status) {
            if store.serverPower.ready { powerWasReady = true }
            else if store.serverPower.status != .checking { powerWasReady = false }
        }
        .omnesisSheet(isPresented: $showPowerSteps) { DesktopMacServerGuidanceView() }
    }

    private func ready(_ title: String) -> some View {
        Label(title, systemImage: "checkmark.circle").font(.callout).foregroundStyle(DesktopTheme.teal)
    }

    private func checking(_ title: String) -> some View {
        Label(title, systemImage: "circle").font(.callout).foregroundStyle(DesktopTheme.secondary)
    }
}
