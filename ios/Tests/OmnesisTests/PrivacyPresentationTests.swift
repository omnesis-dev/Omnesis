// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Privacy vocabulary: what a screen says, and which tone it says it in.
final class PrivacyPresentationTests: XCTestCase {
    func testForegroundLoadBlocksBackgroundPoll() throws {
        var arbiter = PrivacyExchangeLoadArbiter()
        let foreground = arbiter.begin(background: false)

        XCTAssertNotNil(foreground)
        XCTAssertNil(arbiter.begin(background: true))
        XCTAssertTrue(try arbiter.owns(XCTUnwrap(foreground)))

        arbiter.finish(background: false)
        XCTAssertNotNil(arbiter.begin(background: true))
    }

    func testForegroundLoadSupersedesAnOlderBackgroundPoll() throws {
        var arbiter = PrivacyExchangeLoadArbiter()
        let background = arbiter.begin(background: true)
        let foreground = arbiter.begin(background: false)

        XCTAssertNotNil(background)
        XCTAssertNotNil(foreground)
        XCTAssertFalse(try arbiter.owns(XCTUnwrap(background)))
        XCTAssertTrue(try arbiter.owns(XCTUnwrap(foreground)))

        arbiter.finish(background: false)
        arbiter.finish(background: true)
    }

    // MARK: - The caller's name

    /// A caller's display name often trails the registry slug it connected
    /// under. Narrative surfaces drop it; `externalAgentFullName` keeps it.
    func testNarrativeNameStripsOnlyABareLowercaseRegistrySlug() {
        let cases: [(String, String)] = [
            ("Atlas (openclaw)", "Atlas"),
            ("Atlas (hermes)", "Atlas"),
            ("Atlas  (open-claw.v2)", "Atlas"),
            // A caller that genuinely names itself this way keeps every word.
            ("Acme (support desk)", "Acme (support desk)"),
            ("Acme (Support)", "Acme (Support)"),
            ("Acme (2 desks)", "Acme (2 desks)"),
            ("Atlas", "Atlas"),
            // Stripping must never leave an empty name behind.
            ("(openclaw)", "(openclaw)"),
        ]

        for (displayName, expected) in cases {
            let agent = PrivacyExternalAgent(displayName: displayName, source: .token)
            XCTAssertEqual(externalAgentNarrativeName(agent), expected, "name: \(displayName)")
            XCTAssertEqual(externalAgentFullName(agent), displayName, "name: \(displayName)")
        }
    }

    func testUnnamedCallerFallsBackToAGenericLabel() {
        XCTAssertEqual(externalAgentNarrativeName(nil), "External agent")
        XCTAssertEqual(externalAgentRecipientName(nil), "the external agent")
        XCTAssertEqual(
            externalAgentNarrativeName(PrivacyExternalAgent(displayName: "  ", source: .fallback)),
            "External agent"
        )
    }

    func testServerNarrativeNameWinsAndIdentityFactsOmitABlankConnection() {
        let principal = PrivacyExternalAgent(
            displayName: "Research assistant (openclaw)",
            narrativeName: "Project researcher",
            integrationSlug: "openclaw",
            connectionName: "  Laptop client  ",
            source: .principal
        )
        XCTAssertEqual(externalAgentNarrativeName(principal), "Project researcher")
        XCTAssertEqual(
            privacyExternalAgentFacts(principal),
            PrivacyExternalAgentFacts(
                identityLabel: "Principal",
                principal: "Research assistant (openclaw)",
                connection: "Laptop client"
            )
        )

        let legacy = PrivacyExternalAgent(displayName: "Atlas (openclaw)", source: .token)
        XCTAssertEqual(externalAgentNarrativeName(legacy), "Atlas")
        XCTAssertEqual(privacyExternalAgentFacts(legacy).identityLabel, "Caller")
        XCTAssertEqual(privacyExternalAgentFacts(legacy).connection, nil)
    }

    // MARK: - Outcome vocabulary

