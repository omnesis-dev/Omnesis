// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

struct DesktopHomeServicePrerequisites: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.openSettings) private var openSettings
    @State private var showConnection = false
    var compactReady = false

    var body: some View {
        if store.state.mode == "home" {
            VStack(
                alignment: .leading,
                spacing: compactReady && store.homeServices.storage == .ready && store.homeServices.route == .ready ? 6 : 16
            ) {
                switch store.homeServices.storage {
                case .ready:
                    passed("Storage is ready for collection")
                case .checking:
                    checking("Checking space for collection…")
                case .blocked, .unavailable:
                    VStack(alignment: .leading, spacing: 10) {
                        Text(store.homeServices.storage == .blocked ? "Collection needs more storage" : "Storage needs checking")
                            .font(.headline).accessibilityAddTraits(.isHeader)
                        Text("Review storage before collecting more information. Your existing library remains available to read.")
                            .font(.callout).foregroundStyle(DesktopTheme.secondary)
                        HStack {
                            Button("Review storage") { store.settingsTab = "storage"
                                openSettings()
                            }
                            .buttonStyle(DesktopButtonStyle(primary: DesktopSetupRepair.first(in: store) == .storage))
                            .accessibilityIdentifier("setup-review-storage")
                            recheck
                        }
                    }
                }
                switch store.homeServices.route {
                case .ready:
                    passed("Your library can be reached from other devices")
                case .checking:
                    checking("Checking your library’s remote connection…")
                case .blocked, .unavailable:
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Your library’s remote connection needs checking").font(.headline).accessibilityAddTraits(.isHeader)
                        Text(
                            "Omnesis could not confirm the connection used by your other devices. Keep this Mac online and review its connection. You can still read information already available here."
                        ).font(.callout).foregroundStyle(DesktopTheme.secondary)
                        HStack {
                            Button("Review connection") {
                                showConnection = true
                            }.buttonStyle(DesktopButtonStyle(primary: DesktopSetupRepair.first(in: store) == .route))
                                .accessibilityIdentifier("setup-review-connection")
                            recheck
                        }
                    }
                }
            }
            .omnesisSheet(isPresented: $showConnection) { DesktopLibraryConnectionView().environment(store) }
        }
    }

    private var recheck: some View {
        Button("Check again") { store.homeServices.refreshClock()
            store.command("status")
        }
        .buttonStyle(DesktopButtonStyle()).disabled(store.busy)
    }

    private func passed(_ title: String) -> some View {
        Label(title, systemImage: "checkmark.circle").font(.callout).foregroundStyle(DesktopTheme.teal)
    }

    private func checking(_ title: String) -> some View {
        Label(title, systemImage: "clock").font(.callout).foregroundStyle(DesktopTheme.secondary)
    }
}
