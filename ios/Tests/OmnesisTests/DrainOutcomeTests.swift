// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// `DrainOutcome` is what a user-triggered retry reports back, so the
/// mapping from raw counts has to survive the cases where several are
/// non-zero at once.
final class DrainOutcomeTests: XCTestCase {
    private func stats(
        uploaded: Int = 0,
        failed: Int = 0,
        skipped: Int = 0,
        remaining: Int = 0,
        rejected: [PushRejection] = [],
        blocked: [String]? = []
    )
        -> Uploader.Stats {
        Uploader.Stats(
            uploaded: uploaded,
            failed: failed,
            skipped: skipped,
            remaining: remaining,
            rejected: rejected,
            blocked: blocked
        )
    }

    func testThrownDrainIsFailed() {
        XCTAssertEqual(DrainOutcome(nil), .failed)
    }

    /// `blocked == nil` is the drain's own marker for "another pass owns the
    /// buffer, this one looked at nothing". Its zeroed counts are not
    /// evidence of anything.
    func testUnobservedPassIsBusy() {
        XCTAssertEqual(DrainOutcome(stats(remaining: 4, blocked: nil)), .busy)
    }

    func testUploadsWithNoFailuresAreDelivered() {
        XCTAssertEqual(DrainOutcome(stats(uploaded: 3)), .delivered)
    }

    func testSkipsAreRefused() {
        XCTAssertEqual(DrainOutcome(stats(skipped: 1, remaining: 1)), .refused)
    }

    func testTransientFailuresAreUnreachable() {
        XCTAssertEqual(DrainOutcome(stats(failed: 2, remaining: 2)), .unreachable)
    }

    func testPausedRejectionWithRemainingBatchesIsPaused() {
        XCTAssertEqual(
            DrainOutcome(
                stats(
                    remaining: 3,
                    rejected: [PushRejection(sourceId: "example:local", reason: "paused")]
                )
            ),
            .paused
        )
    }

    func testUnknownNoProgressWithRemainingBatchesIsStalled() {
        XCTAssertEqual(DrainOutcome(stats(remaining: 3)), .stalled)
    }

    func testRetainedNonPausedRejectionIsStalled() {
        XCTAssertEqual(
            DrainOutcome(
                stats(
                    uploaded: 1,
                    remaining: 1,
                    rejected: [PushRejection(sourceId: "example:local", reason: "removed")]
                )
            ),
            .stalled
        )
    }

    func testEmptyPassIsIdle() {
        XCTAssertEqual(DrainOutcome(stats()), .idle)
    }

    /// Both kinds of trouble in one pass. Unreachable wins: it is the more
    /// likely cause of the pair, and the only one with an obvious remedy.
    func testUnreachableOutranksRefused() {
        XCTAssertEqual(DrainOutcome(stats(failed: 1, skipped: 1)), .unreachable)
    }

    func testBlockedSourceIsBlocked() {
        XCTAssertEqual(
            DrainOutcome(stats(skipped: 1, remaining: 1, blocked: ["example:local"])),
            .blocked
        )
    }

    func testUnreachableOutranksBlocked() {
        XCTAssertEqual(
            DrainOutcome(stats(failed: 1, skipped: 1, remaining: 1, blocked: ["example:local"])),
            .unreachable
        )
    }

    func testUnreachableOutranksPaused() {
        XCTAssertEqual(
            DrainOutcome(
                stats(
                    failed: 1,
                    remaining: 3,
                    rejected: [PushRejection(sourceId: "example:local", reason: "paused")]
                )
            ),
            .unreachable
        )
    }

    /// Partial progress is still a refusal worth reporting — some batches
    /// went, the ones the gateway won't take stayed.
    func testRefusalOutranksPartialProgress() {
        XCTAssertEqual(DrainOutcome(stats(uploaded: 5, skipped: 1, remaining: 1)), .refused)
    }

    func testPauseOutranksPartialProgressWhilePausedBatchesRemain() {
        XCTAssertEqual(
            DrainOutcome(
                stats(
                    uploaded: 2,
                    remaining: 1,
                    rejected: [PushRejection(sourceId: "example:local", reason: "paused")]
                )
            ),
            .paused
        )
    }

    func testPartialProgressWithNewlyQueuedWorkIsDelivered() {
        XCTAssertEqual(DrainOutcome(stats(uploaded: 2, remaining: 1)), .delivered)
    }
}
