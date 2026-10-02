// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SwiftUI

#if canImport(UIKit)

@available(iOS 17.0, *)
struct ConversationControlsPanel: View {
    let controls: ConversationControls?
    let error: String?
    let disabled: Bool
    var onEdit: (ConversationQueuedMessage) -> Void = { _ in }
    let onChoice: (String) -> Void

    var body: some View {
        if controls?.pendingClarification != nil || !(controls?.queuedMessages.isEmpty ?? true) || error != nil {
            ViewThatFits(in: .vertical) {
                contents.fixedSize(horizontal: false, vertical: true)
                ScrollView { contents }
            }
            .frame(maxHeight: 280)
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, Theme.Spacing.md)
            .background(Theme.bgPrimary)
        }
    }

    private var contents: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let question = controls?.pendingClarification {
                Text(question.question).font(.subheadline.weight(.semibold))
                ForEach(Array(question.choices.enumerated()), id: \.offset) { _, choice in
                    Button { onChoice(choice.label) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(choice.label).font(.subheadline.weight(.medium))
                            if let description = choice.description {
                                Text(description).font(.caption).foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 8))
                    }
                    .disabled(disabled)
                }
                Text("Or write your own answer below.").font(.caption).foregroundStyle(Theme.textSecondary)
            }
            ForEach(controls?.queuedMessages ?? []) { message in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: message.status == "failed" ? "exclamationmark.circle" : "clock")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(message.status == "failed" ? "Couldn’t send" : "Queued follow-up")
                            .font(.caption.weight(.semibold))
                        Text(message.text).font(.caption).lineLimit(2)
                        if let error = message.error { Text(error).font(.caption) }
                    }
                    Spacer(minLength: 0)
                    if message.status == "failed" {
                        Button("Edit") { onEdit(message) }.disabled(disabled)
                    }
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
        .padding(.vertical, controls?.pendingClarification != nil || !(controls?.queuedMessages.isEmpty ?? true) || error != nil ? 8 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@available(iOS 17.0, *)
struct ConversationDraftEditBanner: View {
    let onCancel: () -> Void
    var body: some View {
        HStack {
            Text("Editing a copy").font(.caption)
            Spacer()
            Button("Cancel edit", action: onCancel).font(.caption)
        }
        .foregroundStyle(Theme.textSecondary)
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 8)
        .background(Theme.bgPrimary)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Conversation edit draft") {
    ConversationDraftEditBanner(onCancel: {})
}

@available(iOS 17.0, *)
#Preview("Conversation choices and queue") {
    ConversationControlsPanel(
        controls: PreviewMocks.conversationControls, error: nil, disabled: false, onChoice: { _ in }
    )
}

@available(iOS 17.0, *)
#Preview("Conversation submission failure") {
    ConversationControlsPanel(
        controls: nil,
        error: "Message not confirmed. Retry to check delivery.",
        disabled: false,
        onChoice: { _ in }
    )
}
#endif

#endif
