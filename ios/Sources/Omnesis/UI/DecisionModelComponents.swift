// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// Small building blocks the Decision model screens share, styled like the
// Models and Backends screens' cards, fields and outlined buttons.

@available(iOS 17.0, *)
extension View {
    /// The Models screens' card: secondary background, hairline border.
    func decisionCard() -> some View {
        padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bgSecondary)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.large).stroke(Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }
}

/// A group title above a run of cards.
@available(iOS 17.0, *)
struct DecisionSectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Theme.textSecondary)
            .textCase(.uppercase)
            .tracking(0.4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// An outlined button in the accent (or danger) colour.
@available(iOS 17.0, *)
struct DecisionOutlineButton: View {
    let title: String
    var color: Color = Theme.accent
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(color)
                }
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(color)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, 7)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.medium).stroke(color.opacity(0.5), lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A one-line outcome: a check or a warning sign, then the text as written.
@available(iOS 17.0, *)
struct DecisionResultLine: View {
    let ok: Bool
    let text: String

    var body: some View {
        Label {
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(ok ? Theme.success : Theme.danger)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        } icon: {
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.system(size: 13))
                .foregroundStyle(ok ? Theme.success : Theme.danger)
        }
    }
}

/// A labelled text field with an optional error under it.
@available(iOS 17.0, *)
struct DecisionTextField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .default
    var secure = false
    var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            Group {
                if secure {
                    SecureField(placeholder, text: $text)
                } else {
                    TextField(placeholder, text: $text)
                        .keyboardType(keyboard)
                }
            }
            .font(.system(size: 14))
            .foregroundStyle(Theme.textPrimary)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(Theme.Spacing.sm)
            .background(Theme.bgSecondary)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.medium)
                    .stroke(error == nil ? Theme.border : Theme.danger.opacity(0.6), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
            if let error {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.danger)
            }
        }
    }
}
#endif
