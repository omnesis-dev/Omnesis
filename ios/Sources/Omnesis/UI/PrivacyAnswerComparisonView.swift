// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// What Omnesis drafted, against what actually left.
//
// The decision card lists the reductions the reviewer says it made, which is a
// claim; this is the two strings themselves. Every distinction it draws is
// carried by a shape as well as a hue — a marker in a fixed-width column for
// the side a line belongs to, a strike or an underline for the words that
// changed within a line — so the block reads on a greyscale screen and for a
// reader who cannot separate red from green. The hues chosen are red and blue
// rather than the customary red and green for the same reason.
//
// It is quoted text, so it sits on the shared quotation panel in the same
// fixed-width face every quotation on these screens uses. Here the face is also
// load-bearing: the marker column and the spans inside a line only stay aligned
// if every character occupies the same width, so this block sets its own size
// rather than stepping down from the prose around it.

@available(iOS 17.0, *)
enum PrivacyAnswerDiffStyle {
    /// The draft-only side. Also the app's danger red, which is the point: this
    /// is the text that did not leave.
    static let removed = Color(light: 0xCF222E, dark: 0xF85149)
    /// The sent side. Blue is the one hue that separates from red under every
    /// common form of colour blindness, and it belongs to no outcome chip, so it
    /// reads as "these are the words that went" rather than as a status.
    static let added = Color(light: 0x0969DA, dark: 0x79C0FF)
    /// The row's tint says which side it is; the span's tint says which words
    /// moved. The span sits above the row, so it is the stronger of the two.
    static let rowTintOpacity: Double = 0.1
    static let spanTintOpacity: Double = 0.22
    static let markerWidth: CGFloat = 11
    static let lineSize: CGFloat = 11
    /// A removed blank line is a removal. Without a floor its row would collapse
    /// to nothing and the marker beside it would be the only evidence.
    static let minRowHeight: CGFloat = 14
}

/// A release's comparison against the draft it came from, or the sentence that
/// stands in when there is no comparison to draw.
@available(iOS 17.0, *)
struct PrivacyAnswerComparisonSection: View {
    let comparison: PrivacyAnswerComparison

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(copy.title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if let detail = copy.detail {
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if case .diff(let lines) = comparison {
                legend(lines)
                diff(lines)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var copy: PrivacyAnswerComparisonCopy {
        privacyAnswerComparisonCopy(comparison)
    }

    private func legend(_ lines: [PrivacyAnswerDiffLine]) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(privacyAnswerDiffLegend(lines), id: \.self) { entry in
                Text(entry)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func diff(_ lines: [PrivacyAnswerDiffLine]) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            // Two lines of a comparison can be identical text on opposite
            // sides, so position is the identity here, not content.
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                PrivacyAnswerDiffRow(line: line)
            }
        }
        // Both sides of the comparison are text the machine produced, quoted
        // line by line — so it wears the same panel and face as every other
        // quotation here, with its rows left free to run to the edges.
        .privacyQuoteSurface(insets: PrivacyQuoteStyle.bleedInsets)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Quoted comparison of the draft and what was shared")
    }
}

/// One line of the comparison. The marker column is fixed-width so a wrapped
/// line's continuation sits under the text rather than under the marker.
@available(iOS 17.0, *)
private struct PrivacyAnswerDiffRow: View {
    let line: PrivacyAnswerDiffLine

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.xs) {
            Text(privacyAnswerDiffMarker(line.op))
                .font(Theme.monospace(size: PrivacyAnswerDiffStyle.lineSize, weight: .semibold))
                .foregroundStyle(markerColor)
                .frame(width: PrivacyAnswerDiffStyle.markerWidth, alignment: .center)
            Text(rendered)
                .font(Theme.monospace(size: PrivacyAnswerDiffStyle.lineSize))
                .foregroundStyle(Theme.textPrimary)
                // A phone is narrower than an answer's lines: they wrap here
                // rather than being cut off at the edge of the card.
                .fixedSize(horizontal: false, vertical: true)
                .frame(
                    maxWidth: .infinity,
                    minHeight: PrivacyAnswerDiffStyle.minRowHeight,
                    alignment: .leading
                )
        }
        .padding(.horizontal, Theme.Spacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(rowTint)
        // The marker and the decorations are shapes on a screen; a listener gets
        // the same distinctions as words.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(privacyAnswerDiffLineLabel(line))
    }