    /// Every outcome that left the machine takes a released tone and every
    /// outcome where nothing did takes a withheld one, so the palette answers
    /// "did it leave?" on its own.
    func testOutcomeVocabularyIsClosedAndSortsByWhetherAnythingLeft() {
        XCTAssertEqual(privacyOutcomeDisplay(.shared).label, "Shared with the agent")
        XCTAssertEqual(privacyOutcomeDisplay(.shared).tone, .released)
        XCTAssertEqual(privacyOutcomeDisplay(.sharedWithReductions).tone, .reduced)
        XCTAssertEqual(privacyOutcomeDisplay(.needsReview).tone, .review)
        XCTAssertEqual(privacyOutcomeDisplay(.notShared).tone, .kept)
        XCTAssertEqual(privacyOutcomeDisplay(.canceled).tone, .kept)
        XCTAssertEqual(privacyOutcomeDisplay(.failed).tone, .failed)
        // An outcome this client does not know is never rendered as a fact.
        XCTAssertEqual(privacyOutcomeDisplay(.unknown).label, "Checking")
    }

    func testConcreteOutcomeNamesThePrincipal() {
        XCTAssertEqual(
            privacyExchangeOutcomeDisplay(exchange(outcome: .ready)).label,
            "Approved, waiting for Atlas"
        )
        XCTAssertEqual(
            privacyExchangeOutcomeDisplay(exchange(outcome: .shared)).label,
            "Shared with Atlas"
        )
        XCTAssertEqual(
            privacyExchangeOutcomeDisplay(exchange(outcome: .sharedWithReductions)).label,
            "Shared with Atlas, with details removed"
        )
    }

    func testAuditStatusTonesMatchTheirMeaning() {
        XCTAssertEqual(privacyAuditStatusTone(.allowed), .released)
        XCTAssertEqual(privacyAuditStatusTone(.reduced), .reduced)
        XCTAssertEqual(privacyAuditStatusTone(.held), .review)
        XCTAssertEqual(privacyAuditStatusTone(.blocked), .kept)
    }

    // MARK: - The decision, as a sentence

    func testDecisionCopyAlwaysSaysWhetherAnythingLeft() {
        XCTAssertEqual(
            privacyExchangeDecisionCopy(exchange(outcome: .shared)),
            "Your policy allowed this answer, and Atlas received it."
        )
        XCTAssertEqual(
            privacyExchangeDecisionCopy(exchange(outcome: .shared, userDecision: .approved)),
            "You shared this once, and Atlas received it."
        )
        XCTAssertEqual(
            privacyExchangeDecisionCopy(exchange(outcome: .ready, userDecision: .approved)),
            "You approved this once. Atlas has not received it yet."
        )
        XCTAssertEqual(
            privacyExchangeDecisionCopy(exchange(outcome: .needsReview)),
            "Omnesis is holding this answer until you decide. Nothing has been shared."
        )
        XCTAssertEqual(
            privacyExchangeDecisionCopy(exchange(outcome: .notShared, userDecision: .denied)),
            "You chose not to share. Nothing was shared."
        )
        XCTAssertEqual(
            privacyExchangeDecisionCopy(exchange(outcome: .canceled)),
            "The request was canceled. Nothing was shared."
        )
    }

    func testDecisionCopySeparatesAnAutomaticBlockFromOneAfterYourApproval() {
        let automatic = exchange(outcome: .notShared, fallbackCause: .hardStop)
        XCTAssertEqual(
            privacyExchangeDecisionCopy(automatic),
            "Omnesis blocked this answer automatically. Nothing was shared."
        )

        let afterApproval = exchange(
            outcome: .notShared,
            userDecision: .approvedButBlocked,
            fallbackCause: .hardStop
        )
        XCTAssertEqual(
            privacyExchangeDecisionCopy(afterApproval),
            "You approved this once, but Omnesis blocked it. Nothing was shared."
        )
    }

    func testDecisionCopyExplainsWhenAnUnattendedRequestCouldNotAskForApproval() {
        let unattended = exchange(
            outcome: .notShared,
            approvalStatus: nil,
            denialReason: .approvalNotAvailable
        )

        XCTAssertEqual(
            privacyExchangeDecisionCopy(unattended),
            "The privacy check recommended approval, but this request has no approval flow. "
                + "Omnesis did not share the answer."
        )
    }

    func testSharedOutcomeWinsOverAContradictoryUnavailableApprovalReason() {
        let contradictory = exchange(
            outcome: .shared,
            denialReason: .approvalNotAvailable
        )

        XCTAssertEqual(
            privacyExchangeDecisionCopy(contradictory),
            "Your policy allowed this answer, and Atlas received it."
        )
    }

