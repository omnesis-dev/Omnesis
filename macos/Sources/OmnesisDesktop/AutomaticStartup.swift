// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Observation
import ServiceManagement
import SwiftUI

@MainActor @Observable
final class DesktopAutomaticStartup {
    enum Status: Equatable { case needsCheck, enabled, approvalRequired, disabled, unavailable }
    private(set) var status = Status.needsCheck
    private(set) var working = false
    private(set) var error: String?
    private let read: () -> Status
    private let register: @MainActor () async throws -> Void
    private let attempted: (String) -> Bool
    private let remember: (String) -> Void
    private var installation: String?
    private var generation = UUID()
    init(
        read: @escaping () -> Status = {
            switch SMAppService.loginItem(identifier: "dev.omnesis.desktop.background").status {
            case .enabled: .enabled
            case .requiresApproval: .approvalRequired
            case .notRegistered: .disabled
            case .notFound: .unavailable
            @unknown default: .unavailable
            }
        },
        register: @escaping @MainActor () async throws -> Void = {
            try SMAppService.loginItem(identifier: "dev.omnesis.desktop.background").register()
        },
        attempted: @escaping (String) -> Bool = { UserDefaults.standard.bool(forKey: "automatic-startup-attempted." + $0) },
        remember: @escaping (String) -> Void = { UserDefaults.standard.set(true, forKey: "automatic-startup-attempted." + $0) }
    ) {
        self.read = read
        self.register = register
        self.attempted = attempted
        self.remember = remember
    }

    var ready: Bool {
        status == .enabled
    }

    func refresh() {
        status = read()
    }

    func enable() async {
        guard !working else { return }
        guard !Task.isCancelled else { return }
        let operation = generation
        let scope = installation
        if let scope { remember(scope) }
        working = true
        defer { working = false }
        guard operation == generation, scope == installation, !Task.isCancelled else { return }
        do {
            try Task.checkCancellation()
            try await register()
            guard operation == generation, scope == installation, !Task.isCancelled else { return }
            error = nil
        } catch {
            guard operation == generation, scope == installation, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
        refresh() // Registration acknowledgment is not evidence of approval.
    }

    func bindInstallation(_ value: String?) {
        let next = value.flatMap { $0.range(of: "^desktop-[a-f0-9]{16}$", options: .regularExpression) != nil ? $0 : nil }
        if installation != next { generation = UUID()
            installation = next
            error = nil
            status = .needsCheck
        }
    }

    func ensureForExplicitSetup(installationId: String?) async {
        guard !Task.isCancelled, !working, let installationId, installationId == installation else { return }
        refresh()
        guard let installation, !attempted(installation) else { return }
        remember(installation) // Record before invoking the OS so revocation is never silently overridden.
        if status == .enabled || status == .approvalRequired { return }
        await enable()
    }
}

struct DesktopAutomaticStartupView: View {
    let flow: DesktopAutomaticStartup
    var primaryAction = true
    var openSettings: () -> Void = { SMAppService.openSystemSettingsLoginItems() }
    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.medium) {
            Label("Automatic startup · Required", systemImage: flow.ready ? "checkmark.circle" : "power")
                .font(DesktopDesignTokens.Typography.body.weight(.medium))
                .foregroundStyle(flow.ready ? DesktopTheme.success : DesktopTheme.ink)
            Text("Automatically start Omnesis after you sign in so collection can resume.")
                .font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.secondary)
            switch flow.status {
            case .enabled: Text("Enabled in macOS").font(DesktopDesignTokens.Typography.secondary)
            case .approvalRequired:
                Text("Waiting for your approval in System Settings. Setup is not complete yet.")
                    .font(DesktopDesignTokens.Typography.secondary)
                Button("Approve in Login Items", action: openSettings).buttonStyle(DesktopButtonStyle(primary: primaryAction))
                    .accessibilityIdentifier("startup-approve")
            case .disabled:
                Text("Automatic startup is off. Enable it to complete setup.").font(DesktopDesignTokens.Typography.secondary)
                Button("Enable automatic startup") { Task { await flow.enable() } }.buttonStyle(DesktopButtonStyle(primary: primaryAction))
                    .accessibilityIdentifier("startup-enable")
            case .needsCheck: Text("Checking automatic startup…").font(DesktopDesignTokens.Typography.secondary)
            case .unavailable:
                Text("This copy could not verify automatic startup. Reopen the installed Omnesis app, then check again.")
                    .font(DesktopDesignTokens.Typography.secondary)
            }
            if flow.working { ProgressView("Requesting automatic startup…").controlSize(.small) }
            if let error = flow.error { Text(error).font(DesktopDesignTokens.Typography.secondary).foregroundStyle(DesktopTheme.danger) }
            Button("Check again") { flow.refresh() }.buttonStyle(DesktopButtonStyle()).disabled(flow.working)
                .accessibilityIdentifier("startup-check")
        }.disabled(flow.working).onAppear { flow.refresh() }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification, object: NSApp)) { _ in
                flow.refresh()
            }
    }
}

/// Available before a runtime connection or an installation identity exists.
/// Only an explicit user action can register the installed app here.
struct DesktopStartupRepairView: View {
    let flow: DesktopAutomaticStartup
    let retry: () -> Void
    var openSettings: () -> Void = { SMAppService.openSystemSettingsLoginItems() }
    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.regular) {
            Text("Finish background setup").font(DesktopDesignTokens.Typography.section).accessibilityAddTraits(.isHeader)
            Text(
                "Automatic startup is required and has not been enabled or approved. Review it in macOS, then retry the background connection. These controls do not create or replace a library."
            )
            .foregroundStyle(DesktopTheme.secondary)
            DesktopAutomaticStartupView(flow: flow, openSettings: openSettings)
            Button("Retry background connection", action: retry).buttonStyle(DesktopButtonStyle(primary: true))
                .disabled(flow.working).accessibilityIdentifier("startup-runtime-retry")
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
