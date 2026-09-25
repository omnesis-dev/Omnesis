// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// MARK: - One backend row

@available(iOS 17.0, *)
struct BackendRowCard: View {
    let row: ModelManagement.BackendRow
    let probe: BackendsContent.ProbeState
    /// Open this backend's detail (verify-capabilities) view.
    var onOpen: () -> Void = {}
    var onTest: () -> Void = {}
    var onRemove: () -> Void = {}
    var disabled = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Button(action: onOpen) {
                HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                    BackendBrandIcon(key: row.key, size: 18)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(row.key)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            statusBadge
                        }
                        if let url = row.status.url, !url.isEmpty {
                            Text(url)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        metaLine
                        if let probeLabel = BackendsContent.probeLabel(probe) {
                            Text(probeLabel.text)
                                .font(.system(size: 11))
                                .foregroundStyle(probeLabel.color)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(disabled)

            HStack(spacing: Theme.Spacing.sm) {
                Button(action: onTest) {
                    Text(probe == .probing ? "Testing…" : "Test")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                                .stroke(Theme.accent.opacity(0.4), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .disabled(disabled || probe == .probing)

                Button(action: onRemove) {
                    Text("Remove")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                                .stroke(Theme.danger.opacity(0.4), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .disabled(disabled)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    private var metaLine: some View {
        HStack(spacing: 6) {
            let count = row.status.models?.count ?? 0
            Text("\(count) model\(count == 1 ? "" : "s")")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
            if row.status.hasApiKey == true {
                Text("· API key set")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch row.status.status {
        case "ok":
            badge(text: "reachable", color: Theme.success)
        case "reachable":
            // Host answered, but its model list couldn't be fetched — still
            // usable with a manually-assigned model id.
            badge(text: "no model list", color: Theme.warning)
        case "unreachable":
            badge(text: "unreachable", color: Theme.danger)
        case "probing":
            badge(text: "probing", color: Theme.warning)
        default:
            EmptyView()
        }
    }

    private func badge(text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}

// MARK: - Codex row

@available(iOS 17.0, *)
struct CodexRowCard: View {
    let status: CodexBackendStatus
    var onManage: () -> Void = {}
    var onRefresh: () -> Void = {}
    var onRemove: () -> Void = {}
    var disabled = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Button(action: onManage) {
                HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                    BackendBrandIcon(key: "codex", size: 18)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text("Codex")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Theme.textPrimary)
                            statusBadge
                        }
                        Text(metaLine)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                        if let reason = status.reason, !reason.isEmpty {
                            Text(reason)
                                .font(.system(size: 11))
                                .foregroundStyle(status.loggedIn ? Theme.textMuted : Theme.warning)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(disabled)

            HStack(spacing: Theme.Spacing.sm) {
                Button(action: onRefresh) {
                    Text(status.status == "probing" ? "Checking..." : "Check")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                                .stroke(Theme.accent.opacity(0.4), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .disabled(disabled || status.status == "probing")

                Button(action: onRemove) {
                    Text("Remove")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                                .stroke(Theme.danger.opacity(0.4), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .disabled(disabled)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    private var metaLine: String {
        let runtime = codexRuntimeMeta
        if status.loggedIn, status.status == "ok" {
            let count = status.models.count
            return ["\(count) model\(count == 1 ? "" : "s")", runtime].compactMap(\.self).joined(separator: " · ")
        }
        return [status.configured ? "OpenAI login needs attention" : "Not configured", runtime]
            .compactMap(\.self)
            .joined(separator: " · ")
    }

    private var codexRuntimeMeta: String? {
        guard let runtime = status.runtime else { return status.discovery }
        let source: String = if runtime.source == "managed" {
            runtime.packageVersion.map { "@openai/codex \($0)" } ?? "managed"
        } else {
            "override"
        }
        return [source, runtime.version.map { "CLI \($0)" }, status.discovery]
            .compactMap(\.self)
            .joined(separator: ", ")
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch status.status {
        case "ok" where status.loggedIn:
            badge(text: "connected", color: Theme.success)
        case "probing":
            badge(text: "probing", color: Theme.warning)
        default:
            badge(text: status.configured ? "attention" : "not configured", color: status.configured ? Theme.warning : Theme.textMuted)
        }
    }

    private func badge(text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}

// MARK: - Backend detail (verify capabilities)

/// Pushed when a backend summary card is tapped. Shows the backend header
/// (icon, key, URL, status, meta) plus the "Verify capabilities" section: one
/// behavioral-verify affordance per (model, role) the probe classified into a
/// verifiable role. The verify state + handlers live in `BackendsContent` and
/// are threaded down so a verdict survives navigating back and forth; Test /
/// Remove stay on the summary card, so they're not repeated here.
@available(iOS 17.0, *)
struct BackendDetailView: View {
    let row: ModelManagement.BackendRow
    /// Per-target verify state, keyed by `VerifyTarget.id`.
    var verifyStates: [String: BackendsContent.VerifyState] = [:]
    var onVerify: (ModelManagement.VerifyTarget) -> Void = { _ in }
    var onReVerify: (ModelManagement.VerifyTarget) -> Void = { _ in }
    var disabled = false

    private var verifyTargets: [ModelManagement.VerifyTarget] {
        ModelManagement.verifyTargets(row)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                header
                if verifyTargets.isEmpty {
                    emptyVerify
                } else {
                    verifySection
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle(row.key)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                BackendBrandIcon(key: row.key, size: 20)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(row.key)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        statusBadge
                    }
                    if let url = row.status.url, !url.isEmpty {
                        Text(url)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                    metaLine
                }
                Spacer(minLength: 0)
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    /// Per-(model, role) behavioral-verify rows. The probe's `/v1/models` list
    /// only advertises which models *claim* a role; a Verify confirms the model
    /// actually serves it (the gateway issues the role's minimal capability call).
    private var verifySection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Verify capabilities")
                .font(.system(size: 11, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.5)
                .foregroundStyle(Theme.textSecondary)
            ForEach(verifyTargets) { target in
                VerifyRow(
                    target: target,
                    state: verifyStates[target.id] ?? .idle,
                    onVerify: { onVerify(target) },
                    onReVerify: { onReVerify(target) },
                    disabled: disabled
                )
                .padding(Theme.Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.bgSecondary)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.large)
                        .stroke(Theme.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            }
        }
    }

    private var emptyVerify: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Nothing to verify yet.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
            Text(
                "Once this backend is reachable and its probe classifies a model into a verifiable role "
                    + "(embedder or agent), a Verify affordance shows up here."
            )
            .font(.system(size: 11))
            .foregroundStyle(Theme.textMuted)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    private var metaLine: some View {
        HStack(spacing: 6) {
            let count = row.status.models?.count ?? 0
            Text("\(count) model\(count == 1 ? "" : "s")")
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
            if row.status.hasApiKey == true {
                Text("· API key set")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch row.status.status {
        case "ok":
            badge(text: "reachable", color: Theme.success)
        case "reachable":
            // Host answered, but its model list couldn't be fetched — still
            // usable with a manually-assigned model id.
            badge(text: "no model list", color: Theme.warning)
        case "unreachable":
            badge(text: "unreachable", color: Theme.danger)
        case "probing":
            badge(text: "probing", color: Theme.warning)
        default:
            EmptyView()
        }
    }

    private func badge(text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}

// MARK: - One verify (model, role) row

/// A single behavioral-verify affordance: the role label + model, a Verify
/// button, and the inline verdict/error/in-flight line. Pure over a fixed
/// `VerifyState` so the snapshot test exercises every state without a gateway.
/// Once a verdict is in, the button becomes a "Re-verify" that force-bypasses
/// the gateway's cache.
@available(iOS 17.0, *)
struct VerifyRow: View {
    let target: ModelManagement.VerifyTarget
    let state: BackendsContent.VerifyState
    var onVerify: () -> Void = {}
    var onReVerify: () -> Void = {}
    var disabled = false

    private var verifying: Bool {
        state == .verifying
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ModelManagement.roleLabel(target.role))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(target.model)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                verdictBadge
                Button(action: hasVerdict ? onReVerify : onVerify) {
                    Text(buttonLabel)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                                .stroke(Theme.accent.opacity(0.4), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .disabled(disabled || verifying)
            }
            if let detail = detailLine {
                Text(detail.text)
                    .font(.system(size: 11))
                    .foregroundStyle(detail.color)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 2)
    }

    private var hasVerdict: Bool {
        if case .verdict = state { return true }
        return false
    }

    private var buttonLabel: String {
        if verifying { return "Verifying…" }
        return hasVerdict ? "Re-verify" : "Verify"
    }

    @ViewBuilder
    private var verdictBadge: some View {
        switch state {
        case .verdict(let supported, _):
            Text(supported ? "✓" : "✗")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(supported ? Theme.success : Theme.danger)
        default:
            EmptyView()
        }
    }

    private var detailLine: (text: String, color: Color)? {
        switch state {
        case .idle: nil
        case .verifying: ("Issuing a \(ModelManagement.roleLabel(target.role).lowercased()) call…", Theme.textMuted)
        case .verdict(let supported, let detail):
            (
                detail.isEmpty ? (supported ? "Supported" : "Not supported") : detail,
                supported ? Theme.success : Theme.danger
            )
        case .error(let message):
            ("Verify failed: \(message)", Theme.danger)
        }
    }
}

// MARK: - One provider-credential row

@available(iOS 17.0, *)
struct CredentialRowCard: View {
    let entry: ModelCredentialEntry
    var onSet: () -> Void = {}
    var onClear: () -> Void = {}
    var disabled = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                ProviderIcon(providerId: entry.providerType, size: 22)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(entry.providerName)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        statusBadge
                    }
                    Text(entry.configured ? "API key set" : "Not configured")
                        .font(.system(size: 12))
                        .foregroundStyle(entry.configured ? Theme.textSecondary : Theme.textMuted)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: Theme.Spacing.sm) {
                Button(action: onSet) {
                    Text(entry.configured ? "Replace key" : "Set key")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                                .stroke(Theme.accent.opacity(0.4), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .disabled(disabled)

                if entry.configured {
                    Button(action: onClear) {
                        Text("Clear")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.Radius.medium)
                                    .stroke(Theme.danger.opacity(0.4), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(disabled)
                }
            }
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    @ViewBuilder
    private var statusBadge: some View {
        if entry.configured {
            Text("configured")
                .font(.system(size: 9, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.5)
                .foregroundStyle(Theme.success)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Theme.success.opacity(0.12))
                .clipShape(Capsule())
        }
    }
}
#endif