    func testDisplayedAnswerPrefersTheLocalDraftWithoutCallingItShared() throws {
        let displayed = try XCTUnwrap(
            privacyDisplayedAnswer(
                exchange(
                    outcome: .sharedWithReductions,
                    sharedAnswer: "A broad invented summary.",
                    draftAnswer: "An exact invented draft.",
                    pendingCandidate: nil
                )
            )
        )

        XCTAssertEqual(displayed, PrivacyDisplayedAnswer(text: "An exact invented draft.", role: "draft answer"))
    }

    func testDisplayedAnswerTreatsABlankRecordedDraftAsUnavailable() {
        let unattended = exchange(
            outcome: .notShared,
            approvalStatus: nil,
            denialReason: .approvalNotAvailable,
            sharedAnswer: nil,
            draftAnswer: "  \n",
            pendingCandidate: nil
        )

        XCTAssertNil(privacyDisplayedAnswer(unattended))
    }

    func testRunningExchangeTruthfullyDescribesDraftGenerationAndNeedsPolling() {
        let running = exchange(
            status: .running,
            outcome: .checking,
            approvalStatus: nil,
            sharedAnswer: nil,
            draftAnswer: nil,
            pendingCandidate: nil
        )

        XCTAssertTrue(privacyExchangeNeedsPolling(running))
        XCTAssertEqual(privacyDraftActorLabel(running), "Omnesis is drafting an answer")
        XCTAssertEqual(
            privacyUnavailableDraftCopy(running),
            "No draft has been recorded yet. Nothing has left this machine."
        )

        let drafted = exchange(
            status: .running,
            outcome: .checking,
            approvalStatus: nil,
            draftAnswer: "An invented local draft.",
            pendingCandidate: nil
        )
        XCTAssertEqual(privacyDraftActorLabel(drafted), "Omnesis drafted an answer")
    }

    func testFailureCopyDistinguishesAnUnavailableCheckFromAnInternalFailure() {
        XCTAssertEqual(
            privacyExchangeDecisionCopy(exchange(outcome: .failed, fallbackCause: .requestFailed)),
            "Omnesis could not verify this automatically. Nothing was shared."
        )
        XCTAssertEqual(
            privacyExchangeDecisionCopy(exchange(outcome: .failed, pendingCandidate: nil)),
            "The privacy check did not run because Omnesis produced no answer. Nothing was shared."
        )
    }

    func testFailureCardsAreMutuallyExclusive() {
        let generation = exchange(outcome: .failed, pendingCandidate: nil)
        XCTAssertTrue(privacyAnswerGenerationFailed(generation))
        XCTAssertFalse(privacyReviewFailed(generation))

        let review = exchange(outcome: .failed, draftAnswer: "An invented draft.", pendingCandidate: nil)
        XCTAssertFalse(privacyAnswerGenerationFailed(review))
        XCTAssertTrue(privacyReviewFailed(review))
        XCTAssertEqual(
            privacyExchangeOutcomeDisplay(generation).label,
            "Nothing shared; answer failed"
        )
        XCTAssertEqual(
            privacyExchangeOutcomeDisplay(review).label,
            "Nothing shared; privacy check failed"
        )

        let legacyReview = exchange(
            outcome: .failed,
            fallbackCause: .requestFailed,
            pendingCandidate: nil
        )
        XCTAssertFalse(privacyAnswerGenerationFailed(legacyReview))
        XCTAssertTrue(privacyReviewFailed(legacyReview))

        let authoritativeGeneration = exchange(
            outcome: .failed,
            draftAnswer: "An invented draft.",
            pendingCandidate: nil,
            failureStage: .answerGeneration
        )
        XCTAssertTrue(privacyAnswerGenerationFailed(authoritativeGeneration))
        XCTAssertFalse(privacyReviewFailed(authoritativeGeneration))
        XCTAssertEqual(privacyDraftActorLabel(authoritativeGeneration), "Omnesis could not draft an answer")

        let authoritativeReview = exchange(
            outcome: .failed,
            pendingCandidate: nil,
            failureStage: .privacyCheck
        )
        XCTAssertFalse(privacyAnswerGenerationFailed(authoritativeReview))
        XCTAssertTrue(privacyReviewFailed(authoritativeReview))
    }

    // MARK: - Whose words a ledger step carries

