// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The documents an answer cites: how the three exchange lists and the held
/// approval's list decode, and how the Privacy screens compare a draft's
/// citations with what left or would leave.
final class PrivacyCitationTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    // MARK: - Decoding

    func testExchangeDecodesTheThreeCitationLists() throws {
        let exchange = try decodeExchange(citations: """
        "sharedCitations":[{"documentId":"doc-1","sourceType":"gmail","title":"Q4 budget review",
        "timestamp":"2026-09-14T09:30:00Z","sourceUrl":"https://mail.example.com/m/1",
        "appUrl":"mail-example:///m/1"}],
        "draftCitations":[{"documentId":"doc-1","sourceType":"gmail","title":"Q4 budget review"},
        {"documentId":"doc-2","sourceType":"notion"}],
        "pendingCitations":[],
        """)

        XCTAssertEqual(exchange.sharedCitations, [
            AnswerCitation(
                documentId: "doc-1",
                sourceType: "gmail",
                title: "Q4 budget review",
                timestamp: "2026-09-14T09:30:00Z",
                sourceUrl: "https://mail.example.com/m/1",
                appUrl: "mail-example:///m/1"
            ),
        ])
        XCTAssertEqual(exchange.draftCitations.map(\.documentId), ["doc-1", "doc-2"])
        XCTAssertNil(exchange.draftCitations[1].title)
        XCTAssertEqual(exchange.pendingCitations, [])
        XCTAssertEqual(exchange.externallyVisibleCitations?.map(\.documentId), ["doc-1"])
    }

    func testExchangeFromAGatewayWithoutCitationsDecodesToEmptyLists() throws {
        let exchange = try decodeExchange(citations: "")

        XCTAssertEqual(exchange.sharedCitations, [])
        XCTAssertEqual(exchange.draftCitations, [])
        XCTAssertEqual(exchange.pendingCitations, [])
        XCTAssertEqual(exchange.sharedAnswer, "Available Thursday.")
    }

    func testMalformedCitationIsSkippedAndAMistypedFieldReadsAsWithheld() throws {
        let exchange = try decodeExchange(citations: """
        "sharedCitations":[{"sourceType":"gmail","title":"No id"},
        {"documentId":"doc-2","sourceType":"gmail","timestamp":42,"sourceUrl":"https://mail.example.com/m/2"},
        "not a citation"],
        "draftCitations":{"documentId":"doc-3"},
        """)

        XCTAssertEqual(exchange.sharedCitations, [
            AnswerCitation(documentId: "doc-2", sourceType: "gmail", sourceUrl: "https://mail.example.com/m/2"),
        ])
        XCTAssertEqual(exchange.draftCitations, [])
        XCTAssertEqual(exchange.status, .releasedWithReductions)
    }

    func testApprovalDetailDecodesCandidateCitations() throws {
        let approval = try decodeApproval(citations: """
        "candidateCitations":[{"documentId":"doc-1","sourceType":"google-calendar",
        "title":"Venue walkthrough","sourceUrl":"https://calendar.example.com/e/1"}],
        """)

        XCTAssertEqual(approval.candidateCitations, [
            AnswerCitation(
                documentId: "doc-1",
                sourceType: "google-calendar",
                title: "Venue walkthrough",
                sourceUrl: "https://calendar.example.com/e/1"
            ),
        ])
        XCTAssertEqual(PrivacyPendingReview(detail: approval).citations.map(\.documentId), ["doc-1"])
    }

    func testApprovalDetailFromAGatewayWithoutCitationsStillDecodes() throws {
        let approval = try decodeApproval(citations: "")

        XCTAssertEqual(approval.candidateCitations, [])
        XCTAssertEqual(approval.candidateAnswer, "Thursday afternoon.")
        XCTAssertEqual(approval.externalAgent?.displayName, "Research assistant")
        XCTAssertNil(approval.sharedAt)
    }

    func testApprovalDetailStillRequiresTheFieldsTheDecisionRestsOn() {
        let json = #"{"id":"approval-1","taskId":"task-1"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(PrivacyApprovalDetail.self, from: Data(json.utf8)))
    }

    // MARK: - Rows

    func testRowWithoutATitleAndFormatsTheDateAsADay() {
        let row = privacyCitationRow(
            AnswerCitation(documentId: "doc-1", sourceType: "notion", title: "  ", timestamp: "2026-09-14T09:30:00.250Z"),
            timeZone: utc
        )

        XCTAssertNil(row.title)
        XCTAssertEqual(row.sourceType, "notion")
        XCTAssertTrue(row.date?.contains("2026") == true)
        XCTAssertTrue(row.date?.contains("14") == true)
        XCTAssertEqual(row.links, [])
        XCTAssertFalse(row.marksWithheld)
    }

    func testUnreadableDateIsLeftOut() {
        XCTAssertNil(privacyCitationDate("last Tuesday"))
        XCTAssertNil(privacyCitationDate(nil))
    }

    func testLinksPrintTheWebLinkThenTheAppLinkWhichFallsBackToIt() {
        let links = privacyCitationRow(AnswerCitation(
            documentId: "doc-1",
            sourceType: "gmail",
            sourceUrl: "https://mail.example.com/m/1",
            appUrl: "mail-example:///m/1"
        )).links

        XCTAssertEqual(links.map(\.label), ["Link", "App link"])
        XCTAssertEqual(links.map(\.text), ["https://mail.example.com/m/1", "mail-example:///m/1"])
        XCTAssertEqual(links[0].openURLs.map(\.absoluteString), ["https://mail.example.com/m/1"])
        XCTAssertEqual(links[1].openURLs.map(\.absoluteString), ["mail-example:///m/1", "https://mail.example.com/m/1"])
        XCTAssertEqual(links.map(\.struck), [false, false])
    }

    func testABlockedSchemeStaysVisibleButUnopenable() {
        let links = privacyCitationRow(AnswerCitation(
            documentId: "doc-2",
            sourceType: "files",
            sourceUrl: "file:///Users/example/notes.txt"
        )).links

        XCTAssertEqual(links.map(\.text), ["file:///Users/example/notes.txt"])
        XCTAssertEqual(links[0].openURLs, [])
        XCTAssertFalse(links[0].struck)
    }

    // MARK: - Against the draft

    func testWithoutABaselineEveryCitationIsListedPlainly() {
        let rows = privacyCitationRows([citation("doc-1", title: "A")], baseline: nil)

        XCTAssertEqual(rows.map(\.id), ["doc-1"])
        XCTAssertFalse(rows[0].removed)
        XCTAssertFalse(rows[0].marksWithheld)
    }

    func testACitationTheDraftHadAndTheListLacksIsKeptAndRemoved() {
        let rows = privacyCitationRows(
            [citation("doc-2", title: "B")],
            baseline: [citation("doc-1", title: "A", web: "https://mail.example.com/m/1"), citation("doc-2", title: "B")]
        )

        XCTAssertEqual(rows.map(\.id), ["doc-1", "doc-2"])
        XCTAssertEqual(rows.map(\.removed), [true, false])
        XCTAssertEqual(rows[0].title, "A")
        XCTAssertFalse(rows[0].titleWithheld)
        // A withheld citation's link is printed, struck, and never opens.
        XCTAssertEqual(rows[0].links.map(\.struck), [true])
        XCTAssertEqual(rows[0].links.map(\.withheld), [false])
        XCTAssertEqual(rows[0].links[0].openURLs, [])
        XCTAssertTrue(rows[0].marksWithheld)
    }

    func testAFieldWithheldFromAKeptCitationIsPrintedFromTheDraftAndCannotOpen() {
        let draft = AnswerCitation(
            documentId: "doc-1",
            sourceType: "google-calendar",
            title: "Venue walkthrough",
            timestamp: "2026-09-14T09:30:00Z",
            sourceUrl: "https://calendar.example.com/e/1",
            appUrl: "calendar-example://e/1"
        )
        let kept = AnswerCitation(
            documentId: "doc-1",
            sourceType: "google-calendar",
            appUrl: "calendar-example://e/1"
        )

        let row = privacyCitationRows([kept], baseline: [draft], timeZone: utc)[0]

        XCTAssertFalse(row.removed)
        XCTAssertEqual(row.title, "Venue walkthrough")
        XCTAssertTrue(row.titleWithheld)
        XCTAssertTrue(row.dateWithheld)
        XCTAssertNotNil(row.date)
        XCTAssertEqual(row.links.map(\.label), ["Link", "App link"])
        XCTAssertEqual(row.links.map(\.withheld), [true, false])
        XCTAssertEqual(row.links.map(\.struck), [true, false])
        XCTAssertEqual(row.links[0].openURLs, [])
        // The released app link no longer falls back to the withheld web link.
        XCTAssertEqual(row.links[1].openURLs.map(\.absoluteString), ["calendar-example://e/1"])
    }

    func testACitationTheDraftNeverRecordedFollowsTheDraftsOwn() {
        let rows = privacyCitationRows(
            [citation("doc-9", title: "Z"), citation("doc-1", title: "A")],
            baseline: [citation("doc-1", title: "A")]
        )

        XCTAssertEqual(rows.map(\.id), ["doc-1", "doc-9"])
        XCTAssertFalse(rows.contains(where: \.marksWithheld))
    }

    func testTheWithheldNoteAppearsOnlyWhenSomethingIsMarked() throws {
        let plain = try XCTUnwrap(privacyCitationList([citation("doc-1", title: "A")], heading: "H"))
        XCTAssertNil(plain.withheldNote)

        let marked = try XCTUnwrap(privacyCitationList(
            [],
            baseline: [citation("doc-1", title: "A")],
            heading: "H"
        ))
        XCTAssertEqual(
            marked.withheldNote,
            "Marked withheld: in the draft, removed by the privacy check. It did not leave this machine."
        )
        XCTAssertNil(privacyCitationList([], heading: "H"))
    }

    // MARK: - Which list a screen shows

    func testDraftCardListsTheDraftsCitationsWithoutAComparison() throws {
        let list = try XCTUnwrap(privacyDraftCitationList(exchange(
            outcome: .sharedWithReductions,
            shared: [citation("doc-1", title: "A")],
            draft: [citation("doc-1", title: "A"), citation("doc-2", title: "B")]
        )))

        XCTAssertEqual(list.heading, "Cited in this draft")
        XCTAssertNil(list.note)
        XCTAssertEqual(list.rows.map(\.id), ["doc-1", "doc-2"])
        XCTAssertNil(list.withheldNote)
    }

    func testSharedListComparesWhatLeftWithTheDraft() throws {
        let list = try XCTUnwrap(privacySharedCitationList(exchange(
            outcome: .sharedWithReductions,
            shared: [citation("doc-1", title: "A")],
            draft: [citation("doc-1", title: "A"), citation("doc-2", title: "B")]
        )))

        XCTAssertEqual(list.heading, "Citations shared")
        XCTAssertEqual(list.rows.map(\.removed), [false, true])
        XCTAssertNotNil(list.withheldNote)
    }

    func testSharedListWithoutARecordedDraftListsWhatLeftPlainly() throws {
        let list = try XCTUnwrap(privacySharedCitationList(exchange(
            outcome: .shared,
            shared: [citation("doc-1", title: "A")],
            draft: [citation("doc-2", title: "B")],
            draftAnswer: nil
        )))

        XCTAssertEqual(list.rows.map(\.id), ["doc-1"])
        XCTAssertNil(list.withheldNote)
    }

    func testCitationsRecordedAsSharedAreNeverShownForAnExchangeThatDidNotShare() {
        XCTAssertNil(privacySharedCitationList(exchange(
            outcome: .notShared,
            shared: [citation("doc-1", title: "A")],
            sharedAnswer: "Leaked?"
        )))
    }

    func testPendingListComparesWhatShareOnceReleasesWithTheDraft() throws {
        let list = try XCTUnwrap(privacyPendingCitationList(exchange(
            outcome: .needsReview,
            draft: [citation("doc-1", title: "A"), citation("doc-2", title: "B")],
            pending: [citation("doc-2", title: "B")],
            pendingCandidate: "Held.",
            approvalPending: true
        )))

        XCTAssertEqual(list.heading, "Citations that would be shared")
        XCTAssertEqual(list.note, "Share once releases these documents and every link printed here.")
        XCTAssertEqual(list.rows.map(\.removed), [true, false])
    }

    func testPendingListIsOnlyForAPendingApproval() {
        XCTAssertNil(privacyPendingCitationList(exchange(
            outcome: .notShared,
            pending: [citation("doc-1", title: "A")]
        )))
    }

    func testNoCitationsMeansNoList() {
        let settled = exchange(outcome: .shared)
        XCTAssertNil(privacyDraftCitationList(settled))
        XCTAssertNil(privacySharedCitationList(settled))
    }

    func testReviewCardFromTheFeedComparesWithTheRecordedDraft() throws {
        let review = try XCTUnwrap(PrivacyPendingReview(exchange: exchange(
            outcome: .needsReview,
            draft: [citation("doc-1", title: "A"), citation("doc-2", title: "B")],
            pending: [citation("doc-2", title: "B")],
            pendingCandidate: "Held.",
            approvalPending: true
        )))
        let list = try XCTUnwrap(privacyReviewCitationList(review))

        XCTAssertEqual(list.heading, "Citations that would be shared")
        XCTAssertEqual(list.note, "Share once releases these documents and every link printed here.")
        XCTAssertEqual(list.rows.map(\.removed), [true, false])
    }

    func testReviewCardWithoutARecordedDraftListsPlainly() throws {
        let review = try XCTUnwrap(PrivacyPendingReview(exchange: exchange(
            outcome: .needsReview,
            draft: [citation("doc-1", title: "A")],
            pending: [citation("doc-2", title: "B")],
            pendingCandidate: "Held.",
            approvalPending: true,
            draftAnswer: nil
        )))
        let list = try XCTUnwrap(privacyReviewCitationList(review))

        XCTAssertEqual(list.rows.map(\.id), ["doc-2"])
        XCTAssertNil(list.withheldNote)
    }

    func testReviewCardFromTheApprovalListsExactlyWhatApprovingReleases() throws {
        let approval = try decodeApproval(citations: """
        "candidateCitations":[{"documentId":"doc-1","sourceType":"gmail"}],
        """)
        let list = try XCTUnwrap(privacyReviewCitationList(PrivacyPendingReview(detail: approval)))

        XCTAssertEqual(list.heading, "Citations that would be shared")
        XCTAssertEqual(list.rows.map(\.id), ["doc-1"])
        XCTAssertFalse(list.rows[0].marksWithheld)
    }

    // MARK: - Helpers

    private func citation(_ id: String, title: String?, web: String? = nil, app: String? = nil) -> AnswerCitation {
        AnswerCitation(documentId: id, sourceType: "gmail", title: title, sourceUrl: web, appUrl: app)
    }

    private func exchange(
        outcome: PrivacyExchangeOutcome,
        shared: [AnswerCitation] = [],
        draft: [AnswerCitation] = [],
        pending: [AnswerCitation] = [],
        pendingCandidate: String? = nil,
        approvalPending: Bool = false,
        draftAnswer: String? = "Draft.",
        sharedAnswer: String? = "Shared."
    )
        -> PrivacyExchangePresentation {
        PrivacyExchangePresentation(
            taskId: "task-1",
            conversationId: "conversation-1",
            workflowId: "workflow-1",
            externalAgent: PrivacyExternalAgent(displayName: "Research assistant", source: .principal),
            workflow: PrivacyExchangeWorkflow(name: "Summaries", purpose: "Summarize"),
            question: "What changed?",
            status: approvalPending ? .approvalRequired : .released,
            outcome: outcome,
            createdAt: 100,
            resolvedAt: nil,
            sharedAnswer: sharedAnswer,
            draftAnswer: draftAnswer,
            pendingCandidate: pendingCandidate,
            sharedCitations: shared,
            draftCitations: draft,
            pendingCitations: pending,
            reductions: [],
            approval: approvalPending
                ? PrivacyExchangeApproval(id: "approval-1", status: .pending, expiresAt: 200, resolvedAt: nil)
                : nil,
            userDecision: nil,
            review: nil
        )
    }

    private func decodeExchange(citations: String) throws -> PrivacyExchangePresentation {
        let json = """
        {"taskId":"task-1","conversationId":"conversation-1","workflowId":"workflow-1",
        "externalAgent":{"displayName":"Research assistant","source":"principal"},
        "workflow":{"name":"Prepare itinerary","purpose":"Compare routes"},
        "question":"When is the user free?","status":"released_with_reductions",
        "outcome":"shared_with_reductions","createdAt":100,"resolvedAt":110,"sharedAt":111,
        "sharedAnswer":"Available Thursday.","draftAnswer":"Available Thursday at noon.",
        "pendingCandidate":null,\(citations)
        "reductions":[],"approval":null,"userDecision":null,"review":null}
        """
        return try JSONDecoder().decode(PrivacyExchangePresentation.self, from: Data(json.utf8))
    }

    private func decodeApproval(citations: String) throws -> PrivacyApprovalDetail {
        let json = """
        {"id":"approval-1","taskId":"task-1","workflowId":"workflow-1",
        "conversationId":"conversation-1","workflowName":"Prepare itinerary","status":"pending",
        "externalAgent":{"displayName":"Research assistant","source":"principal"},
        "createdAt":100,"expiresAt":200,"resolvedAt":null,"workflowPurpose":"Compare routes",
        "question":"When is the user free?","candidateAnswer":"Thursday afternoon.",\(citations)
        "review":{"recipeVersion":"v1","provider":null,"model":null,"confidence":null,
        "policyRevision":"rev-1","findings":[],"rationale":"Approval is required.",
        "fallbackCause":"policy_requires_review"}}
        """
        return try JSONDecoder().decode(PrivacyApprovalDetail.self, from: Data(json.utf8))
    }
}
