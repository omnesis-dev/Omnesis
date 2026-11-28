// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

struct DesktopStartupPrerequisiteView: View {
    @Environment(DesktopStore.self) private var store
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        if store.applicationOwnership?.installation == .recoveredVersionInstallNeeded {
            VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                Text("Finish installing the recovered app").font(DesktopDesignTokens.Typography.body.weight(.medium))
                    .accessibilityAddTraits(.isHeader)
                Text(
                    "Your recovered library remains available. Install the recovered app before confirming automatic startup for this version."
                )
                .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                Button("Review installation recovery") { store.settingsTab = "updates"
                    openSettings()
                }
                .buttonStyle(DesktopButtonStyle(primary: DesktopSetupRepair.first(in: store) == .installation))
                .accessibilityIdentifier("application-installation-recovery")
                Label("Automatic startup will be checked after installation", systemImage: "clock")
                    .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
            }
        } else if !store.applicationInstallationCurrent, store.automaticStartup.ready {
            Label("Automatic startup will be checked after this installed app is confirmed", systemImage: "clock")
                .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
        } else if store.applicationInstallationCurrent, store.automaticStartup.ready {
            Label("Starts automatically when you sign in", systemImage: "checkmark.circle")
                .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.success)
        } else { DesktopAutomaticStartupView(flow: store.automaticStartup, primaryAction: DesktopSetupRepair.first(in: store) == .startup) }
    }
}
