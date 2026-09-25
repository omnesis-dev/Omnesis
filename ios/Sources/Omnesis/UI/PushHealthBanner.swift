// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Surfaces the ways this phone can stop delivering data to the gateway
/// while every other indicator still reads "synced".
///
/// The app's sync status answers "did the collector run?", which is not the
/// same question as "did the data arrive?". A sync cycle reads from HealthKit,
/// writes batches to the offline buffer, and advances its cursor there — the
/// upload is a separate step. When that step fails, the source keeps reporting
/// completed syncs and the cursor keeps moving, so the phone looks healthy
/// while the gateway silently goes stale.
///
/// Three distinct failures get their own copy because the remedies differ:
///
///   - **Blocked** — the gateway refused a source with 403 because this
///     device's token lacks its `write:<source-type>` scope. Nothing the user
///     can fix on the phone; it needs a grant on the gateway. The buffered data
///     is intact and delivers as soon as the scope lands.
///   - **Backlog** — batches are queued and the oldest one keeps aging. The
///     link is down, the gateway is unreachable, or uploads are erroring. Retry
///     is the right action.
///   - **Undelivered** — the uploader gave up on some batches and set them
///     aside (see `OfflineBuffer`'s quarantine). Nothing is pending any more,
///     so there is nothing to retry; what is left is to say the data didn't
///     make it and let the user clear the notice.
///
/// A merely non-empty buffer is *not* a problem — that's the normal state
/// mid-sync — so the backlog case is gated on the oldest entry's age rather
/// than on the count.
///
/// Retry reports back: the outcome (`DrainOutcome`) is rendered, including
/// the one that matters most here — "the gateway answered and refused",
/// which no amount of tapping will change. The phase is supplied by the
/// caller rather than held here; see `PushHealth.RetryPhase`.
///
/// The decisions this view renders — when a state is worth reporting, and
/// what each outcome says — live in `PushHealth`.
@available(iOS 17.0, *)
struct PushHealthBanner: View {
    let blockedSourceIds: [String]
    let bufferedBatches: Int
    let oldestBufferedAge: TimeInterval?
    /// Batches the uploader set aside as undeliverable.
    let quarantinedBatches: Int
    /// Resolves a source id to the name to show. The banner never spells out a
    /// source name of its own (see the source-encapsulation rule in CLAUDE.md)
    /// — the caller resolves through the descriptor registry.
    let labelForSourceId: (String) -> String
    let retryPhase: PushHealth.RetryPhase
    let onRetry: () -> Void
    let onDiscardUndelivered: () -> Void

    @State private var confirmingDiscard = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !blockedSourceIds.isEmpty {
                blockedRow
            }
            if PushHealth.isBacklogged(oldestBufferedAge, blockedSourceIds: blockedSourceIds) {
                backlogRow
            }
            if quarantinedBatches > 0 {
                undeliveredRow
            }
        }
        .padding(.vertical, 4)
    }

    private var blockedRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Omnesis isn't accepting some data", systemImage: "lock.trianglebadge.exclamationmark.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.danger)
            Text(blockedNames)
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.textPrimary)
            Text(
                "This phone isn't allowed to send \(blockedSourceIds.count == 1 ? "this source" : "these sources") yet. "
                    + "The data is held on the phone and uploads once the gateway grants permission — but the "
                    + "phone only keeps a limited backlog, so the oldest of it is dropped if this isn't fixed."
            )
            .font(.footnote)
            .foregroundStyle(Theme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var backlogRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Data isn't reaching Omnesis", systemImage: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.warning)
            Text(backlogDetail)
                .font(.footnote)
                .foregroundStyle(Theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            retryControl
            if case .reported(let outcome) = retryPhase {
                RetryStatusLine(outcome: outcome)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Delivery backlog")
    }

    @ViewBuilder
    private var retryControl: some View {
        if retryPhase == .running {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Uploading…")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.textMuted)
            }
        } else {
            Button(retryPhase == .idle ? "Retry now" : "Try again", action: onRetry)
                .font(.footnote.weight(.semibold))
                .buttonStyle(.borderless)
        }
    }

    private var undeliveredRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Some data never reached Omnesis", systemImage: "tray.full")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text(
                "\(Self.batchCount(quarantinedBatches)) couldn't be delivered after repeated attempts, so "
                    + "\(quarantinedBatches == 1 ? "it was" : "they were") set aside. Everything since is syncing "
                    + "normally. Set-aside data is kept on this phone for a while, and discarding it now frees "
                    + "the space immediately."
            )
            .font(.footnote)
            .foregroundStyle(Theme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
            Button("Discard", role: .destructive) { confirmingDiscard = true }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.borderless)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Undelivered data")
        .confirmationDialog(
            "Discard undelivered data?",
            isPresented: $confirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive, action: onDiscardUndelivered)
            Button("Keep", role: .cancel) {}
        } message: {
            Text("\(Self.batchCount(quarantinedBatches)) will be deleted from this phone. This can't be undone.")
        }
    }

    private var blockedNames: String {
        blockedSourceIds
            .map(labelForSourceId)
            .formatted(.list(type: .and))
    }

    private static func batchCount(_ count: Int) -> String {
        count == 1 ? "1 batch" : "\(count) batches"
    }

    private var backlogDetail: String {
        let batches = Self.batchCount(bufferedBatches)
        guard let oldestBufferedAge else {
            return "\(batches) waiting to upload."
        }
        // A duration ("3 days"), not a relative date ("3 days ago") — the point
        // is how long the data has been stuck, not when it was captured.
        let waited = Duration.seconds(oldestBufferedAge)
            .formatted(.units(allowed: [.days, .hours, .minutes], maximumUnitCount: 1))
        return "\(batches) waiting to upload — the oldest has been waiting \(waited)."
    }
}

