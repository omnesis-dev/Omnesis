// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// What the operator is told about a held answer: why Omnesis paused, which
/// findings are meaningful enough to show, and how a category reads as a chip.
final class PrivacyReviewCopyTests: XCTestCase {
    func testPauseCopyDistinguishesAnUnavailableCheckFromAPolicyHold() {
        let unavailable = privacyPauseCopy(fallbackCause: .requestFailed, rationale: "ignored")
        XCTAssertEqual(unavailable.title, "Automatic privacy check unavailable")

        let hardStop = privacyPauseCopy(fallbackCause: .hardStop, rationale: "ignored")
        XCTAssertEqual(hardStop.title, "This answer cannot be shared")

        let held = privacyPauseCopy(fallbackCause: .policyRequiresReview, rationale: "Exact address.")
        XCTAssertEqual(held.title, "Your privacy policy asks you to decide")
        XCTAssertEqual(held.message, "Exact address.")

        let blank = privacyPauseCopy(fallbackCause: nil, rationale: "   ")
        XCTAssertEqual(blank.message, "Nothing will be shared unless you approve this exact answer.")
    }

    /// Whose sentence the pause message is decides how the card shows it: the
    /// reviewer's own words are quoted, copy Omnesis wrote is not.
    func testPauseCopyMarksTheReviewersOwnWords() {
        let held = privacyPauseCopy(fallbackCause: .policyRequiresReview, rationale: "Exact address.")
        XCTAssertTrue(held.quotesTheReviewer)

        let hardStop = privacyPauseCopy(fallbackCause: .hardStop, rationale: "Exact address.")
        XCTAssertFalse(hardStop.quotesTheReviewer)

        let unavailable = privacyPauseCopy(fallbackCause: .requestFailed, rationale: "Exact address.")
        XCTAssertFalse(unavailable.quotesTheReviewer)

        let blank = privacyPauseCopy(fallbackCause: nil, rationale: "   ")
        XCTAssertFalse(blank.quotesTheReviewer)
    }

    /// Findings from a check that never ran mean nothing, so they are dropped.
    func testFindingsAreSuppressedWhenTheCheckCouldNotRun() {
        let findings = [finding(category: "schedule", disposition: .approval)]
        XCTAssertTrue(
            privacyReviewFindings(fallbackCause: .notConfigured, findings: findings).isEmpty
        )
        XCTAssertEqual(
            privacyReviewFindings(fallbackCause: .policyRequiresReview, findings: findings).count,
            1
        )
        XCTAssertEqual(privacyReviewFindings(fallbackCause: .hardStop, findings: findings).count, 1)
    }

    /// The gateway's full cause list decodes, and only the four causes that
    /// mean the check never ran suppress its findings — the same four the
    /// portal and Android use, so no surface hides what the others show.
    func testEveryReviewerFallbackCauseDecodesAndOnlyFourSuppressFindings() {
        let decoded = [
            "not_configured", "request_failed", "context_window_exceeded", "output_truncated",
            "invalid_output", "low_confidence", "policy_requires_review", "hard_stop",
        ].map { raw -> PrivacyReviewFallbackCause in
            let data = Data("\"\(raw)\"".utf8)
            return (try? JSONDecoder().decode(PrivacyReviewFallbackCause.self, from: data))
                ?? .unknown
        }
        XCTAssertFalse(decoded.contains(.unknown), "every gateway cause has a case of its own")

        let suppressing = decoded.filter { privacyReviewUnavailable($0) }
        XCTAssertEqual(
            suppressing,
            [.notConfigured, .requestFailed, .invalidOutput, .lowConfidence]
        )
    }

    /// A cause invented by a newer gateway reads as an ordinary hold, findings
    /// intact — the answer is held either way, and hiding what the check found
    /// would tell the operator less than every other surface does.
    func testAnUnrecognisedCauseKeepsTheFindingsAndThePolicyWording() {
        let unknown = (try? JSONDecoder().decode(
            PrivacyReviewFallbackCause.self,
            from: Data("\"a_cause_from_the_future\"".utf8)
        ))
        XCTAssertEqual(unknown, .unknown)
        XCTAssertFalse(privacyReviewUnavailable(.unknown))

        let findings = [finding(category: "schedule", disposition: .approval)]
        XCTAssertEqual(
            privacyReviewFindings(fallbackCause: .unknown, findings: findings).count,
            1
        )
        XCTAssertEqual(
            privacyPauseCopy(fallbackCause: .unknown, rationale: "Exact address.").title,
            "Your privacy policy asks you to decide"
        )
        XCTAssertEqual(
            privacyPauseCopy(fallbackCause: .contextWindowExceeded, rationale: "Reviewer ran long.")
                .message,
            "Reviewer ran long."
        )
    }

    func testFindingLabelsAreHumanDeduplicatedAndCapped() {
        let labels = privacyFindingLabels(
            [
                finding(category: "schedule", disposition: .approval),
                finding(category: "schedule", disposition: .approval),
                finding(category: "home_address", detailLevel: .exact, disposition: .approval),
                finding(category: "money", subject: .otherPerson, disposition: .deny),
                finding(category: "health", disposition: .deny),
                finding(category: "photos", disposition: .deny),
            ],
            limit: 4
        )

        XCTAssertEqual(labels, ["Schedule", "Exact home address", "Another person", "Health"])
    }

    private func finding(
        category: String,
        detailLevel: PrivacyDetailLevel = .summary,
        subject: PrivacyFindingSubject = .user,
        disposition: PrivacyFindingDisposition
    )
        -> PrivacyFinding {
        PrivacyFinding(
            category: category,
            detailLevel: detailLevel,
            subject: subject,
            disposition: disposition,
            description: "An invented finding."
        )
    }
}
