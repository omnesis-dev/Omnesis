// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// `PushHealth` decides, from three numbers, whether to tell the user their
/// phone has stopped delivering data. Getting that wrong in either direction
/// is costly: a missed warning hides silent data loss, and a warning that
/// can't be cleared trains the user to ignore the surface entirely.
final class PushHealthTests: XCTestCase {
    private let threshold = PushHealth.backlogThreshold

    // MARK: - isHealthy

    func testNothingPendingIsHealthy() {
        XCTAssertTrue(
            PushHealth.isHealthy(
                blockedSourceIds: [], oldestBufferedAge: nil, quarantinedBatches: 0
            )
        )
    }

    /// A non-empty buffer is the normal state mid-sync — the warning is about
    /// the oldest entry aging, not about anything being queued at all.
    func testFreshBacklogIsHealthy() {
        XCTAssertTrue(
            PushHealth.isHealthy(
                blockedSourceIds: [], oldestBufferedAge: 60, quarantinedBatches: 0
            )
        )
    }

    func testStaleBacklogIsNotHealthy() {
        XCTAssertFalse(
            PushHealth.isHealthy(
                blockedSourceIds: [], oldestBufferedAge: threshold + 1, quarantinedBatches: 0
            )
        )
    }

    func testBlockedSourceIsNotHealthy() {
        XCTAssertFalse(
            PushHealth.isHealthy(
                blockedSourceIds: ["photos:local"], oldestBufferedAge: nil, quarantinedBatches: 0
            )
        )
    }

    /// Batches that were given up on are the whole reason the banner can now
    /// stop nagging: nothing is queued, nothing is blocked, and the surface
    /// still has to say the data never arrived.
    func testUndeliveredBatchesAreNotHealthy() {
        XCTAssertFalse(
            PushHealth.isHealthy(
                blockedSourceIds: [], oldestBufferedAge: nil, quarantinedBatches: 1
            )
        )
    }

    // MARK: - isBacklogged

    func testBacklogIsSuppressedWhileASourceIsBlocked() {
        // A blocked source's batches are never removed and sit at the head of
        // the FIFO, so the oldest-batch age grows without bound however
        // healthy the rest of the queue is. Reporting it would latch a second
        // alarm whose Retry cannot help.
        XCTAssertFalse(
            PushHealth.isBacklogged(
                threshold + 1, blockedSourceIds: ["photos:local"]
            )
        )
    }

    func testBacklogNeedsAnAge() {
        XCTAssertFalse(PushHealth.isBacklogged(nil, blockedSourceIds: []))
    }

    func testBacklogBoundaryIsInclusive() {
        XCTAssertTrue(PushHealth.isBacklogged(threshold, blockedSourceIds: []))
        XCTAssertFalse(PushHealth.isBacklogged(threshold - 1, blockedSourceIds: []))
    }

    // MARK: - Retry feedback

    /// Every outcome says something, so a retry that achieved nothing is
    /// distinguishable from a button that isn't wired up.
    func testEveryOutcomeHasAMessage() {
        let outcomes: [DrainOutcome] = [
            .delivered, .refused, .paused, .blocked, .unreachable, .stalled, .busy, .idle, .failed,
        ]
        for outcome in outcomes {
            XCTAssertFalse(
                PushHealth.retryMessage(for: outcome).isEmpty,
                "\(outcome) must report back"
            )
        }
    }

    /// The refusal case is the one that must not read as "try again" — the
    /// gateway answered and rejected the payload, and tapping harder cannot
    /// change that.
    func testRefusalMessageSaysRetryingWontHelp() {
        let message = PushHealth.retryMessage(for: .refused)
        XCTAssertTrue(
            message.contains("won't change that"),
            "Refusal copy must not invite pointless retries; got: \(message)"
        )
    }

    /// A retry that had nothing to do is not a failure, and must not be
    /// coloured as one — the warning colour is reserved for the outcomes
    /// that actually leave data undelivered.
    func testOnlyUndeliveredOutcomesReadAsTrouble() {
        for outcome in [DrainOutcome.refused, .paused, .blocked, .unreachable, .stalled, .failed] {
            XCTAssertTrue(PushHealth.retryIsTrouble(outcome), "\(outcome) is bad news")
        }
        for outcome in [DrainOutcome.delivered, .busy, .idle] {
            XCTAssertFalse(PushHealth.retryIsTrouble(outcome), "\(outcome) is not a failure")
        }
    }

    func testOutcomeMessagesAreDistinct() {
        let messages = [
            DrainOutcome.delivered, .refused, .paused, .blocked, .unreachable,
            .stalled, .busy, .idle, .failed,
        ]
        .map(PushHealth.retryMessage(for:))
        XCTAssertEqual(Set(messages).count, messages.count, "Each outcome needs its own copy")
    }
}
