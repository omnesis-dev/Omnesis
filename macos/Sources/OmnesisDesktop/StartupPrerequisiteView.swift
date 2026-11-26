// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

struct DesktopStartupPrerequisiteView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        if store.applicationOwnership?.installation == .recoveredVersionInstallNeeded {
            VStack(alignment: .leading, spacing: 10) {
                Text("Finish installing the recovered app").font(.headline).accessibilityAddTraits(.isHeader)
                Text(
                    "Your recovered library remains available. Install the recovered app before confirming automatic startup for this version."
                )
                .font(.callout).foregroundStyle(DesktopTheme.secondary)
                Button("Review installation recovery") { store.settingsTab = "updates"
                    openSettings()
                }
                .buttonStyle(DesktopButtonStyle(primary: DesktopSetupRepair.first(in: store) == .installation))
                .accessibilityIdentifier("application-installation-recovery")
                Label("Automatic startup will be checked after installation", systemImage: "clock")
                    .font(.callout).foregroundStyle(DesktopTheme.secondary)
            }
        } else if !store.applicationInstallationCurrent, store.automaticStartup.ready {
            Label("Automatic startup will be checked after this installed app is confirmed", systemImage: "clock")
                .font(.callout).foregroundStyle(DesktopTheme.secondary)
        } else if store.applicationInstallationCurrent, store.automaticStartup.ready {
            Label("Starts automatically when you sign in", systemImage: "checkmark.circle")
                .font(.callout).foregroundStyle(DesktopTheme.teal)
        } else { DesktopAutomaticStartupView(flow: store.automaticStartup, primaryAction: DesktopSetupRepair.first(in: store) == .startup) }
    }
}
