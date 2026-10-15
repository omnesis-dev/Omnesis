// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The top of Today when Omnesis has suggestions waiting: one tap opens the
/// Suggested view. Dressed like the home screen's access-request banner —
/// the app's one treatment for "something is waiting for you".
@available(iOS 17.0, *)
struct TaskReviewBanner: View {
    let text: String
    let onReview: () -> Void

    var body: some View {
        Button(action: onReview) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Theme.accent)
                    .accessibilityHidden(true)
                Text(text)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Review")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, 12)
            .frame(minHeight: Theme.tapTarget)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.large).fill(Theme.bgSecondary))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.large).stroke(Theme.borderLight, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
        .accessibilityHint("Opens the Suggested view")
        .accessibilityAddTraits(.isButton)
    }
}

/// The reminder that tasks are added by telling Omnesis, with "Tell
/// Omnesis" opening the same capture as the menu's Tell Omnesis entry.
@available(iOS 17.0, *)
struct TaskCaptureHint: View {
    @Environment(\.openCapture) private var openCapture

    private static let captureURL = URL(string: "omnesis-tasks://tell-omnesis")!

    var body: some View {
        Text(line)
            .font(.footnote)
            .foregroundStyle(Theme.textMuted)
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
            .environment(\.openURL, OpenURLAction { url in
                guard url == Self.captureURL else { return .systemAction }
                openCapture?()
                return .handled
            })
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Use Tell Omnesis to add tasks.")
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Opens Tell Omnesis")
            .accessibilityAction { openCapture?() }
    }

    private var line: AttributedString {
        var link = AttributedString("Tell Omnesis")
        link.link = Self.captureURL
        link.foregroundColor = Theme.accent
        link.font = .footnote.weight(.semibold)
        return AttributedString("Use ") + link + AttributedString(" to add tasks.")
    }
}
#endif
