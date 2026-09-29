// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// What left the machine, set against what Omnesis drafted: the answer text and
// the documents cited beside it.
//
// Free of SwiftUI for the same reason as the rest of the Privacy vocabulary:
// the wording and the comparison rules are unit tested in the sim-less lane.

// MARK: - The released answer, against the draft

/// The heading a release's comparison carries, and the sentence under it.
struct PrivacyAnswerComparisonCopy: Equatable, Sendable {
    let title: String
    let detail: String?
}

/// What the record may say about how a release relates to the draft it came
/// from. Every branch describes the comparison rather than the answer: Omnesis
/// declining to present a change as an edit is a statement about what it was
/// willing to compute, not a finding about what the answer says.
func privacyAnswerComparisonCopy(
    _ comparison: PrivacyAnswerComparison
)
    -> PrivacyAnswerComparisonCopy {
    switch comparison {
    case .identical:
        PrivacyAnswerComparisonCopy(
            title: "This answer left exactly as drafted.",
            detail: nil
        )
    case .diff:
        PrivacyAnswerComparisonCopy(
            title: "Compared with the draft",
            detail: nil
        )
    case .noDiff(.dissimilar):
        PrivacyAnswerComparisonCopy(
            title: "No line-by-line comparison",
            detail: "Omnesis did not present this release as an edit of the draft, "
                + "so the released answer is shown in full above."
        )
    case .noDiff(.tooLarge):
        PrivacyAnswerComparisonCopy(
            title: "No line-by-line comparison",
            detail: "These answers are longer than this comparison runs on, "
                + "so the released answer is shown in full above."
        )
    case .noDiff(.unspecified):
        PrivacyAnswerComparisonCopy(
            title: "No line-by-line comparison",
            detail: "Omnesis produced no comparison for this release, "
                + "so the released answer is shown in full above."
        )
    }
}

/// The marker that carries draft-only versus sent without colour. Rendered in a
/// fixed-width column, so the two glyphs line up whatever font resolves.
func privacyAnswerDiffMarker(_ op: PrivacyAnswerDiffOp) -> String {
    switch op {
    case .equal: " "
    case .removed: "−"
    case .added: "+"
    }
}

/// The key to the markers, and — only where some line carries a word-level
/// breakdown — to the decorations inside those lines. Both encodings are
/// legible without colour, so the key explains shapes rather than hues.
func privacyAnswerDiffLegend(_ lines: [PrivacyAnswerDiffLine]) -> [String] {
    var entries = ["− in the draft only", "+ in what was sent"]
    if lines.contains(where: { $0.spans != nil }) {
        entries.append("struck-through and underlined words are the change inside a line")
    }
    return entries
}

/// What a listener hears for one line. Draft-only versus sent is spoken, never
/// left to the marker or the colour, and a line that is nothing but spacing is
/// announced rather than passed over in silence — a release that dropped a
/// blank line dropped something.
func privacyAnswerDiffLineLabel(_ line: PrivacyAnswerDiffLine) -> String {
    let body = privacyAnswerDiffSpokenText(line.text)
    switch line.op {
    case .equal:
        return "Unchanged. \(body)"
    case .removed:
        guard let changed = privacyAnswerDiffChangeSummary(line, op: .removed) else {
            return "In the draft only. \(body)"
        }
        return "Draft line. \(body) Removed: \(changed)."
    case .added:
        guard let changed = privacyAnswerDiffChangeSummary(line, op: .added) else {
            return "In what was sent only. \(body)"
        }
        return "Sent line. \(body) Added: \(changed)."
    }
}

private func privacyAnswerDiffSpokenText(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Blank line." : text
}

/// The changed words of one side, spoken. A run of spaces has no spoken form,
/// so it is named instead of read out: dropping it would hide a change that is
/// exactly that.
private func privacyAnswerDiffChangeSummary(
    _ line: PrivacyAnswerDiffLine,
    op: PrivacyAnswerDiffOp
)
    -> String? {
    guard let spans = line.spans else { return nil }
    let changed = spans.filter { $0.op == op }
    guard !changed.isEmpty else { return nil }
    return changed
        .map { span in
            let spoken = span.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return spoken.isEmpty ? "spacing" : spoken
        }
        .joined(separator: ", ")
}

// MARK: - Cited documents

