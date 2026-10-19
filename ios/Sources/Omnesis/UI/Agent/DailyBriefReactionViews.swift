// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Sends one reaction to a brief item: its observation id, the reaction
/// (nil clears) and the words given with it. Returns whether the gateway
/// took it.
@available(iOS 17.0, *)
typealias DailyBriefReactionHandler = (
    _ observationId: String,
    _ reaction: DailyBriefReaction.Kind?,
    _ note: String?
)
    -> Bool

/// The thumbs under a brief item. Up is one tap, and a second tap clears
/// it. Down asks which kind of wrong: "Not interested" stands at once and
/// then offers the Tell Omnesis screen for optional words; "Factual error"
/// opens that screen for the correction and stands on Done or Cancel alike.
/// A down reaction shows its kind, and the words, as a caption; a reaction
/// the gateway refused is put back with a one-line reason.
@available(iOS 17.0, *)
struct DailyBriefReactionBar: View {
    let item: DailyBriefItem
    let failure: (any Error)?
    let onReact: DailyBriefReactionHandler

    @State private var askingWhyNot = false
    @State private var capture: Capture?
    /// A correction chosen but not yet sent: its screen closing without
    /// Done sends it without words.
    @State private var correctionPending = false

    /// The Tell Omnesis screen open for one reaction.
    private struct Capture: Identifiable {
        enum Purpose { case whyNot, correction }

        let id = UUID()
        let purpose: Purpose
    }

    private var kind: DailyBriefReaction.Kind? {
        item.reaction?.kind
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                thumb(
                    up: true,
                    selected: kind == .up,
                    label: "Useful",
                    identifier: "dailyBrief.thumbsUp.\(item.observationId)"
                ) {
                    Task { await onReact(item.observationId, kind == .up ? nil : .up, nil) }
                }
                thumb(
                    up: false,
                    selected: kind == .notInterested || kind == .factualError,
                    label: "Not useful",
                    identifier: "dailyBrief.thumbsDown.\(item.observationId)"
                ) {
                    if kind == .notInterested || kind == .factualError {
                        Task { await onReact(item.observationId, nil, nil) }
                    } else {
                        askingWhyNot = true
                    }
                }
                if let caption {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 4)
                        .accessibilityIdentifier("dailyBrief.reaction.\(item.observationId)")
                }
            }
            if let failure {
                let reason = GatewayErrorView.classify(failure)
                Label("Not saved — \(reason.title.lowercased())", systemImage: reason.symbol)
                    .font(.caption)
                    .foregroundStyle(reason.tint)
                    .accessibilityIdentifier("dailyBrief.reactionFailed.\(item.observationId)")
            }
        }
        .confirmationDialog("Not useful", isPresented: $askingWhyNot, titleVisibility: .visible) {
            Button("Not interested in this kind of thing") {
                Task { await onReact(item.observationId, .notInterested, nil) }
                capture = Capture(purpose: .whyNot)
            }
            Button("Factual error — send a correction") {
                correctionPending = true
                capture = Capture(purpose: .correction)
            }
            Button("Cancel", role: .cancel) {}
        }
        .fullScreenCover(item: $capture, onDismiss: closedCapture) { capture in
            CaptureView(completion: completion(for: capture))
        }
    }

    private var caption: String? {
        guard let reaction = item.reaction else { return nil }
        let name: String
        switch reaction.kind {
        case .up: return nil
        case .notInterested: name = "Not interested"
        case .factualError: name = "Factual error"
        }
        guard let note = reaction.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty else {
            return name
        }
        return "\(name) — \(note)"
    }

    private func thumb(
        up: Bool,
        selected: Bool,
        label: String,
        identifier: String,
        action: @escaping () -> Void
    )
        -> some View {
        let symbol = (up ? "hand.thumbsup" : "hand.thumbsdown") + (selected ? ".fill" : "")
        return Button(action: action) {
            Image(systemName: symbol)
                .font(.footnote)
                .foregroundStyle(selected ? Theme.accent : Theme.textMuted)
                // Grows with the text size, so scaled glyphs never touch.
                .frame(minWidth: 32, minHeight: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier(identifier)
    }

    private func completion(for capture: Capture) -> NoteCaptureCompletion {
        switch capture.purpose {
        case .whyNot:
            .explainingDisinterest(item.summary) { note in
                await onReact(item.observationId, .notInterested, note)
            }
        case .correction:
            .correcting(item.summary) { note in
                let took = await onReact(item.observationId, .factualError, note)
                if took { correctionPending = false }
                return took
            }
        }
    }

    /// A correction cancelled still stands, without words. "Not interested"
    /// was sent before its screen opened, so cancelling it changes nothing.
    private func closedCapture() {
        guard correctionPending else { return }
        correctionPending = false
        Task { await onReact(item.observationId, .factualError, nil) }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Brief item reactions — every state") {
    VStack(alignment: .leading, spacing: 20) {
        ForEach(PreviewMocks.dailyBriefReactionStates, id: \.item.observationId) { state in
            DailyBriefReactionBar(item: state.item, failure: state.failure) { _, _, _ in true }
        }
    }
    .padding()
    .background(Theme.bgSecondary)
}
#endif
#endif