    /// The five steps whose body is the exchange's own words are quoted; every
    /// other step speaks in Omnesis's voice and is not.
    func testOnlyTheStepsCarryingTheExchangesOwnWordsAreQuoted() {
        XCTAssertEqual(privacyAuditQuotedBodyRole(.externalRequest), "question")
        XCTAssertEqual(privacyAuditQuotedBodyRole(.candidateGenerated), "draft answer")
        XCTAssertEqual(privacyAuditQuotedBodyRole(.reductionGenerated), "reduced answer")
        XCTAssertEqual(privacyAuditQuotedBodyRole(.privacyReview), "privacy check summary")
        XCTAssertEqual(privacyAuditQuotedBodyRole(.released), "answer that was shared")

        for kind in [
            PrivacyAuditEventKind.agentTrace, .approvalRequested, .approvalResolved,
            .denied, .failed, .truncated, .egress, .unknown,
        ] {
            XCTAssertNil(privacyAuditQuotedBodyRole(kind), "\(kind) speaks for Omnesis")
        }
    }

    // MARK: - Feed shape

    func testOnlyAPendingApprovalCountsAsWaitingOnYou() {
        XCTAssertTrue(privacyExchangeIsPendingReview(exchange(outcome: .needsReview)))
        XCTAssertFalse(
            privacyExchangeIsPendingReview(
                exchange(outcome: .needsReview, approvalStatus: .expired)
            )
        )
        XCTAssertFalse(privacyExchangeIsPendingReview(exchange(outcome: .shared)))
    }

    // MARK: - The spine's running order

    private func auditEvent(_ id: String, _ kind: PrivacyAuditEventKind, at: Int64)
        -> PrivacyAuditEventSummary {
        PrivacyAuditEventSummary(
            id: id,
            taskId: "task-1",
            kind: kind,
            createdAt: at,
            display: PrivacyAuditEventDisplay(title: id),
            answerComparison: nil
        )
    }

    func testTheSpineRunsInTheLedgersOrder() {
        let ledger = [
            auditEvent("request", .externalRequest, at: 1000),
            auditEvent("trace", .agentTrace, at: 2000),
            auditEvent("draft", .candidateGenerated, at: 3000),
            auditEvent("review", .privacyReview, at: 4000),
            auditEvent("release", .released, at: 5000),
            auditEvent("egress", .egress, at: 6000),
        ]

        let order = privacySpineOrder(exchange: exchange(), events: ledger)

        // The agent's step was recorded before the draft, so it sits above the
        // draft card: the ledger decides, not the card's importance.
        XCTAssertEqual(order.inside.map(\.id), ["trace", "draft", "review"])
        XCTAssertEqual(order.askedAt, 1000)
        XCTAssertEqual(order.released?.id, "release")
        XCTAssertEqual(order.afterRelease.map(\.id), ["egress"])
    }

    /// A ledger that recorded neither landmark still gets both cards: one says
    /// Omnesis is drafting, the other carries the decision and its buttons.
    func testBothCardsRenderEvenWhenNothingWroteThemDown() {
        let order = privacySpineOrder(exchange: exchange(), events: [])

        XCTAssertEqual(order.inside.map(\.id), ["draft", "check"])
        XCTAssertEqual(order.askedAt, 100)
        XCTAssertNil(order.released)
        XCTAssertTrue(order.afterRelease.isEmpty)
    }

    func testOnlyTheFirstMomentOfEachDayCarriesItsDate() {
        let day: Int64 = 24 * 60 * 60 * 1000
        let breaks = privacyDayBreaks([
            ("a", 1_700_000_000_000),
            ("b", 1_700_000_010_000),
            ("c", 1_700_000_000_000 + day * 2),
            // A moment with no instant cannot open a day, and must not end the
            // run either.
            ("d", nil),
        ])

        XCTAssertEqual(breaks, ["a", "c"])
    }

    // MARK: - The pinned review

    func testPendingReviewIsOnlyBuiltFromAnExchangeStillAwaitingADecision() {
        XCTAssertNil(PrivacyPendingReview(exchange: exchange(outcome: .shared)))
        XCTAssertNil(
            PrivacyPendingReview(
                exchange: exchange(outcome: .needsReview, approvalStatus: .denied)
            )
        )
    }

    func testPendingReviewUsesTheNarrativeNameAndDetectsABlankCandidate() {
        let review = PrivacyPendingReview(detail: approvalDetail(candidateAnswer: "   "))
        XCTAssertEqual(review.agentName, "Atlas")
        XCTAssertFalse(review.candidateAvailable)
        XCTAssertTrue(PrivacyPendingReview(detail: approvalDetail()).candidateAvailable)
    }

