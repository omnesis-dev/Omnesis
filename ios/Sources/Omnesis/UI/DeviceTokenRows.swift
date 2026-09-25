// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// The credential rows a device card (`DevicesView.swift`) expands into: one
// token per row with its scopes, and the wrapped scope-chip strip they share.

// MARK: - One token row

@available(iOS 17.0, *)
struct TokenRow: View {
    let token: TokenRecord
    /// Revoke this token. `nil` hides the affordance (read-only / busy).
    var onRevoke: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Image(systemName: "key.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
                Text(token.name?.isEmpty == false ? token.name! : "unlabeled")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(token.name?.isEmpty == false ? Theme.textPrimary : Theme.textMuted)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let onRevoke {
                    Button(role: .destructive, action: onRevoke) {
                        Text("Revoke")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.danger)
                    }
                    .buttonStyle(.plain)
                }
            }
            if !token.scopes.isEmpty {
                ScopeChipRow(scopes: token.scopes)
            }
            HStack(spacing: Theme.Spacing.md) {
                Text("created \(formatUnixMillisAgo(token.createdAt))")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
                Text("used \(token.lastUsedAt.map(formatUnixMillisAgo) ?? "never")")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(Theme.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgTertiary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }
}

/// Wrapped row of scope chips. Scope strings are the gateway's canonical
/// vocabulary (`read`, `admin`, `write:*`, `write:<type>`, …) — rendered
/// verbatim so the labels match the portal's `ScopeChip`.
@available(iOS 17.0, *)
struct ScopeChipRow: View {
    let scopes: [String]

    var body: some View {
        FlowLayout(spacing: 5) {
            ForEach(scopes, id: \.self) { scope in
                Text(scope)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(ScopeChipRow.isAdmin(scope) ? Theme.accentHover : Theme.textSecondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(ScopeChipRow.isAdmin(scope) ? Theme.accent.opacity(0.15) : Theme.bgSecondary)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.small)
                            .stroke(Theme.border, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.small))
            }
        }
    }

    /// `admin` gets the accent tint — it's the
    /// elevated scopes, matching the portal's emphasis.
    private static func isAdmin(_ scope: String) -> Bool {
        scope == "admin" || scope.hasPrefix("admin:")
    }
}
#endif
