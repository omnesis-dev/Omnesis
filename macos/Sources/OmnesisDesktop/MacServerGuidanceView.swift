// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import DesktopCore
import Foundation
import SwiftUI

struct DesktopMacServerTip: View {
    var compact = false
    @State private var showSteps = false
    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
            if !compact {
                Label("Keep this Mac available", systemImage: "desktopcomputer").font(DesktopDesignTokens.Typography.body.weight(.medium))
                Text(DesktopMacServerGuidance.summary).font(DesktopDesignTokens.Typography.secondary)
                    .foregroundStyle(DesktopTheme.secondary)
            }
            Button("Show sleep settings steps") { showSteps = true }
                .buttonStyle(DesktopButtonStyle())
                .accessibilityIdentifier("mac-server-steps")
        }.omnesisSheet(isPresented: $showSteps) { DesktopMacServerGuidanceView() }
    }
}

struct DesktopMacServerPrerequisite: View {
    @Environment(\.scenePhase) private var scenePhase
    let flow: DesktopMacServerPowerFlow
    var primaryAction = true
    var compactReady = false
    var compactChecking = false
    @State private var showSteps = false

    var body: some View {
        Group {
            if compactChecking, flow.status == .checking || flow.status == .needed {
                HStack {
                    Label("Checking this Mac’s sleep settings…", systemImage: "clock")
                        .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                    Spacer()
                    Button("Show steps") { showSteps = true }.buttonStyle(DesktopButtonStyle())
                        .accessibilityIdentifier("mac-server-steps")
                }
            } else if compactReady, flow.ready {
                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                    HStack {
                        Label("Automatic sleep is off while plugged in", systemImage: "checkmark.circle")
                            .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.success)
                        Spacer()
                        Button("Check again") { Task { await flow.refresh() } }.buttonStyle(DesktopButtonStyle())
                            .accessibilityIdentifier("mac-server-power-check")
                        Button("Show steps") { showSteps = true }.buttonStyle(DesktopButtonStyle())
                            .accessibilityIdentifier("mac-server-steps")
                    }
                    Text("Keep this Mac powered on and connected to the network. Its display can turn off and its screen can stay locked.")
                        .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                }
            } else {
                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.medium) {
                    Label("Keep your library Mac awake", systemImage: flow.ready ? "checkmark.circle" : "desktopcomputer")
                        .font(DesktopDesignTokens.Typography.body.weight(.medium))
                    Text(
                        "Required for your library to be available to your other devices. The display can turn off and the screen can stay locked."
                    )
                    .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                    Text(statusText).font(DesktopDesignTokens.Typography.secondary)
                        .foregroundStyle(flow.ready ? DesktopTheme.success : DesktopTheme.ink)
                        .accessibilityIdentifier("mac-server-power-status")
                    if flow.status == .checking { ProgressView("Checking system sleep settings…").controlSize(.small) }
                    HStack {
                        if !flow.ready {
                            Button("Configure sleep settings") { showSteps = true }.buttonStyle(DesktopButtonStyle(primary: primaryAction))
                                .accessibilityIdentifier("mac-server-steps")
                        }
                        Button("Check again") { Task { await flow.refresh() } }.buttonStyle(DesktopButtonStyle())
                            .disabled(flow.status == .checking).accessibilityIdentifier("mac-server-power-check")
                        if flow.ready {
                            Button("Show settings steps") { showSteps = true }.buttonStyle(DesktopButtonStyle())
                                .accessibilityIdentifier("mac-server-steps")
                        }
                    }
                }
            }
        }
        .task { await flow.refresh() }
        .onChange(of: scenePhase) { if scenePhase == .active { Task { await flow.refresh() } } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification, object: NSApp)) { _ in
            Task { await flow.refresh() }
        }
        .omnesisSheet(isPresented: $showSteps) { DesktopMacServerGuidanceView() }
    }

    private var statusText: String {
        switch flow.status {
        case .needed: "Setup incomplete: system sleep settings need to be checked."
        case .checking: "Checking this Mac’s configuration."
        case .ready: "Automatic system sleep is disabled while connected to power. Keep this Mac powered on and its network connected."
        case .sleepEnabled: "Setup incomplete: this Mac is configured to sleep automatically. Follow the steps, then check again."
        case .onBattery: "Setup incomplete: connect this Mac to its power adapter, then check again."
        case .unavailable: "Setup incomplete: the power configuration could not be verified. Follow the steps and check again."
        }
    }
}

struct DesktopMacServerGuidanceView: View {
    @Environment(\.dismiss) private var dismiss
    var openSettings: @MainActor () -> Bool = {
        NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/System Settings.app", isDirectory: true))
    }

    @State private var settingsUnavailable = false
    private var energyPane: String {
        DesktopMacServerGuidance.desktopEnergyPane(macOSMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
            Text("Keep your library available").font(DesktopDesignTokens.Typography.section).accessibilityAddTraits(.isHeader)
            ScrollView {
                VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.large) {
                    Text("A desktop Mac you leave powered on, such as a Mac mini, is a good home for your library.")
                    Text(DesktopMacServerGuidance.summary).foregroundStyle(DesktopTheme.secondary)
                    GroupBox("On a desktop Mac") {
                        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                            Text("1. Open System Settings → \(energyPane).")
                            Text("2. Turn on Prevent automatic sleeping when the display is off.")
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    GroupBox("On a MacBook") {
                        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.small) {
                            Text("1. Connect its power adapter.")
                            Text("2. Open System Settings → Battery → Options.")
                            Text("3. Turn on Prevent automatic sleeping on power adapter when the display is off.")
                            Text("Keep the lid open unless you use Apple’s supported external-display setup.")
                                .foregroundStyle(DesktopTheme.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Text(
                        "Automatic startup is required. After a restart, sign in to this Mac so Omnesis can start. Wake for network access alone does not keep your library connected."
                    )
                    .foregroundStyle(DesktopTheme.secondary)
                    Text(
                        "These steps are for the Mac that stores your library. A Mac that only joins it does not need to stay awake for the library to remain available."
                    )
                    .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if settingsUnavailable {
                Text("Open System Settings from the Apple menu, then follow the steps above.")
                    .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
            }
            HStack {
                Link("Apple’s sleep settings guide", destination: DesktopMacServerGuidance.appleGuide).desktopTextLink()
                    .accessibilityIdentifier("mac-server-apple-guide")
                Spacer()
                Button("Open System Settings") { settingsUnavailable = !openSettings() }
                    .buttonStyle(DesktopButtonStyle()).accessibilityIdentifier("mac-server-open-settings")
                Button("Done") { dismiss() }.buttonStyle(DesktopButtonStyle()).keyboardShortcut(.cancelAction)
            }
        }.padding(DesktopDesignTokens.Space.section).frame(width: 600, height: 560).omnesisTheme()
    }
}

#Preview("Mac library host guidance") { DesktopMacServerGuidanceView() }
