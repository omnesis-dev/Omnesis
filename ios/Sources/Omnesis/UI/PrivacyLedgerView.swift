// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// One recorded step of an exchange, on the spine, in the band it happened in.
//
// A step's body is either the exchange's own words — the question, a draft, a
// reduction, the answer that left — or a sentence Omnesis wrote about what
// happened, and the two are not shown alike: the first is quoted, the second is
// prose.

/// When a moment happened, above the thing it stamps.
///
/// The time is on every moment; the date only on the one that opens a new day,
/// so a reader scanning a column of instants sees the number that is actually
/// moving.
@available(iOS 17.0, *)
struct PrivacyMomentLabel: View {
    let at: Int64
    var showsDay: Bool = false

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if showsDay {
                Text(day)
                    .font(Theme.monospace(size: 10).weight(.semibold))
                    .foregroundStyle(Theme.textSecondary)
            }
            Text(clock)
                .font(Theme.monospace(size: 10))
                .foregroundStyle(Theme.textMuted)
        }
        .accessibilityElement()
        .accessibilityLabel(privacyAbsoluteDate(at))
    }

    private var date: Date {
        Date(timeIntervalSince1970: Double(at) / 1000)
    }

    private var day: String {
        date.formatted(date: .abbreviated, time: .omitted)
    }

    private var clock: String {
        date.formatted(date: .omitted, time: .standard)
    }
}

/// One step of the ledger: what happened, and which model was involved.
///
/// Quieter than the three cards beside it, and deliberately: a reader scanning
/// this column is looking for what was asked, what was drafted and what was
/// decided, and a reduction or an agent's tool call is the detail underneath one
/// of those rather than a fourth thing of the same weight.
///
/// The instant is not here — it is on the moment label above, so every time on
/// the spine sits at the same indent.
@available(iOS 17.0, *)
struct PrivacyLedgerStep: View {
    let event: PrivacyAuditEventSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                Text(event.display.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                PrivacyAuditStatusChip(status: event.display.status)
                Spacer(minLength: 0)
            }
            if let quoted = quotedBody {
                PrivacyQuote(text: quoted.text, role: quoted.role, size: 12)
            }
            ForEach(narrative, id: \.self) { line in
                Text(line)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let model {
                Text(model)
                    .font(Theme.monospace(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
            ForEach(Array(event.display.reductions.enumerated()), id: \.offset) { _, reduction in
                Text("• \(reduction)")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
            }
            if let comparison = event.answerComparison {
                PrivacyAnswerComparisonSection(comparison: comparison)
                    .padding(.top, Theme.Spacing.xs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The step's body when it is the exchange's own words rather than a
    /// sentence Omnesis wrote about it.
    ///
    /// A rendered comparison already carries the released answer, line by line
    /// and drawn from the untruncated recording. The step's own body is a
    /// bounded preview of that same text, so printing it above the comparison
    /// would say the same thing twice, less completely. Every other step, and
    /// every release whose comparison is not a line-by-line one, keeps its body.
    private var quotedBody: (text: String, role: String)? {
        guard !comparisonCarriesTheAnswer,
              let role = privacyAuditQuotedBodyRole(event.kind),
              let text = trimmed(event.display.text)
        else { return nil }
        return (text, role)
    }

    /// What the step says in Omnesis's own voice: its body where that body is
    /// not a quotation, and the framing line under it either way.
    private var narrative: [String] {
        let body = privacyAuditQuotedBodyRole(event.kind) == nil ? event.display.text : nil
        return [body, event.display.detail].compactMap(trimmed)
    }

    private func trimmed(_ value: String?) -> String? {
        let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    private var comparisonCarriesTheAnswer: Bool {
        if case .diff = event.answerComparison { return true }
        return false
    }

    private var model: String? {
        let parts = [event.display.provider, event.display.model].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " / ")
    }
}

#if DEBUG
#Preview("Privacy ledger steps") {
    ScrollView {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(PreviewMocks.privacyAuditEvents) { event in
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

#Preview("Privacy moment label — opening a new day") {
    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
        PrivacyMomentLabel(at: 1_700_000_000_000, showsDay: true)
        PrivacyMomentLabel(at: 1_700_000_010_000)
        PrivacyMomentLabel(at: 1_700_000_020_000)
    }
    .padding(Theme.Spacing.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.bgPrimary)
    .omnesisColorScheme()
}
#endif

#endif
