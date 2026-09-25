// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A held answer expires, so a decision that is already waiting opens itself
/// when the app becomes active rather than waiting to be found. The rule is
/// kept out of the view so the two things that make it safe — never displacing
/// an explicit destination, and never asking twice in one session — are stated
/// once and can be checked.
final class PrivacyApprovalAutoOpenPolicyTests: XCTestCase {
    private func shouldPresent(
        pendingCount: Int = 1,
        paired: Bool = true,
        alreadyPresenting: Bool = false,
        presentedThisSession: Bool = false,
        pushPending: Bool = false,
        pushRoutedMeanwhile: Bool = false,
        capturePending: Bool = false
    )
        -> Bool {
        PrivacyApprovalAutoOpenPolicy.shouldPresent(
            pendingCount: pendingCount,
            paired: paired,
            presentedThisSession: presentedThisSession,
            occupancy: PrivacyApprovalAutoOpenPolicy.Occupancy(
                alreadyPresenting: alreadyPresenting,
                pushPending: pushPending,
                pushRoutedMeanwhile: pushRoutedMeanwhile,
                capturePending: capturePending
            )
        )
    }

    func testOneWaitingDecisionOnAnIdleAppOpens() {
        XCTAssertTrue(shouldPresent())
    }

    func testNothingWaitingOpensNothing() {
        XCTAssertFalse(shouldPresent(pendingCount: 0))
    }

    /// A notification tap named where the app should be. Opening a different
    /// decision over it would answer a question the owner did not ask, and
    /// would make the tapped one unreachable behind a sheet.
    func testAQueuedPushTargetWins() {
        XCTAssertFalse(shouldPresent(pushPending: true))
    }

    /// A tap that arrived while the ledger was being read is consumed by the
    /// Privacy screen before the read returns, so nothing is pending by the
    /// time the decision would present. The owner was still routed somewhere
    /// they asked for, and that still wins.
    func testAPushRoutedDuringTheLookupWins() {
        XCTAssertFalse(shouldPresent(pushRoutedMeanwhile: true))
    }

    /// A Lock Screen / Control Center capture is the same kind of explicit
    /// instruction, and the owner is mid-thought when it lands.
    func testAFreshCaptureWins() {
        XCTAssertFalse(shouldPresent(capturePending: true))
    }

    /// Dismissing without deciding is an answer of a kind. Re-offering on
    /// every return from the background would make the app unusable; the next
    /// cold launch asks again, because the decision is still expiring.
    func testDismissedInThisSessionIsNotOfferedAgain() {
        XCTAssertFalse(shouldPresent(presentedThisSession: true))
    }

    func testNothingIsOpenedOverSomethingAlreadyPresented() {
        XCTAssertFalse(shouldPresent(alreadyPresenting: true))
    }

    /// An unpaired app has no gateway to hold a decision, and shows onboarding.
    func testAnUnpairedAppOpensNothing() {
        XCTAssertFalse(shouldPresent(paired: false))
    }

    /// A backlog behaves the same as a single decision: the app opens the one
    /// it was handed, not one sheet per waiting item.
    func testABacklogStillOffersOnce() {
        XCTAssertTrue(shouldPresent(pendingCount: 12))
        XCTAssertFalse(shouldPresent(pendingCount: 12, presentedThisSession: true))
    }
}
