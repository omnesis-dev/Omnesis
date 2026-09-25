// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// One firing, whichever of its two halves this install holds.
///
/// A firing the runtime caught leads with when the watch spoke and what it
/// read; a firing the record sent but nothing caught leads with when the wake
/// was written and how it went. Most rows are both, and then the row states the
/// one thing neither half says alone: it fired, and here is whether anyone was
/// actually told.
@available(iOS 17.0, *)
struct WatchFiringRowView: View {
    let row: WatchFiringRow
    /// Whether this is the firing the reader was notified about. A ledger of
    /// instants looks the same whichever line brought you here, so the one that
    /// did says so.
    var fromNotification: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if fromNotification {
                Text("What you were notified about")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.accent)
            }
            HStack(spacing: 8) {
                Text(headline)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
                // The journal sequence, beside the instant it belongs to, as the portal and
                // the Android app both print it: it is how one firing is named when talking
                // about it anywhere else.
                if let caught = row.caught {
                    // `verbatim` because a sequence is an identifier, not a quantity: SwiftUI's
                    // localized interpolation would group it into "15,775".
                    Text(verbatim: "seq \(caught.seq)")
                        .font(Theme.monospace(size: 11))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            if let caught = row.caught {
                // Both times, but only when they differ. A firing is stamped with the time of
                // the thing it is about — the date on the document, the moment the meeting
                // starts — which can be months before the runtime caught it.
                if let noticed = caught.noticedAt, !sameMinute(caught.firedAt, noticed) {
                    Text("About something dated \(display(caught.firedAt))")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
                deliveryLine(caught.delivery)
                // What it read to decide. Absent rather than empty for a firing
                // with nothing behind it — a clock reaching a boundary, a
                // deadline passing — where a "no documents" line would read as
                // something missing rather than as the watch working as asked.
                if !caught.documents.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(caught.documents) { document in
                            WatchFiringDocumentRow(document: document)
                        }
                    }
                    .padding(.top, 2)
                }
            } else if let sent = row.sent {
                Text(firingDeliveryStatusLabel(sent.deliveryStatus))
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                Text(shortSubscriptionId(sent.id))
                    .font(Theme.monospace(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.vertical, 4)
    }

    /// When the watch spoke, which is what a ledger is read to answer.
    ///
    /// Taken from the same `at` the history sorts by, so the two cannot drift: heading a row
    /// with the subject's time while ordering it by the moment the runtime noticed lets an
    /// older date sit above a newer one in a list that promises newest-first. The subject's own
    /// date is printed beneath instead, when the two disagree — as the portal and the Android
    /// app both do.
    private var headline: String {
        guard let at = row.at else { return "Unknown" }
        return subscriptionDate(at)
    }

    /// Only when the firing was meant to go somewhere. A watch that delivers
    /// nowhere was never sent, and saying so here would read as a failure
    /// rather than as the watch doing what was asked.
    @ViewBuilder
    private func deliveryLine(_ delivery: WatchFiringDelivery?) -> some View {
        if let delivery {
            if delivery.delivered > 0 {
                Text(delivery.kind == "agent-wake" ? "woke an agent" : "notified you")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            } else {
                // The case this whole row exists for: it fired, and you were
                // never told. Without it, that is indistinguishable from a
                // watch that never fired at all.
                Text(delivery.error.map { "not delivered — \($0)" } ?? "not delivered")
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
        }
    }

    private func display(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter.omnesisParser.date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func sameMinute(_ first: String, _ second: String) -> Bool {
        let parser = ISO8601DateFormatter.omnesisParser
        guard let left = parser.date(from: first), let right = parser.date(from: second) else {
            return first == second
        }
        return abs(left.timeIntervalSince(right)) < 60
    }
}

/// One document behind a firing: the source it came from, and its title.
///
/// Named rather than linked. A watch's ledger is read to answer "why did this
/// fire?", and the honest answer here is what the runtime read — following it
/// into the document belongs to a screen that can hold one, which this list
/// inside a row cannot.
///
/// The store is optional because this row is reachable from a view built
/// without one: `WatchDetailContent` takes its data as arguments so previews
/// and snapshot tests can render it directly, and neither injects a store. A
/// non-optional `@Environment(AppStore.self)` traps at read time rather than
/// yielding nil, so it would turn every one of those into a crash. Without a
/// store there is no icon to look up, and the title alone is still the answer.
struct WatchFiringDocumentRow: View {
    let document: WatchFiringDocument
    @Environment(AppStore.self) private var store: AppStore?

    var body: some View {
        HStack(spacing: 6) {
            if let store {
                SourceIconView(sourceId: document.sourceId, store: store, size: 13)
            }
            Text(document.title.isEmpty ? "Untitled" : document.title)
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }
}

#endif
