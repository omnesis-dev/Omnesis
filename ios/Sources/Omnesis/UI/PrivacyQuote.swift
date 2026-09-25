// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// Words somebody else wrote, shown verbatim.
//
// A Privacy surface carries two kinds of text. Most of it is prose Omnesis
// wrote about an exchange: labels, explanations, the sentence saying what
// became of an answer. The rest is the exchange's own words — the request a
// caller made, the answer the agent drafted, the reviewer's summary, the text
// that actually left. The second kind is the evidence, and on a screen whose
// whole job is showing what crossed the trust boundary the reader should not
// have to infer which is which from where it sits on a card.
//
// So every verbatim run shares one surface and one face: an inset panel with a
// hairline border and a small radius, holding monospaced text. Everything
// quoted here is a recording of what some agent wrote, and one typewriter face
// across the request, the draft, the reviewer's summary and the released text
// says so before a word is read. The panel is deliberately not a rule down the
// left margin: the left edge of these screens already means which side of the
// boundary you are on, and a second vertical line there would compete with the
// spine.

@available(iOS 17.0, *)
enum PrivacyQuoteStyle {
    /// A translucent lift rather than a fixed colour: the same quote is drawn
    /// on the page background, on a card, and over a warning tint, and an opaque
    /// token would vanish against one of them. Compositing keeps the lift equal
    /// wherever it lands. It is slight by design — the panel has only to raise
    /// the quote off what it sits on, and anything stronger makes a screen of
    /// stacked quotations read as a screen of boxes.
    static let fill = Color(light: 0x1B1F23, dark: 0xFFFFFF, alpha: 0.025)
    static let border = Color(light: 0x1B1F23, dark: 0xFFFFFF, alpha: 0.06)
    static let radius = Theme.Radius.small
    /// Prose is inset from the panel on every side, so the quoted words sit in
    /// their own air rather than against the border.
    static let insets = EdgeInsets(
        top: Theme.Spacing.sm,
        leading: Theme.Spacing.sm,
        bottom: Theme.Spacing.sm,
        trailing: Theme.Spacing.sm
    )
    /// The comparison's rows carry a full-width tint that says which side of
    /// the diff they belong to, so the panel gives them vertical air only and
    /// lets the tint run to its edges.
    static let bleedInsets = EdgeInsets(
        top: Theme.Spacing.xs,
        leading: 0,
        bottom: Theme.Spacing.xs,
        trailing: 0
    )

    /// How far a quote's text sits below the size its surroundings use.
    ///
    /// A monospaced face sets wider than the body face at the same nominal
    /// size, so a quote set at parity reads heavier than the prose around it —
    /// the opposite of what a quotation should do. The step gives back the
    /// weight without making the words hard to read.
    static let sizeScale: CGFloat = 0.88

    /// The face for a quotation of prose, sized against the text it sits among.
    /// The comparison shares the face but sets its own size, since its lines
    /// are a grid rather than a paragraph inside somebody else's copy.
    static func font(_ contextSize: CGFloat) -> Font {
        Theme.monospace(size: contextSize * sizeScale)
    }
}

@available(iOS 17.0, *)
extension View {
    /// Draw this content as a quotation: text that came from outside this
    /// screen's own voice, reproduced exactly.
    ///
    /// - Parameters:
    ///   - insets: how far the content sits inside the panel.
    ///   - tint: replaces the neutral fill. Used for an answer held pending a
    ///     decision, where the wash is the hold, not the quotation.
    func privacyQuoteSurface(
        insets: EdgeInsets = PrivacyQuoteStyle.insets,
        tint: Color? = nil
    )
        -> some View {
        padding(insets)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint ?? PrivacyQuoteStyle.fill)
            .overlay {
                RoundedRectangle(cornerRadius: PrivacyQuoteStyle.radius)
                    .stroke(PrivacyQuoteStyle.border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: PrivacyQuoteStyle.radius))
    }
}

/// One quoted sentence or paragraph: the request a caller made, the reviewer's
/// summary of what it found.
@available(iOS 17.0, *)
struct PrivacyQuote: View {
    let text: String
    /// What a listener hears this quote called before they hear the words.
    let role: String
    /// The size of the prose this quote sits among; the quote is set a step
    /// below it.
    var size: CGFloat = 14

    var body: some View {
        Text(text)
            .font(PrivacyQuoteStyle.font(size))
            .foregroundStyle(Theme.textPrimary)
            .textSelection(.enabled)
            // A phone is narrower than a sentence: quoted words wrap here
            // rather than being cut off at the edge of the panel.
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.leading)
            .privacyQuoteSurface()
            // Short enough to be one utterance, and hearing "quoted" first is
            // the only cue a listener gets that these are not Omnesis's words.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Quoted \(role): \(text)")
    }
}

/// An answer, on the surfaces allowed to show one: the draft still inside the
/// machine, the answer held pending a decision, the text that left. Rendered as
/// markdown, because that is what an agent writes an answer in.
@available(iOS 17.0, *)
struct PrivacyAnswerBlock: View {
    let answer: String
    /// What a listener hears this answer called before they hear it.
    let role: String
    /// The size of the prose this answer sits among; the answer is set a step
    /// below it.
    var size: CGFloat = 14
    var tinted = false

    var body: some View {
        // Headings take the quote's face too, so an answer that carries one
        // does not read in two faces at once.
        MarkdownView(
            text: answer,
            bodyFont: PrivacyQuoteStyle.font(size),
            headingDesign: .monospaced
        )
        .textSelection(.enabled)
        .privacyQuoteSurface(tint: tinted ? Theme.warning.opacity(0.08) : nil)
        // An answer runs to paragraphs and lists, so they stay separately
        // navigable instead of being flattened into one long utterance;
        // the container's label is what marks the whole of it quoted.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Quoted \(role)")
    }
}

#if DEBUG
/// Prose against quotation, side by side, with every kind of quoted text these
/// screens show. Shared with the snapshot suite, which is where the contrast is
/// judged.
@available(iOS 17.0, *)
struct PrivacyQuoteGallery: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                label("Prose Omnesis wrote")
                Text("Omnesis removed details from this answer, then the external agent received the rest.")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                label("The request, quoted")
                PrivacyQuote(
                    text: PreviewMocks.privacyExchanges[0].question,
                    role: "question",
                    size: 16
                )
                label("The reviewer's summary, quoted")
                PrivacyQuote(
                    text: "The schedule summary is allowed, but the exact location requires approval.",
                    role: "privacy check summary",
                    size: 13
                )
                label("The draft, quoted")
                PrivacyAnswerBlock(answer: PreviewMocks.privacyLongDraftAnswer, role: "draft answer")
                label("An answer held pending a decision")
                PrivacyAnswerBlock(
                    answer: "The user is free on Thursday afternoon.",
                    role: "held answer",
                    tinted: true
                )
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.bgPrimary)
        .omnesisColorScheme()
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(Theme.textMuted)
    }
}

#Preview("Privacy quotes — prose against quotation") {
    PrivacyQuoteGallery()
}

#Preview("Privacy quotes — accessibility size") {
    PrivacyQuoteGallery()
        .environment(\.dynamicTypeSize, .accessibility3)
}
#endif

#endif