/// A citation field the privacy check may withhold on its own.
enum PrivacyCitationField: Equatable, Sendable {
    case title
    case timestamp
    case sourceUrl
    case appUrl

    func value(in citation: AnswerCitation) -> String? {
        let value = switch self {
        case .title: citation.title
        case .timestamp: citation.timestamp
        case .sourceUrl: citation.sourceUrl
        case .appUrl: citation.appUrl
        }
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// One link printed in full. `openURLs` is the order to try when it is
/// tapped, empty when it is not tappable: a withheld link never is, and
/// neither is a link this app does not hand off.
struct PrivacyCitationLink: Equatable, Sendable {
    let label: String
    let text: String
    /// This field alone was withheld from a citation the answer kept, so the
    /// link is printed from the draft and tagged.
    let withheld: Bool
    /// Struck through: the field was withheld, or the whole citation was.
    let struck: Bool
    let openURLs: [URL]
}

struct PrivacyCitationRow: Equatable, Sendable, Identifiable {
    let id: String
    /// The title as recorded, or the draft's when the check withheld it; nil
    /// when neither carries one.
    let title: String?
    let titleWithheld: Bool
    let sourceType: String
    let date: String?
    let dateWithheld: Bool
    let links: [PrivacyCitationLink]
    /// In the draft and withheld whole by the privacy check.
    let removed: Bool

    var marksWithheld: Bool {
        removed || titleWithheld || dateWithheld || links.contains(where: \.withheld)
    }
}

struct PrivacyCitationList: Equatable, Sendable {
    let heading: String
    let note: String?
    let rows: [PrivacyCitationRow]

    /// The sentence that explains the withheld marks, shown when any row
    /// carries one.
    var withheldNote: String? {
        rows.contains(where: \.marksWithheld)
            ? "Marked withheld: in the draft, removed by the privacy check. It did not leave this machine."
            : nil
    }
}

/// The citation's date as a calendar day. A value that is not ISO 8601 is left
/// out rather than shown raw.
func privacyCitationDate(_ timestamp: String?, timeZone: TimeZone = .current) -> String? {
    guard let timestamp else { return nil }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = parser.date(from: timestamp)
    if date == nil {
        parser.formatOptions = [.withInternetDateTime]
        date = parser.date(from: timestamp)
    }
    guard let date else { return nil }
    var style = Date.FormatStyle(date: .abbreviated, time: .omitted)
    style.timeZone = timeZone
    return date.formatted(style)
}

/// The rows of a list: one per citation or, against a `baseline` of the
/// draft's citations, one per draft citation in the draft's order — a draft
/// citation the list lacks is kept and marked removed, and a field the draft
/// had that the list's copy lacks is printed from the draft and marked
/// withheld. A citation the draft never recorded follows the draft's own.
func privacyCitationRows(
    _ citations: [AnswerCitation],
    baseline: [AnswerCitation]?,
    timeZone: TimeZone = .current
)
    -> [PrivacyCitationRow] {
    guard let baseline else {
        return citations.map { privacyCitationRow($0, timeZone: timeZone) }
    }
    let byDocument = Dictionary(
        citations.map { ($0.documentId, $0) },
        uniquingKeysWith: { first, _ in first }
    )
    var placed = Set<String>()
    var rows = baseline.map { draft -> PrivacyCitationRow in
        guard let kept = byDocument[draft.documentId] else {
            return privacyCitationRow(draft, removed: true, timeZone: timeZone)
        }
        placed.insert(kept.documentId)
        return privacyCitationRow(kept, draft: draft, timeZone: timeZone)
    }
    rows += citations
        .filter { !placed.contains($0.documentId) }
        .map { privacyCitationRow($0, timeZone: timeZone) }
    return rows
}

/// One row. With `draft`, a field the draft carries and `citation` lacks is
/// withheld; with `removed`, the whole citation is.
func privacyCitationRow(
    _ citation: AnswerCitation,
    draft: AnswerCitation? = nil,
    removed: Bool = false,
    timeZone: TimeZone = .current
)
    -> PrivacyCitationRow {
    func withheld(_ field: PrivacyCitationField) -> Bool {
        guard let draft else { return false }
        return field.value(in: draft) != nil && field.value(in: citation) == nil
    }
    func shown(_ field: PrivacyCitationField) -> String? {
        withheld(field) ? draft.flatMap { field.value(in: $0) } : field.value(in: citation)
    }
    let webWithheld = withheld(.sourceUrl)
    let appWithheld = withheld(.appUrl)
    let web = shown(.sourceUrl)
    let app = shown(.appUrl)
    var links: [PrivacyCitationLink] = []
    if let web {
        let struck = webWithheld || removed
        links.append(PrivacyCitationLink(
            label: "Link",
            text: web,
            withheld: webWithheld,
            struck: struck,
            openURLs: struck ? [] : docOpenURLs(appUrl: nil, sourceUrl: web)
        ))
    }
    if let app {
        let struck = appWithheld || removed
        // The app link falls back to the web link when no installed app
        // accepts it, but only to a web link that is itself released.
        let fallback = webWithheld ? nil : web
        links.append(PrivacyCitationLink(
            label: "App link",
            text: app,
            withheld: appWithheld,
            struck: struck,
            openURLs: struck ? [] : docOpenURLs(appUrl: app, sourceUrl: fallback)
        ))
    }
    return PrivacyCitationRow(
        id: citation.documentId,
        title: shown(.title),
        titleWithheld: withheld(.title),
        sourceType: citation.sourceType,
        date: privacyCitationDate(shown(.timestamp), timeZone: timeZone),
        dateWithheld: withheld(.timestamp),
        links: links,
        removed: removed
    )
}

/// A titled list, or nil when there is nothing to list.
func privacyCitationList(
    _ citations: [AnswerCitation],
    baseline: [AnswerCitation]? = nil,
    heading: String,
    note: String? = nil,
    timeZone: TimeZone = .current
)
    -> PrivacyCitationList? {
    let rows = privacyCitationRows(citations, baseline: baseline, timeZone: timeZone)
    guard !rows.isEmpty else { return nil }
    return PrivacyCitationList(heading: heading, note: note, rows: rows)
}

/// The draft's citations are the baseline that shows what the check withheld,
/// but only when the draft was recorded: with no draft there is nothing to
/// compare against, and every citation would otherwise read as unchanged.
func privacyCitationBaseline(_ exchange: PrivacyExchangePresentation) -> [AnswerCitation]? {
    exchange.draftAnswer == nil ? nil : exchange.draftCitations
}

private let privacyPendingCitationsHeading = "Citations that would be shared"
private let privacyPendingCitationsNote = "Share once releases these documents and every link printed here."

/// The draft card's list: what the agent cited, on its own.
func privacyDraftCitationList(
    _ exchange: PrivacyExchangePresentation,
    timeZone: TimeZone = .current
)
    -> PrivacyCitationList? {
    privacyCitationList(exchange.draftCitations, heading: "Cited in this draft", timeZone: timeZone)
}

/// The decision's list while an approval is pending: what Share once releases.
func privacyPendingCitationList(
    _ exchange: PrivacyExchangePresentation,
    timeZone: TimeZone = .current
)
    -> PrivacyCitationList? {
    guard let held = exchange.citationsAwaitingReview else { return nil }
    return privacyCitationList(
        held,
        baseline: privacyCitationBaseline(exchange),
        heading: privacyPendingCitationsHeading,
        note: privacyPendingCitationsNote,
        timeZone: timeZone
    )
}

/// The release's list, only for an answer that was shared.
func privacySharedCitationList(
    _ exchange: PrivacyExchangePresentation,
    timeZone: TimeZone = .current
)
    -> PrivacyCitationList? {
    guard let shared = exchange.externallyVisibleCitations else { return nil }
    return privacyCitationList(
        shared,
        baseline: privacyCitationBaseline(exchange),
        heading: "Citations shared",
        timeZone: timeZone
    )
}

/// The pending review card's list: what Share once releases, compared with
/// the draft when the card was built from an exchange that recorded one.
func privacyReviewCitationList(
    _ review: PrivacyPendingReview,
    timeZone: TimeZone = .current
)
    -> PrivacyCitationList? {
    guard review.candidateAvailable else { return nil }
    return privacyCitationList(
        review.citations,
        baseline: review.citationBaseline,
        heading: privacyPendingCitationsHeading,
        note: privacyPendingCitationsNote,
        timeZone: timeZone
    )
}
