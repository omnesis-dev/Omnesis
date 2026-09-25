// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PrivacyFeedPresentationTests: XCTestCase {
    func testEveryKnownOutcomeBelongsToExactlyOneNarrowingFilter() {
        let outcomes: [PrivacyExchangeOutcome] = [
            .checking, .needsReview, .ready, .shared, .sharedWithReductions,
            .notShared, .failed, .canceled,
        ]
        let narrowing = PrivacyFeedFilter.allCases.filter { $0 != .all }

        for outcome in outcomes {
            let matches = narrowing.filter {
                privacyFeedFilterMatches($0, exchange: exchange(outcome: outcome))
            }
            XCTAssertEqual(matches.count, 1, "outcome: \(outcome)")
        }
    }

    func testUnknownOutcomeRemainsVisibleUnderEveryFilter() {
        let item = exchange(outcome: .unknown)
        for filter in PrivacyFeedFilter.allCases {
            XCTAssertTrue(privacyFeedFilterMatches(filter, exchange: item))
        }
    }

    func testFeedOutcomeUsesShortCopyWithoutChangingItsTone() {
        XCTAssertEqual(privacyFeedOutcomeDisplay(exchange(outcome: .shared)).label, "Shared")
        XCTAssertEqual(
            privacyFeedOutcomeDisplay(exchange(outcome: .sharedWithReductions)).label,
            "Shared, details removed"
        )
        XCTAssertEqual(privacyFeedOutcomeDisplay(exchange(outcome: .notShared)).label, "Not shared")
        XCTAssertEqual(privacyFeedOutcomeDisplay(exchange(outcome: .shared)).tone, .released)
        XCTAssertEqual(
            privacyFeedOutcomeDisplay(exchange(outcome: .unknown)).label,
            "Outcome not recognised"
        )
    }

    func testOnlyOrdinaryFeedOutcomesUseQuietMarks() {
        XCTAssertTrue(privacyFeedOutcomeIsQuiet(.shared))
        XCTAssertTrue(privacyFeedOutcomeIsQuiet(.sharedWithReductions))
        XCTAssertTrue(privacyFeedOutcomeIsQuiet(.notShared))
        XCTAssertTrue(privacyFeedOutcomeIsQuiet(.checking))
        XCTAssertFalse(privacyFeedOutcomeIsQuiet(.needsReview))
        XCTAssertFalse(privacyFeedOutcomeIsQuiet(.failed))
        XCTAssertFalse(privacyFeedOutcomeIsQuiet(.unknown))
    }

    func testFeedGroupsRowsByLocalDayWithoutDuplicatingAHeading() {
        let day: Int64 = 86_400_000
        let first = exchange(id: "first", outcome: .shared, at: 1_700_000_000_000)
        let sameDay = exchange(id: "same", outcome: .failed, at: 1_700_000_010_000)
        let later = exchange(id: "later", outcome: .notShared, at: 1_700_000_000_000 + day * 2)

        let groups = privacyFeedDays([first, later, sameDay], now: later.presentationTimestamp)

        XCTAssertEqual(groups.map(\.exchanges.count), [2, 1])
        XCTAssertEqual(groups[0].exchanges.map(\.taskId), ["first", "same"])
        XCTAssertEqual(groups[1].heading, "Today")
    }

    func testMissingInstantGetsAnExplicitHeading() {
        let groups = privacyFeedDays(
            [exchange(outcome: .shared, at: 0)],
            now: 1_700_000_000_000
        )
        XCTAssertEqual(groups.first?.heading, "Date unknown")
    }

    private func exchange(
        id: String = "task-example",
        outcome: PrivacyExchangeOutcome,
        at: Int64 = 1_700_000_000_000
    )
        -> PrivacyExchangePresentation {
        PrivacyExchangePresentation(
            taskId: id,
            conversationId: "conversation-example",
            workflowId: "workflow-example",
            externalAgent: PrivacyExternalAgent(displayName: "Atlas", source: .token),
            workflow: PrivacyExchangeWorkflow(name: "Example workflow", purpose: "Invented purpose"),
            question: "What changed in the fictional project?",
            status: .released,
            outcome: outcome,
            createdAt: at,
            resolvedAt: nil,
            sharedAt: nil,
            sharedAnswer: nil,
            pendingCandidate: nil,
            reductions: [],
            approval: nil,
            userDecision: nil,
            review: nil
        )
    }
}
