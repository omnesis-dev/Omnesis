// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The policy behind "is this phone's data actually getting through?" — the
/// question the sync status cannot answer, because a sync reads from the OS
/// and the upload is a separate step that fails on its own.
///
/// Deliberately free of any UI dependency. The views that render this are
/// compiled only where UIKit exists, so anything living with them runs only
/// in the simulator lane; the decisions themselves are ordinary values and
/// belong where the fast lane can test them.
public enum PushHealth {
    /// How stale the oldest queued batch must get before the backlog is
    /// worth reporting. Long enough to clear a normal sync, a
    /// background-refresh window, and an overnight gap in connectivity
    /// without crying wolf.
    public static let backlogThreshold: TimeInterval = 6 * 60 * 60

    /// Where a user-triggered retry is in its cycle.
    ///
    /// Held by the sync coordinator rather than by a view: both the Sources
    /// screen and Settings render this banner, a retry started on one is the
    /// same operation as a retry started on the other, and view-local state
    /// would be lost the moment either row scrolled out of its lazy
    /// container — taking with it the report the retry exists to deliver.
    public enum RetryPhase: Equatable, Sendable {
        case idle
        case running
        /// The last finished retry's result, kept on screen until a later
        /// drain moves the numbers out from under it.
        case reported(DrainOutcome)
    }

    /// True when there is nothing worth telling the user about. Call sites
    /// use this to skip rendering the enclosing section entirely.
    public static func isHealthy(
        blockedSourceIds: [String],
        oldestBufferedAge: TimeInterval?,
        quarantinedBatches: Int,
        threshold: TimeInterval = backlogThreshold
    )
        -> Bool {
        blockedSourceIds.isEmpty
            && quarantinedBatches == 0
            && !isBacklogged(oldestBufferedAge, blockedSourceIds: blockedSourceIds, threshold: threshold)
    }

    /// Whether the queue is stale enough to report as a delivery failure.
    ///
    /// Suppressed while any source is blocked. Blocked batches are never
    /// removed and sit at the head of the FIFO, so the oldest-batch age grows
    /// without bound however healthy the rest of the queue is — reporting it
    /// would latch a second alarm whose Retry button cannot help. The blocked
    /// row is showing in that case and carries the real remedy.
    public static func isBacklogged(
        _ oldestBufferedAge: TimeInterval?,
        blockedSourceIds: [String],
        threshold: TimeInterval = backlogThreshold
    )
        -> Bool {
        guard blockedSourceIds.isEmpty, let oldestBufferedAge else { return false }
        return oldestBufferedAge >= threshold
    }

    /// What a retry achieved, in one line. Every outcome gets one, so a
    /// retry that achieved nothing says so rather than leaving the screen
    /// unchanged.
    public static func retryMessage(for outcome: DrainOutcome) -> String {
        switch outcome {
        case .delivered:
            "Queued batches went through."
        case .refused:
            "Omnesis answered, but refused this data. Retrying won't change that — "
                + "it'll be set aside if it keeps failing."
        case .paused:
            "These batches belong to paused sources. They'll be retried after those sources are resumed."
        case .blocked:
            "Omnesis refused this phone's write access for a source. Grant it on the gateway, then retry."
        case .unreachable:
            "Couldn't reach Omnesis. It'll keep trying in the background."
        case .stalled:
            "Batches are still waiting after this retry. Omnesis will keep trying in the background."
        case .busy:
            "A sync is already running. Try again in a moment."
        case .idle:
            "Nothing left to upload."
        case .failed:
            "The upload couldn't start. Check this phone is still paired in Settings."
        }
    }

    /// Whether an outcome is bad news, which decides whether its line is
    /// coloured as a warning. Only the outcomes that leave data undelivered
    /// are: "nothing was pending" and "a sync is already running" report a
    /// retry that had nothing to do, not one that failed.
    public static func retryIsTrouble(_ outcome: DrainOutcome) -> Bool {
        switch outcome {
        case .refused, .paused, .blocked, .unreachable, .stalled, .failed: true
        case .delivered, .busy, .idle: false
        }
    }
}
