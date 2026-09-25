// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// One row of the device list (`DevicesView.swift`): the always-visible header
// with the device's identity and status, the failure notice for whatever action
// last failed on it, and the credentials section it expands into. Credentials
// are listed and revoked here; new ones are issued from the CLI.

@available(iOS 17.0, *)
struct DeviceCard: View {
    let device: DeviceRecord
    /// Whether this card is the device backing the current app session.
    var isThis = false
    /// `nil` until the row has been expanded once and the fetch resolved.
    let tokens: [TokenRecord]?
    /// Why the last action on this device failed, rendered under the header
    /// so the message lands where the action was taken.
    var failure: String?
    var onExpand: () async -> Void = {}
    var onRevokeDevice: () -> Void = {}
    var onForgetDevice: () -> Void = {}
    var onRepairDevice: () -> Void = {}
    var onRevokeToken: (String) -> Void = { _ in }
    var mutationsDisabled = false

    @State private var expanded: Bool

    init(
        device: DeviceRecord,
        isThis: Bool = false,
        tokens: [TokenRecord]?,
        failure: String? = nil,
        onExpand: @escaping () async -> Void = {},
        onRevokeDevice: @escaping () -> Void = {},
        onForgetDevice: @escaping () -> Void = {},
        onRepairDevice: @escaping () -> Void = {},
        onRevokeToken: @escaping (String) -> Void = { _ in },
        mutationsDisabled: Bool = false,
        startExpanded: Bool = false
    ) {
        self.device = device
        self.isThis = isThis
        self.tokens = tokens
        self.failure = failure
        self.onExpand = onExpand
        self.onRevokeDevice = onRevokeDevice
        self.onForgetDevice = onForgetDevice
        self.onRepairDevice = onRepairDevice
        self.onRevokeToken = onRevokeToken
        self.mutationsDisabled = mutationsDisabled
        self._expanded = State(initialValue: startExpanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let failure {
                failureBanner(failure)
                    .padding(.top, Theme.Spacing.sm)
            }
            if expanded {
                Rectangle()
                    .fill(Theme.borderLight)
                    .frame(height: 1)
                    .padding(.top, Theme.Spacing.md)
                tokenSection
                    .padding(.top, Theme.Spacing.md)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(isThis ? Theme.accent : Theme.border, lineWidth: isThis ? 1.5 : 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    /// The refusal, in the card that produced it. Not collapsible with the
    /// row: the message must survive the user tapping the header shut.
    private func failureBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(Theme.danger)
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(Theme.danger)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.danger.opacity(0.10))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                .stroke(Theme.danger.opacity(0.4), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    private var header: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            if expanded {
                Task { await onExpand() }
            }
        } label: {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: DeviceKindMeta.icon(device.kind))
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(device.name)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        if isThis {
                            thisDeviceBadge
                        }
                        if device.isRevoked {
                            revokedBadge
                        }
                    }
                    HStack(spacing: 6) {
                        Text(DeviceKindMeta.label(device.kind))
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textMuted)
                        if let integration = device.capabilities?.agentIntegration {
                            Text("· \(agentHarnessLabel(integration.harness))")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textMuted)
                                .lineLimit(1)
                        } else if let host = device.capabilities?.hostname, !host.isEmpty {
                            Text("· \(host)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Theme.textMuted)
                                .lineLimit(1)
                        }
                    }
                    statusLabel
                }
                // The identity column takes the width the icon, menu and
                // chevron leave, so the name is never squeezed by the
                // fixed-size status line beneath it.
                .layoutPriority(1)
                Spacer(minLength: 0)
                deviceMenu
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Non-portal devices can be repaired while offline. A paired device can
    /// be revoked; a revoked device can be repaired or forgotten.
    private var deviceMenu: some View {
        Menu {
            if device.kind != "portal" {
                Button {
                    onRepairDevice()
                } label: {
                    Label("Repair device", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(isThis || device.online == true)
            }
            if device.isRevoked {
                Button(role: .destructive) {
                    onForgetDevice()
                } label: {
                    Label("Forget device", systemImage: "trash")
                }
            } else {
                Button(role: .destructive) {
                    onRevokeDevice()
                } label: {
                    Label("Revoke device", systemImage: "trash")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .disabled(mutationsDisabled)
    }

    private var thisDeviceBadge: some View {
        Text("This device")
            .font(.system(size: 9, weight: .semibold))
            .tracking(0.3)
            .textCase(.uppercase)
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .overlay(
                Capsule().stroke(Theme.accent.opacity(0.5), lineWidth: 1)
            )
    }

    private var revokedBadge: some View {
        Text("Revoked")
            .font(.system(size: 9, weight: .semibold))
            .tracking(0.3)
            .textCase(.uppercase)
            .foregroundStyle(Theme.danger)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .overlay(
                Capsule().stroke(Theme.danger.opacity(0.5), lineWidth: 1)
            )
    }

    /// Revoked first; then activity for the current client, live transport
    /// for others, then last activity.
    private var statusLabel: some View {
        let activeNow = !device.isRevoked && (isThis || device.online == true)
        return HStack(spacing: 5) {
            Circle()
                .fill(activeNow ? Theme.success : Theme.textMuted)
                .frame(width: 6, height: 6)
            Text(DeviceGrouping.statusLine(device, isCurrent: isThis))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(activeNow ? Theme.success : Theme.textMuted)
                .lineLimit(1)
        }
        .fixedSize()
    }

    private var tokenSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            timesRow
            Text(device.id)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.textMuted)
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.middle)
            if let tokens {
                if tokens.isEmpty {
                    Text("No tokens")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                } else {
                    Text("CREDENTIALS")
                        .font(.system(size: 10, weight: .semibold))
                        .tracking(0.6)
                        .foregroundStyle(Theme.textMuted)
                    ForEach(tokens) { token in
                        TokenRow(
                            token: token,
                            onRevoke: mutationsDisabled ? nil : { onRevokeToken(token.id) }
                        )
                    }
                }
                if !device.isRevoked {
                    cliFootnote
                }
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Loading tokens…")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                }
            }
        }
    }

    /// Where a new credential comes from. A revoked device cannot be issued
    /// one, so the note is only shown for a live device.
    private var cliFootnote: some View {
        (Text("Extra credentials are issued from the CLI: ")
            + Text("omnesis tokens create --device <device> --scopes …")
            .font(.system(size: 10, design: .monospaced)))
            .font(.system(size: 10))
            .foregroundStyle(Theme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, Theme.Spacing.xs)
    }

    private var timesRow: some View {
        HStack(spacing: Theme.Spacing.md) {
            metaPair(label: "Paired", value: formatUnixMillisAgo(device.pairedAt))
            metaPair(
                label: "Last activity",
                value: isThis ? "now" : device.lastSeenAt.map(formatUnixMillisAgo) ?? "not recorded"
            )
            Spacer(minLength: 0)
        }
    }

    private func metaPair(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(Theme.textMuted)
            Text(value)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
        }
    }
}

private func agentHarnessLabel(_ harness: String) -> String {
    switch harness.lowercased() {
    case "openclaw": "OpenClaw"
    case "hermes": "Hermes"
    default: harness
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
private struct DeviceCardPreview: View {
    let device: DeviceRecord
    let tokens: [TokenRecord]?

    var body: some View {
        ScrollView {
            DeviceCard(device: device, tokens: tokens, startExpanded: true)
                .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .environment(AppStore.preview())
    }
}

@available(iOS 17.0, *)
#Preview("Device card — credentials") {
    DeviceCardPreview(
        device: PreviewMocks.deviceCollector,
        tokens: PreviewMocks.deviceTokens[PreviewMocks.deviceCollector.id]
    )
}

@available(iOS 17.0, *)
#Preview("Device card — no tokens") {
    DeviceCardPreview(device: PreviewMocks.deviceAgent, tokens: [])
}

@available(iOS 17.0, *)
#Preview("Device card — loading tokens") {
    DeviceCardPreview(device: PreviewMocks.devicePhone, tokens: nil)
}

@available(iOS 17.0, *)
#Preview("Device card — revoked") {
    DeviceCardPreview(device: PreviewMocks.deviceRevoked, tokens: [])
}
#endif
#endif
