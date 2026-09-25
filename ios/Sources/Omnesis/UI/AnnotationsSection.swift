// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The agent's durable LLM annotations for a document or person, rendered as
/// a flat section. Person annotations (about a person) and document
/// annotations (grounded on a document) share the same wire shape
/// (`Annotation`), so one view serves both — the caller supplies the
/// sentence `title` ("Enriched by Omnesis", "Profile", or "What Omnesis has
/// learned about <name>"). Mirrors the portal's `AnnotationList`.
///
/// Confidence is surfaced verbatim: these are defeasible observations, not
/// hard facts. Renders nothing only when `annotations` is definitively empty;
/// paging progress, retry, and truncation states remain visible. v1 is
/// read-only text — there is no deep-link into the evidence document.
@available(iOS 17.0, *)
struct AnnotationsSection: View {
    let title: String
    let annotations: [Annotation]
    var paging = CursorPagingState()
    var onLoadMore: () -> Void = {}

    var body: some View {
        if shouldShowPagedContent(itemCount: annotations.count, paging: paging) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                header
                ForEach(Array(annotations.enumerated()), id: \.element.id) { idx, annotation in
                    row(annotation)
                    if idx < annotations.count - 1 {
                        Divider().background(Theme.borderLight)
                    }
                }
                ListPagingFooter(
                    state: paging,
                    label: "Load more annotations",
                    retry: onLoadMore
                )
            }
        }
    }

    /// A bespoke header rather than `FlatSectionHeader`: the latter
    /// force-uppercases its title and appends a full-width rule, which mangles
    /// a sentence title like "What Omnesis has learned about Maya Reeves". The
    /// sparkle marks the section as Omnesis-derived (agent) data, distinct
    /// from source-provided fields.
    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .font(.system(size: 12))
                .foregroundStyle(Theme.accent)
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(2)
        }
        .padding(.top, Theme.Spacing.md)
    }

    private func row(_ a: Annotation) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(a.claimType)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                if let basis = a.claimBasis, !basis.isEmpty {
                    Text(basis)
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textMuted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Theme.bgTertiary)
                        .clipShape(Capsule())
                }
                Spacer(minLength: 6)
                if let verification = verificationLabel(a) {
                    Text(verification)
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.textMuted)
                }
                Text("\(Int((a.confidence * 100).rounded()))%")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .monospacedDigit()
            }
            Text(a.claimText)
                .font(.system(size: 13))
                .foregroundStyle(Theme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if let quote = a.evidenceQuote, !quote.isEmpty {
                Text("“\(quote)”")
                    .font(.system(size: 12))
                    .italic()
                    .foregroundStyle(Theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Theme.Spacing.sm)
    }

    /// Entailment-check marker: "verified · 2d ago" when the last check time
    /// is known, the bare state otherwise, nil when the row carries no stamp.
    private func verificationLabel(_ a: Annotation) -> String? {
        guard let state = a.verificationState, !state.isEmpty else { return nil }
        if let ago = formatTimeAgo(a.lastVerifiedAt) {
            return "\(state) · \(ago)"
        }
        return state
    }
}

#if DEBUG
@available(iOS 17.0, *)
private func annotationsPreview(title: String, annotations: [Annotation]) -> some View {
    ScrollView {
        AnnotationsSection(title: title, annotations: annotations)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.lg)
    }
    .background(Theme.bgPrimary.ignoresSafeArea())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Annotations — document (Enriched by Omnesis)") {
    annotationsPreview(title: "Enriched by Omnesis", annotations: PreviewMocks.documentAnnotations)
}

@available(iOS 17.0, *)
#Preview("Annotations — person self (Profile)") {
    annotationsPreview(title: "Profile", annotations: PreviewMocks.personAnnotations)
}

@available(iOS 17.0, *)
#Preview("Annotations — person other (learned about)") {
    annotationsPreview(
        title: "What Omnesis has learned about Maximilian Aurelius Bartholomew Hawthorne-Featherstonehaugh",
        annotations: PreviewMocks.personAnnotations
    )
}
#endif
#endif