    /// The line's spans, decorated. Whitespace is a change like any other, so
    /// the decoration and the tint run through it — a span of spaces is a
    /// visible mark rather than nothing at all.
    private var rendered: AttributedString {
        guard let spans = line.spans else { return AttributedString(line.text) }
        var result = AttributedString()
        for span in spans {
            var piece = AttributedString(span.text)
            switch span.op {
            case .equal:
                break
            case .removed:
                piece.strikethroughStyle = .single
                piece.foregroundColor = PrivacyAnswerDiffStyle.removed
                piece.backgroundColor = PrivacyAnswerDiffStyle.removed
                    .opacity(PrivacyAnswerDiffStyle.spanTintOpacity)
            case .added:
                piece.underlineStyle = .single
                piece.foregroundColor = PrivacyAnswerDiffStyle.added
                piece.backgroundColor = PrivacyAnswerDiffStyle.added
                    .opacity(PrivacyAnswerDiffStyle.spanTintOpacity)
            }
            result.append(piece)
        }
        return result
    }

    private var markerColor: Color {
        switch line.op {
        case .equal: Theme.textMuted
        case .removed: PrivacyAnswerDiffStyle.removed
        case .added: PrivacyAnswerDiffStyle.added
        }
    }

    private var rowTint: Color {
        switch line.op {
        case .equal: .clear
        case .removed: PrivacyAnswerDiffStyle.removed
            .opacity(PrivacyAnswerDiffStyle.rowTintOpacity)
        case .added: PrivacyAnswerDiffStyle.added
            .opacity(PrivacyAnswerDiffStyle.rowTintOpacity)
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
private struct PrivacyAnswerComparisonHarness: View {
    let comparison: PrivacyAnswerComparison

    var body: some View {
        ScrollView {
            PrivacyAnswerComparisonSection(comparison: comparison)
                .padding(Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary)
        .omnesisColorScheme()
    }
}

#Preview("Answer comparison — reduced") {
    PrivacyAnswerComparisonHarness(comparison: PreviewMocks.privacyAnswerDiff)
}

#Preview("Answer comparison — unchanged") {
    PrivacyAnswerComparisonHarness(comparison: .identical)
}

#Preview("Answer comparison — not comparable") {
    PrivacyAnswerComparisonHarness(comparison: .noDiff(reason: .dissimilar))
}

#Preview("Answer comparison — too large") {
    PrivacyAnswerComparisonHarness(comparison: .noDiff(reason: .tooLarge))
}

/// The same four states where an operator actually meets them: on the spine,
/// under the release step they belong to.
@available(iOS 17.0, *)
private struct PrivacyComparisonRecordHarness: View {
    let comparison: PrivacyAnswerComparison

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                ForEach(PreviewMocks.privacyComparisonEvents(comparison)) { event in
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        PrivacyMomentLabel(at: event.createdAt)
                        PrivacyLedgerStep(event: event)
                    }
                }
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.bgPrimary)
        .omnesisColorScheme()
    }
}

#Preview("Record — release compared with the draft") {
    PrivacyComparisonRecordHarness(comparison: PreviewMocks.privacyAnswerDiff)
}

#Preview("Record — release unchanged from the draft") {
    PrivacyComparisonRecordHarness(comparison: .identical)
}

#Preview("Record — release not comparable") {
    PrivacyComparisonRecordHarness(comparison: .noDiff(reason: .dissimilar))
}

#Preview("Record — release too large to compare") {
    PrivacyComparisonRecordHarness(comparison: .noDiff(reason: .tooLarge))
}
#endif

#endif