/// The one line a finished retry leaves behind. Its own view so a snapshot
/// can render every outcome side by side, which the banner itself only ever
/// shows one at a time.
@available(iOS 17.0, *)
struct RetryStatusLine: View {
    let outcome: DrainOutcome

    var body: some View {
        Text(PushHealth.retryMessage(for: outcome))
            .font(.footnote)
            .foregroundStyle(PushHealth.retryIsTrouble(outcome) ? Theme.warning : Theme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }
}

#if DEBUG
/// Wraps a banner in the Form chrome both call sites give it, so previews
/// differ only in the state under test.
@available(iOS 17.0, *)
private struct PushHealthPreview: View {
    var blockedSourceIds: [String] = []
    var bufferedBatches: Int = 0
    var oldestBufferedAge: TimeInterval?
    var quarantinedBatches: Int = 0
    var retryPhase: PushHealth.RetryPhase = .idle

    var body: some View {
        Form {
            Section {
                PushHealthBanner(
                    blockedSourceIds: blockedSourceIds,
                    bufferedBatches: bufferedBatches,
                    oldestBufferedAge: oldestBufferedAge,
                    quarantinedBatches: quarantinedBatches,
                    labelForSourceId: { _ in "Places" },
                    retryPhase: retryPhase,
                    onRetry: {},
                    onDiscardUndelivered: {}
                )
            }
            .listRowBackground(Theme.bgSecondary)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bgPrimary)
    }
}

#Preview("Blocked — one source") {
    PushHealthPreview(
        blockedSourceIds: ["core-location-visits:local"],
        bufferedBatches: 12,
        oldestBufferedAge: 60 * 60
    )
}

#Preview("Blocked — several sources") {
    PushHealthPreview(
        blockedSourceIds: ["core-location-visits:local", "photos:local"],
        bufferedBatches: 340,
        oldestBufferedAge: 3 * 24 * 60 * 60
    )
}

#Preview("Backlog only") {
    PushHealthPreview(bufferedBatches: 87, oldestBufferedAge: 3 * 24 * 60 * 60)
}

#Preview("Blocked with an empty queue") {
    PushHealthPreview(blockedSourceIds: ["core-location-visits:local"], bufferedBatches: 1)
}

#Preview("Undelivered only") {
    PushHealthPreview(quarantinedBatches: 3)
}

#Preview("Undelivered — a single batch") {
    PushHealthPreview(quarantinedBatches: 1)
}

#Preview("Backlog — retry in flight") {
    PushHealthPreview(
        bufferedBatches: 87,
        oldestBufferedAge: 3 * 24 * 60 * 60,
        retryPhase: .running
    )
}

#Preview("Backlog — retry refused") {
    PushHealthPreview(
        bufferedBatches: 87,
        oldestBufferedAge: 3 * 24 * 60 * 60,
        retryPhase: .reported(.refused)
    )
}

#Preview("Backlog and undelivered together") {
    PushHealthPreview(
        bufferedBatches: 9,
        oldestBufferedAge: 12 * 60 * 60,
        quarantinedBatches: 2
    )
}

// A blocked source and batches already given up on. The backlog row stays
// away even though the queue is stale: a blocked source's batches sit at the
// head of the FIFO and age without bound, so reporting them would raise a
// second alarm whose Retry cannot help.
#Preview("Blocked and undelivered") {
    PushHealthPreview(
        blockedSourceIds: ["photos:local"],
        bufferedBatches: 41,
        oldestBufferedAge: 2 * 24 * 60 * 60,
        quarantinedBatches: 5
    )
}

// Every message a finished retry can leave, together — the nine strings are
// only ever seen one at a time in the app, and this is where their length
// and wrapping can be compared.
#Preview("Retry outcomes") {
    Form {
        Section {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(
                    [
                        DrainOutcome.delivered, .refused, .paused, .blocked,
                        .unreachable, .stalled, .busy, .idle, .failed,
                    ],
                    id: \.self
                ) { outcome in
                    RetryStatusLine(outcome: outcome)
                }
            }
        }
        .listRowBackground(Theme.bgSecondary)
    }
    .scrollContentBackground(.hidden)
    .background(Theme.bgPrimary)
}
#endif

#endif
