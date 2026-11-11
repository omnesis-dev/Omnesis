// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Step one of changing the Decision model: where it runs. Backends already
/// answering decisions come first so one can be reused with another model,
/// then backends whose provider offers decision models too (they reuse the
/// key they have), the built-in TypeSafe, and the providers to add — servers
/// on the operator's machine, hosted APIs, and any other System One server
/// by URL.
@available(iOS 17.0, *)
struct DecisionProviderList: View {
    let overview: ModelsOverview
    var onPick: (DecisionModelSetup.Choice) -> Void = { _ in }

    private var groups: DecisionModelSetup.ProviderGroups {
        DecisionModelSetup.providerGroups(overview)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                if !groups.existing.isEmpty {
                    section("Set up") {
                        ForEach(groups.existing) { backend in
                            existingRow(backend)
                        }
                    }
                }
                if !groups.enable.isEmpty {
                    section("Use a backend you have") {
                        ForEach(groups.enable) { backend in
                            enableRow(backend)
                        }
                    }
                }
                if let typesafe = groups.typesafe {
                    section("Built in") {
                        presetRow(typesafe)
                    }
                }
                section("Add a provider") {
                    ForEach(groups.add) { preset in
                        presetRow(preset)
                    }
                    row(
                        providerId: "http",
                        title: "Other server",
                        subtitle: "Any System One server, by URL",
                        action: { onPick(.custom) }
                    )
                }
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .navigationTitle("Choose a provider")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func section(_ title: String, @ViewBuilder rows: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            DecisionSectionHeader(title: title)
            rows()
        }
    }

    private func existingRow(_ backend: DecisionModelSetup.ExistingBackend) -> some View {
        let current = overview.inference.assignments[DecisionModelSetup.role]
        let inUse = current?.kind == "decision" && current?.backendKey == backend.key
        let provider = backend.preset?.name ?? "Custom server"
        return row(
            providerId: backend.preset?.brandId ?? "http",
            title: backend.key,
            subtitle: "\(provider) · \(Self.hostLabel(backend.decision?.url ?? ""))",
            badge: inUse ? "In use" : nil,
            action: { onPick(.existing(backend)) }
        )
    }

    private func enableRow(_ backend: DecisionModelSetup.ExistingBackend) -> some View {
        row(
            providerId: backend.preset?.brandId ?? "http",
            title: backend.key,
            subtitle: "\(backend.preset?.name ?? backend.key) — uses your existing key",
            action: { onPick(.enable(backend)) }
        )
    }

    private func presetRow(_ preset: ProviderPreset) -> some View {
        row(
            providerId: preset.brandId,
            title: preset.name,
            subtitle: preset.decision?.note.map(Self.plainNote) ?? Self.hostLabel(preset.decision?.url ?? ""),
            action: { onPick(.preset(preset)) }
        )
    }

    private func row(
        providerId: String,
        title: String,
        subtitle: String,
        badge: String? = nil,
        action: @escaping () -> Void
    )
        -> some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.sm) {
                ProviderIcon(providerId: providerId, size: 20)
                    .foregroundStyle(Theme.textPrimary)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                            .lineLimit(1)
                        if let badge {
                            Text(badge)
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
                    Text(subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textMuted)
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgSecondary)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.large).stroke(Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// `host:port` of a URL, or the URL itself when it has no host.
    static func hostLabel(_ url: String) -> String {
        guard let components = URLComponents(string: url), let host = components.host else { return url }
        return components.port.map { "\(host):\($0)" } ?? host
    }

    /// A preset note without its Markdown code spans.
    static func plainNote(_ note: String) -> String {
        note.replacingOccurrences(of: "`", with: "")
    }
}
#endif
