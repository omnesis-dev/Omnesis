// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Content-first note cards follow the recent-document browser's reading order.
@available(iOS 17.0, *)
struct NoteHistoryRow: View {
    let note: NoteEntry

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text(note.text)
                .font(.body.weight(.medium))
                .lineSpacing(3)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text([note.capturedLabel, note.surfaceLabel].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.textSecondary)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold)).foregroundStyle(Theme.textMuted)
            }
            if note.transcription == "pending" {
                Label("Transcribing voice note", systemImage: "waveform")
                    .font(.caption).foregroundStyle(Theme.accent)
            }
            if let reply = note.agent?.receipt?.text, !reply.isEmpty {
                HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                    Image(systemName: "sparkles").foregroundStyle(Theme.accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Omnesis").font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                        Text(reply)
                            .font(.subheadline)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.caption)
            } else if note.transcription != "pending" {
                Label(note.statusLabel, systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(Theme.Spacing.lg)
        .padding(.leading, Theme.Spacing.xs)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.large))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .strokeBorder(Theme.borderLight.opacity(0.6), lineWidth: 0.5)
        }
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Theme.accent.opacity(0.85))
                .frame(width: 3)
                .padding(.vertical, Theme.Spacing.lg)
        }
        .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        .fixedSize(horizontal: false, vertical: true)
    }
}

@available(iOS 17.0, *)
struct NoteReadingHeader: View {
    let note: NoteEntry

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: "note.text")
                .font(.title2.weight(.light))
                .foregroundStyle(Theme.accent)
                .frame(width: 40, height: 44)
                .background(Theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: Theme.Radius.large))
            VStack(alignment: .leading, spacing: 6) {
                Text("Your note").font(.title2.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                Text(note.capturedLabel).font(.caption).foregroundStyle(Theme.textSecondary)
                let context = [note.surfaceLabel, note.placeName].compactMap { $0 }.joined(separator: " · ")
                if !context.isEmpty {
                    Text(context).font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@available(iOS 17.0, *)
struct NoteResponseCard: View {
    @Environment(\.openAgentConversation) private var openConversation
    let note: NoteEntry
    let undone: Set<Int>
    let busy: Bool
    let onUndo: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "sparkles")
                Text("Omnesis").fontWeight(.semibold)
                Spacer()
            }
            .font(.subheadline).foregroundStyle(Theme.accent)
            if note.transcription == "pending" {
                Label("Transcribing voice note", systemImage: "waveform")
                    .font(.caption).foregroundStyle(Theme.accent)
            }
            if let receipt = note.agent?.receipt {
                Text(receipt.text)
                    .font(.body)
                    .lineSpacing(4)
                    .foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)
                if let conversationId = receipt.conversationId, let openConversation {
                    Button { openConversation(conversationId) } label: {
                        Label("Open chat", systemImage: "bubble.left.and.bubble.right")
                            .frame(minHeight: Theme.tapTarget)
                    }
                }
                ForEach(Array(receipt.changes.enumerated()), id: \.offset) { _, change in
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Label(change.text, systemImage: "checkmark.circle")
                            .font(.subheadline).foregroundStyle(Theme.textSecondary)
                        if let seq = change.undoSeq {
                            Button(undone.contains(seq) ? "Undone" : "Undo change") { onUndo(seq) }
                                .font(.subheadline.weight(.medium))
                                .frame(minHeight: Theme.tapTarget, alignment: .leading)
                                .disabled(busy || undone.contains(seq))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                if note.agent?.state == "pending" || note.agent?.state == "running" {
                    HStack(spacing: Theme.Spacing.sm) {
                        ProgressView().controlSize(.small).tint(Theme.accent)
                        Text(note.agent?.statusLabel ?? "Saved").font(.subheadline).foregroundStyle(Theme.textSecondary)
                    }
                } else {
                    Text(note.agent == nil ? "No agent response is recorded for this note." : (note.agent?.statusLabel ?? "Saved"))
                        .font(.subheadline).foregroundStyle(Theme.textSecondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.lg)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.large))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .strokeBorder(Theme.borderLight.opacity(0.6), lineWidth: 0.5)
        }
    }
}

#if DEBUG
#Preview("Note reading surfaces") {
    ScrollView {
        VStack(spacing: Theme.Spacing.md) {
            ForEach(PreviewMocks.noteHistory) { NoteHistoryRow(note: $0) }
            NoteResponseCard(note: PreviewMocks.noteHistory[0], undone: [], busy: false) { _ in }
        }
        .padding(Theme.Spacing.lg)
    }
    .background(Theme.bgPrimary.ignoresSafeArea())
}
#endif
#endif
