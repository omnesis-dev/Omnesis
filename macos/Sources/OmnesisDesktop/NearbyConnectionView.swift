// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import SwiftUI

struct DesktopNearbyConnectionView: View {
    let status: DesktopNearbyGatewayHints.State
    let connected: Bool
    let busy: Bool
    let retry: () -> Void
    var navigate: () -> DesktopPermissionSettings.NavigationResult = { DesktopPermissionSettings.open(.privacySecurity) }
    @State private var navigationUnavailable = false

    var body: some View {
        Section("Nearby connection") {
            Label(title, systemImage: status == .denied ? "network.slash" : "network")
            Text(detail).font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
            if status == .denied {
                Button("Open Privacy & Security") { navigationUnavailable = navigate() == .unavailable }
                    .accessibilityIdentifier("nearby-privacy-settings")
                if navigationUnavailable {
                    Text("Open System Settings → Privacy & Security → Local Network, then allow Omnesis.")
                        .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                }
            }
            if connected {
                Text("Your secure library connection is available.")
                    .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
            }
            Button("Check again", action: retry).disabled(busy).accessibilityIdentifier("nearby-recheck")
        }
    }

    private var title: String {
        switch status {
        case .finding: "Looking for your library nearby"
        case .ready: "Nearby discovery is available"
        case .denied: "Local network access needs attention"
        case .unavailable: "Nearby discovery could not be checked"
        }
    }

    private var detail: String {
        switch status {
        case .finding: "Omnesis checks this network for the library you already connected. Nearby discovery cannot connect a different library."
        case .ready: "Nearby addresses are used only after the server proves it is your connected library."
        case .denied: "Allow Omnesis in System Settings → Privacy & Security → Local Network to find your library nearby, then check again."
        case .unavailable: "Check again after your connection or this Mac’s background service is available. Omnesis can use its secure remote connection when available."
        }
    }
}
