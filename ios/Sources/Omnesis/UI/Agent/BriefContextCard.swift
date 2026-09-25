// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The brief a talk-back thread replies to, rendered as a card pinned
/// above the conversation. The thread's seeded run transcript is hidden
/// from the UI (agent context, not user content), so this card is what
/// tells the reader "you are replying to this" — including after the
/// brief itself has expired or been dismissed, because the content is a
/// snapshot taken when the thread was opened, not a live fetch.
///
/// Deliberately card-like: it reuses the brief feed's visual vocabulary
/// (title / description / long-form body) inside a bordered, filled
/// container so it reads as an artifact, not as a chat bubble. Citations
/// are intentionally absent — the sources live on the brief in the feed;
/// the thread is about the content.
@available(iOS 17.0, *)
struct BriefContextCard: View {
    let snapshot: BriefOriginSnapshot

    /// Collapsed by default when a long-form body exists — the reader
    /// usually needs the title + description to re-anchor, and can unfold
    /// the full content on demand without scrolling past it every time.
    @State private var bodyExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 12, weight: .semibold))
                Text("Brief")
                    .font(.system(size: 12, weight: .semibold))
                    .textCase(.uppercase)
                    .kerning(0.6)
            }
            .foregroundStyle(Theme.accent)
            Text(snapshot.title)
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(Theme.textPrimary)
            MarkdownView(text: snapshot.description, bodyFont: .system(size: 15))
            if let bodyText = snapshot.body, !bodyText.isEmpty {
                Divider()
                if bodyExpanded {
                    MarkdownView(text: bodyText, bodyFont: .system(size: 14))
                }
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { bodyExpanded.toggle() }
                } label: {
                    HStack(spacing: Theme.Spacing.xs) {
                        Text(bodyExpanded ? "Hide details" : "Show details")
                        Image(systemName: bodyExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(bodyExpanded ? "Hide the brief's details" : "Show the brief's details")
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Theme.bgSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Theme.border, lineWidth: 0.5)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Brief: \(snapshot.title)")
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("BriefContextCard — description only") {
    BriefContextCard(
        snapshot: BriefOriginSnapshot(
            title: "Return the borrowed projector",
            description: "You told **Maya** you'd bring the projector back to Studio Northstar this week.",
            body: nil
        )
    )
    .padding()
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("BriefContextCard — collapsed body") {
    BriefContextCard(
        snapshot: BriefOriginSnapshot(
            title: "Marathon entry closes Friday 17 Oct",
            description: "The **marathon** early-bird entry closes on Friday — you said you wanted in this year.",
            body: PreviewMocks.briefLongBody
        )
    )
    .padding()
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("BriefContextCard — long title, dark") {
    BriefContextCard(
        snapshot: BriefOriginSnapshot(
            title: "Confirm the Q4 budget review agenda with Jamie Lopez before Thursday's planning meeting",
            description: "Jamie asked for the agenda by **Thursday 09:00** and the shared doc still has last quarter's items.",
            body: "The draft agenda lives in the shared planning doc. Jamie flagged two carry-overs:\n\n- Headcount for the platform team\n- The vendor renewal for Stellar Sound\n\nBoth need a number attached before the meeting."
        )
    )
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}
#endif
#endif