    // MARK: - What to say after a decision

    func testResolutionCopySeparatesABlockFromAnOrdinaryRefusal() {
        let released = privacyResolutionCopy(
            resolution(status: .released),
            agentName: "Atlas"
        )
        XCTAssertEqual(released.title, "Answer approved")
        XCTAssertEqual(released.message, "The answer is ready for Atlas when it returns.")
        XCTAssertEqual(
            privacyResolutionCopy(resolution(status: .releasedWithReductions)).title,
            "Answer approved"
        )

        let blocked = privacyResolutionCopy(resolution(status: .denied, reason: "hard_stop"))
        XCTAssertEqual(blocked.title, "Answer blocked")
        XCTAssertFalse(blocked.ok)

        let expired = privacyResolutionCopy(resolution(status: .denied, reason: "expired"))
        XCTAssertEqual(expired.title, "Approval expired")

        let refused = privacyResolutionCopy(resolution(status: .denied, reason: "user_denied"))
        XCTAssertEqual(refused.title, "Answer not shared")
        XCTAssertTrue(refused.ok)
    }

    // MARK: - Fixtures

    private func resolution(
        status: PrivacyAnswerStatus,
        reason: String? = nil
    )
        -> PrivacyApprovalResolution {
        PrivacyApprovalResolution(
            status: status,
            workflowId: "workflow-1",
            conversationId: "conversation-1",
            taskId: "task-1",
            releaseId: nil,
            answer: nil,
            reductions: nil,
            reason: reason
        )
    }

    private func exchange(
        taskId: String = "task-1",
        workflowId: String = "workflow-1",
        workflowName: String = "Prepare itinerary",
        status: PrivacyTaskAuditStatus = .approvalRequired,
        outcome: PrivacyExchangeOutcome = .shared,
        approvalStatus: PrivacyApprovalStatus? = .pending,
        userDecision: PrivacyExchangeUserDecision? = nil,
        fallbackCause: PrivacyReviewFallbackCause? = nil,
        denialReason: PrivacyExchangeDenialReason? = nil,
        sharedAnswer: String? = nil,
        draftAnswer: String? = nil,
        pendingCandidate: String? = "Thursday afternoon.",
        failureStage: PrivacyExchangeFailure.Stage? = nil
    )
        -> PrivacyExchangePresentation {
        PrivacyExchangePresentation(
            taskId: taskId,
            conversationId: "conversation-1",
            workflowId: workflowId,
            externalAgent: PrivacyExternalAgent(displayName: "Atlas (openclaw)", source: .token),
            workflow: PrivacyExchangeWorkflow(name: workflowName, purpose: "Compare routes"),
            question: "When is the user free?",
            status: status,
            outcome: outcome,
            createdAt: 100,
            resolvedAt: 110,
            sharedAnswer: sharedAnswer,
            draftAnswer: draftAnswer,
            pendingCandidate: pendingCandidate,
            reductions: [],
            approval: approvalStatus.map {
                PrivacyExchangeApproval(id: "approval-1", status: $0, expiresAt: 200, resolvedAt: nil)
            },
            userDecision: userDecision,
            denialReason: denialReason,
            review: PrivacyExchangeReview(
                fallbackCause: fallbackCause,
                findings: [],
                rationale: "An invented rationale."
            ),
            failure: failureStage.map {
                PrivacyExchangeFailure(code: "invented_failure", message: "An invented failure.", stage: $0)
            }
        )
    }

    private func approvalDetail(candidateAnswer: String? = "Thursday afternoon.")
        -> PrivacyApprovalDetail {
        PrivacyApprovalDetail(
            id: "approval-1",
            taskId: "task-1",
            workflowId: "workflow-1",
            conversationId: "conversation-1",
            workflowName: "Prepare itinerary",
            externalAgent: PrivacyExternalAgent(displayName: "Atlas (openclaw)", source: .token),
            status: .pending,
            createdAt: 100,
            expiresAt: 200,
            resolvedAt: nil,
            workflowPurpose: "Compare routes",
            question: "When is the user free?",
            candidateAnswer: candidateAnswer,
            review: PrivacyReviewRecord(
                recipeVersion: "privacy-review-v1",
                provider: nil,
                model: nil,
                confidence: nil,
                policyRevision: "rev-1",
                findings: [],
                rationale: "An invented rationale."
            )
        )
    }
}
