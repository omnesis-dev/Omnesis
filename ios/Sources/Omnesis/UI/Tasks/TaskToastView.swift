// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// MARK: - Toast

/// What just changed, with Undo when it can be undone. Hides itself after a
/// few seconds; VoiceOver reads it out when it appears.
@available(iOS 17.0, *)
struct TaskToastView: View {
    let toast: TaskToast
    let onUndo: () -> Void
    let onDismiss: () -> Void

    static let visibleSeconds: UInt64 = 5

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            if toast.isError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                    .accessibilityHidden(true)
            }
            Text(toast.text)
                .font(.subheadline)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            if toast.undoSeq != nil {
                Button("Undo", action: onUndo)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(minHeight: Theme.tapTarget)
            } else {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                }
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(.leading, Theme.Spacing.lg)
        .padding(.trailing, Theme.Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: 14).fill(Theme.bgTertiary)
                .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        )
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .task(id: toast.id) {
            AccessibilityNotification.Announcement(toast.text).post()
            try? await Task.sleep(nanoseconds: Self.visibleSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            onDismiss()
        }
    }
}
#endif
