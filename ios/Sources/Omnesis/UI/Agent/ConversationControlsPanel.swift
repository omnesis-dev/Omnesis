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

    private var hasContent: Bool {
        controls?.pendingClarification != nil
            || controls?.queuedMessages.contains(where: { $0.status == "failed" }) == true
            || error != nil
    }

    var body: some View {
        if hasContent {
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
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .disabled(disabled)
                }
            }
            ForEach(controls?.queuedMessages.filter { $0.status == "failed" } ?? []) { message in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.circle")
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Couldn’t send")
                            .font(.caption.weight(.semibold))
                        Text(message.text).font(.caption).lineLimit(2)
                        if let error = message.error { Text(error).font(.caption) }
                    }
                    Spacer(minLength: 0)
                }
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                    Button("Edit and resend", systemImage: "square.and.pencil") { onEdit(message) }.disabled(disabled)
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(Theme.danger) }
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@available(iOS 17.0, *)
struct ConversationQueuedBubble: View {
    let controls: ConversationControls
    let disabled: Bool
    let onSendNow: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            ForEach(Array(controls.queuedBubbleTexts.enumerated()), id: \.offset) { _, text in
                VStack(alignment: .trailing, spacing: 4) {
                    AgentTurnBubble(turn: .user(id: "queued", text: text))
                    Text("Queued").font(.caption).foregroundStyle(Theme.textSecondary)
                }
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
                    if controls.capabilities?.queueSendNow == true {
                        Button("Send now", systemImage: "paperplane", action: onSendNow).disabled(disabled)
                    }
                }
            }
        }
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
#Preview("Conversation choices") {
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
