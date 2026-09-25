// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The held-answer half of the answer privacy boundary: approvals and the
/// exchange ledger the Privacy screens read. The
/// policy document is covered by `PrivacyPolicyClientTests`, the watch registry
/// by `PrivacySubscriptionClientTests`.
final class PrivacyClientTests: PrivacyClientTestCase {
    func testGetApprovalDecodesTrustedDetailEnvelope() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"approval":{"id":"approval-1","taskId":"task-1","workflowId":"workflow-1",
                "conversationId":"conversation-1","workflowName":"Prepare itinerary","status":"pending",
                "externalAgent":{"displayName":"Research assistant","narrativeName":"Research assistant",
                "integrationSlug":null,"connectionName":"Laptop client","source":"principal"},
                "createdAt":100,"expiresAt":200,"resolvedAt":null,"workflowPurpose":"Compare routes",
                "question":"When is the user free?","candidateAnswer":"Thursday afternoon.",
                "review":{"recipeVersion":"v1","provider":"anthropic","model":"reviewer-example",
                "confidence":0.9,"policyRevision":"rev-1",
                "envelopeDigest":"sha256-envelope",
                "findings":[{"category":"schedule",
                "detailLevel":"summary","subject":"user","disposition":"approval","description":"Schedule summary."}],
                "rationale":"Approval is required.","fallbackCause":"policy_requires_review"}}}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let approval = try await client.getApproval(id: "approval-1")

        XCTAssertEqual(approval.candidateAnswer, "Thursday afternoon.")
        XCTAssertEqual(approval.review.findings.first?.disposition, .approval)
        XCTAssertEqual(approval.review.envelopeDigest, "sha256-envelope")
        XCTAssertEqual(approval.review.fallbackCause, .policyRequiresReview)
        XCTAssertEqual(approval.externalAgent?.displayName, "Research assistant")
        XCTAssertEqual(approval.externalAgent?.narrativeName, "Research assistant")
        XCTAssertNil(approval.externalAgent?.integrationSlug)
        XCTAssertEqual(approval.externalAgent?.connectionName, "Laptop client")
        XCTAssertEqual(approval.externalAgent?.source, .principal)
        XCTAssertTrue(session.requests.first?.url?.path.hasSuffix("/admin/privacy/approvals/approval-1") == true)
    }

    func testApprovalIdIsEncodedAsOnePathSegment() async {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, status: 404, body: #"{"error":"not found"}"#)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        do {
            _ = try await client.getApproval(id: "approval/../other")
            XCTFail("expected not found")
        } catch GatewayClient.Error.notFound {
            XCTAssertEqual(
                session.requests.first?.url?.absoluteString,
                "http://gateway.example:7600/admin/privacy/approvals/approval%2F..%2Fother"
            )
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testApproveAndDenyUseActionRoutes() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            let denied = request.url?.path.hasSuffix("/deny") == true
            return self!.response(
                request,
                body: denied
                    ? """
                    {"status":"denied","workflowId":"workflow-1","conversationId":"conversation-1",
                    "taskId":"task-1","reason":"user_denied"}
                    """
                    : """
                    {"status":"released","workflowId":"workflow-1","conversationId":"conversation-1",
                    "taskId":"task-1","releaseId":"release-1","answer":"Allowed answer"}
                    """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let approved = try await client.approve(id: "approval-1")
        let denied = try await client.deny(id: "approval-2")

        XCTAssertEqual(approved.status, .released)
        XCTAssertEqual(approved.answer, "Allowed answer")
        XCTAssertEqual(denied.status, .denied)
        XCTAssertEqual(denied.reason, "user_denied")
        XCTAssertEqual(session.requests.map(\.httpMethod), ["POST", "POST"])
        XCTAssertNil(session.requests[0].httpBody)
        XCTAssertEqual(session.requests[0].url?.path, "/admin/privacy/approvals/approval-1/approve")
        XCTAssertEqual(session.requests[1].url?.path, "/admin/privacy/approvals/approval-2/deny")
    }

    func testExchangePresentationTimestampPrioritizesRecordedEgress() {
        let exchange = PrivacyExchangePresentation(
            taskId: "task-example",
            conversationId: "conversation-example",
            workflowId: "workflow-example",
            externalAgent: PrivacyExternalAgent(displayName: "External agent", source: .fallback),
            workflow: PrivacyExchangeWorkflow(name: "Example workflow", purpose: "Invented purpose"),
            question: "What is the invented status?",
            status: .released,
            outcome: .shared,
            createdAt: 100,
            resolvedAt: 200,
            sharedAt: 300,
            sharedAnswer: "The invented status is ready.",
            pendingCandidate: nil,
            reductions: [],
            approval: nil,
            userDecision: nil,
            review: nil
        )

        XCTAssertEqual(exchange.presentationTimestamp, 300)
    }

    func testEventPageDecodesPaginationAndCursorEncoding() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"events":[{"id":"event-1","taskId":"task-1","kind":"privacy_review",
                "createdAt":104,"display":{"title":"Privacy review","text":"Approval required.",
                "detail":null,"status":{"code":"held","label":"Held for your review"},
                "provider":"example-provider","model":"reviewer-example",
                "confidence":0.87,"approvalId":null,"releaseId":null,"digest":"digest-1","reductions":[]},
                "payloadAvailable":true,"payloadDigest":"payload-digest","payloadBytes":120,
                "originalPayloadBytes":120,"payloadTruncated":false}],"previousCursor":"older-events"}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let events = try await client.listEvents(
            conversationId: "conversation-1",
            limit: 25,
            cursor: "event-cursor+/="
        )

        XCTAssertEqual(events.events.first?.kind, .privacyReview)
        XCTAssertEqual(events.previousCursor, "older-events")
        XCTAssertTrue(session.requests[0].url?.absoluteString.contains("cursor=event-cursor%2B/%3D") == true)
    }

    func testConversationDeleteEncodesEachPathSegment() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: #"{"deleted":true}"#)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        try await client.deleteConversation(id: "conversation/one")

        XCTAssertEqual(
            session.requests.map { $0.url?.absoluteString },
            ["http://gateway.example:7600/admin/privacy/conversations/conversation%2Fone"]
        )
        XCTAssertEqual(session.requests.last?.httpMethod, "DELETE")
    }

    func testExchangePresentationDecodesBoundaryEvidenceAndPagination() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"exchanges":[{"taskId":"task-1","conversationId":"conversation-1",
                "workflowId":"workflow-1","externalAgent":{"displayName":"Research assistant",
                "narrativeName":"Research assistant","integrationSlug":"openclaw",
                "connectionName":"Laptop client","source":"principal"},
                "workflow":{"name":"Prepare itinerary","purpose":"Compare routes"},
                "question":"When is the user free?","status":"released_with_reductions",
                "outcome":"shared_with_reductions","createdAt":100,"resolvedAt":110,
                "sharedAt":111,
                "sharedAnswer":"Available Thursday.","pendingCandidate":null,
                "reductions":["Removed exact location"],"approval":null,"userDecision":null,
                "review":{"fallbackCause":null,"findings":[],"rationale":"Location removed."}}],
                "previousCursor":"older-exchanges"}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let page = try await client.listExchanges(
            conversationId: "conversation/one",
            limit: 25,
            cursor: "exchange-cursor+/="
        )

        XCTAssertEqual(page.exchanges.first?.outcome, .sharedWithReductions)
        XCTAssertEqual(page.exchanges.first?.sharedAt, 111)
        XCTAssertEqual(page.exchanges.first?.externallyVisibleAnswer, "Available Thursday.")
        XCTAssertEqual(page.exchanges.first?.externalAgent.narrativeName, "Research assistant")
        XCTAssertEqual(page.exchanges.first?.externalAgent.integrationSlug, "openclaw")
        XCTAssertEqual(page.exchanges.first?.externalAgent.connectionName, "Laptop client")
        XCTAssertEqual(page.exchanges.first?.externalAgent.source, .principal)
        XCTAssertNil(page.exchanges.first?.candidateAwaitingReview)
        XCTAssertEqual(page.previousCursor, "older-exchanges")
        XCTAssertEqual(
            session.requests.first?.url?.absoluteString,
            "http://gateway.example:7600/admin/privacy/conversations/conversation%2Fone/exchanges?limit=25&cursor=exchange-cursor%2B/%3D"
        )
    }

    func testPrivateCandidateIsNeverExposedAsSharedAnswer() {
        let exchange = PrivacyExchangePresentation(
            taskId: "task-1",
            conversationId: "conversation-1",
            workflowId: "workflow-1",
            externalAgent: PrivacyExternalAgent(displayName: "OpenClaw", source: .token),
            workflow: PrivacyExchangeWorkflow(name: "Prepare itinerary", purpose: "Compare routes"),
            question: "When is the user free?",
            status: .approvalRequired,
            outcome: .needsReview,
            createdAt: 100,
            resolvedAt: nil,
            sharedAnswer: "Incorrect server field must not be displayed as shared.",
            pendingCandidate: "Held answer.",
            reductions: [],
            approval: PrivacyExchangeApproval(id: "approval-1", status: .pending, expiresAt: 200, resolvedAt: nil),
            userDecision: nil,
            review: PrivacyExchangeReview(fallbackCause: .policyRequiresReview, findings: [], rationale: "Review required.")
        )

        XCTAssertNil(exchange.externallyVisibleAnswer)
        XCTAssertEqual(exchange.candidateAwaitingReview, "Held answer.")
    }

    func testUnattendedDraftDecodesWithoutBecomingSharedOrPending() throws {
        let data = Data(
            """
            {"taskId":"task-1","conversationId":"conversation-1","workflowId":"workflow-1",
            "externalAgent":{"displayName":"Atlas","source":"token"},
            "workflow":{"name":"Prepare update","purpose":"Prepare an invented update"},
            "question":"What changed?","status":"denied","outcome":"not_shared",
            "createdAt":100,"resolvedAt":110,"sharedAt":null,"sharedAnswer":null,
            "draftAnswer":"The fictional reception desk is open until 17:00.",
            "pendingCandidate":null,"reductions":[],"approval":null,"userDecision":null,
            "denialReason":"approval_not_available","review":null}
            """.utf8
        )

        let exchange = try JSONDecoder().decode(PrivacyExchangePresentation.self, from: data)

        XCTAssertEqual(exchange.draftAnswer, "The fictional reception desk is open until 17:00.")
        XCTAssertEqual(exchange.denialReason, .approvalNotAvailable)
        XCTAssertNil(exchange.externallyVisibleAnswer)
        XCTAssertNil(exchange.candidateAwaitingReview)
    }

    func testUnknownDenialReasonDegradesWithoutLosingTheExchange() throws {
        let data = Data(
            """
            {"taskId":"task-1","conversationId":"conversation-1","workflowId":"workflow-1",
            "denialReason":"newer_gateway_reason"}
            """.utf8
        )

        let exchange = try JSONDecoder().decode(PrivacyExchangePresentation.self, from: data)

        XCTAssertEqual(exchange.denialReason, .unknown)
    }

    func testReadyAnswerIsNotExposedAsShared() throws {
        let data = Data(
            """
            {"taskId":"task-1","conversationId":"conversation-1","workflowId":"workflow-1",
            "externalAgent":{"displayName":"OpenClaw","source":"token"},
            "workflow":{"name":"Prepare itinerary","purpose":"Compare routes"},
            "question":"When is the user free?","status":"released","outcome":"ready",
            "createdAt":100,"resolvedAt":110,"sharedAt":null,"sharedAnswer":null,
            "pendingCandidate":null,"reductions":[],"approval":null,"userDecision":"approved",
            "review":null}
            """.utf8
        )

        let exchange = try JSONDecoder().decode(PrivacyExchangePresentation.self, from: data)

        XCTAssertEqual(exchange.outcome, .ready)
        XCTAssertNil(exchange.sharedAt)
        XCTAssertNil(exchange.externallyVisibleAnswer)
    }

    func testPostApprovalHardStopAttributionDecodes() throws {
        let data = Data(
            """
            {"taskId":"task-1","conversationId":"conversation-1","workflowId":"workflow-1",
            "externalAgent":{"displayName":"OpenClaw","source":"token"},
            "workflow":{"name":"Prepare itinerary","purpose":"Compare routes"},
            "question":"Can this detail leave?","status":"denied","outcome":"not_shared",
            "createdAt":100,"resolvedAt":110,"sharedAt":null,"sharedAnswer":null,
            "pendingCandidate":null,"reductions":[],"approval":null,
            "userDecision":"approved_but_blocked",
            "review":{"fallbackCause":"hard_stop","findings":[],"rationale":"Blocked."}}
            """.utf8
        )

        let exchange = try JSONDecoder().decode(PrivacyExchangePresentation.self, from: data)

        XCTAssertEqual(exchange.userDecision, .approvedButBlocked)
        XCTAssertNil(exchange.externallyVisibleAnswer)
    }

    func testReviewerHealthDecodesSafeAggregate() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: #"{"status":"attention","recentOperationalFailureCount":3,"lastFailureAt":120}"#
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let health = try await client.getReviewerHealth()

        XCTAssertEqual(health.status, .attention)
        XCTAssertEqual(health.recentOperationalFailureCount, 3)
        XCTAssertEqual(session.requests.first?.url?.path, "/admin/privacy/reviewer-health")
    }

    // MARK: - The landing feed, the closed status set, and the policy schema

    func testExchangeFeedDecodesFlatNewestFirstPageWithFailureReason() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"exchanges":[{"taskId":"task-2","conversationId":"conversation-2",
                "workflowId":"workflow-2","externalAgent":{"displayName":"Atlas (openclaw)","source":"token"},
                "workflow":{"name":"Prepare itinerary","purpose":"Compare routes"},
                "question":"Which route is shortest?","status":"failed","outcome":"failed",
                "createdAt":300,"resolvedAt":301,"sharedAt":null,"sharedAnswer":null,
                "pendingCandidate":null,"reductions":[],"approval":null,"userDecision":null,
                "review":null,"failure":{"code":"agent_unavailable",
                "message":"The answer could not be drafted.",
                "stage":"answer_generation"}}],"nextCursor":"older-exchanges"}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let page = try await client.listExchangeFeed(limit: 25, cursor: "feed-cursor+/=")

        XCTAssertEqual(page.exchanges.count, 1)
        XCTAssertEqual(page.exchanges.first?.outcome, .failed)
        XCTAssertEqual(page.exchanges.first?.failure?.code, "agent_unavailable")
        XCTAssertEqual(page.exchanges.first?.failure?.stage, .answerGeneration)
        XCTAssertEqual(page.nextCursor, "older-exchanges")
        XCTAssertEqual(
            session.requests.first?.url?.absoluteString,
            "http://gateway.example:7600/admin/privacy/exchanges?limit=25&cursor=feed-cursor%2B/%3D"
        )
    }

    func testExchangeFeedKeepsSafeFailureWhenStageIsNewerThanTheClient() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(
                request,
                body: """
                {"exchanges":[{"taskId":"task-2","conversationId":"conversation-2",
                "workflowId":"workflow-2","externalAgent":{"displayName":"Atlas","source":"token"},
                "workflow":{"name":"Prepare itinerary","purpose":"Compare routes"},
                "question":"Which route is shortest?","status":"failed","outcome":"failed",
                "createdAt":300,"resolvedAt":301,"sharedAt":null,"sharedAnswer":null,
                "pendingCandidate":null,"reductions":[],"approval":null,"userDecision":null,
                "review":null,"failure":{"code":"future_failure",
                "message":"A safe failure explanation.","stage":"future_stage"}}],"nextCursor":null}
                """
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let failure = try await client.listExchangeFeed().exchanges.first?.failure

        XCTAssertEqual(failure?.message, "A safe failure explanation.")
        XCTAssertEqual(failure?.stage, .unknown)
    }

    func testExchangeFeedToleratesAnAbsentCollection() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: #"{"nextCursor":null}"#)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let page = try await client.listExchangeFeed()

        XCTAssertTrue(page.exchanges.isEmpty)
        XCTAssertNil(page.nextCursor)
    }

    /// A gateway that omits or garbles a descriptive field must cost the
    /// operator that field, not the whole feed page. Only the three ids are
    /// required — they are the row's identity and the route to its detail.
    func testExchangeSurvivesMissingAndMalformedDescriptiveFields() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: """
            {"exchanges":[{"taskId":"task-sparse","conversationId":"conversation-sparse",
            "workflowId":"workflow-sparse","externalAgent":{"displayName":42},
            "workflow":"not-an-object","status":"a_status_from_the_future",
            "outcome":"an_outcome_from_the_future","reductions":{"nope":true},
            "userDecision":"invented","review":"not-an-object","failure":7},
            {"taskId":"task-whole","conversationId":"conversation-sparse",
            "workflowId":"workflow-sparse",
            "externalAgent":{"displayName":"Atlas (openclaw)","narrativeName":17,
            "connectionName":{"unexpected":true},"source":"token"},
            "workflow":{"name":"Plan a trip","purpose":"Compare routes"},
            "question":"When is the user free?","status":"released","outcome":"shared",
            "createdAt":100,"resolvedAt":101,"sharedAt":102,"sharedAnswer":"Thursday.",
            "pendingCandidate":null,"reductions":[],"approval":null,"userDecision":null,
            "review":null}],"nextCursor":null}
            """)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let page = try await client.listExchangeFeed()

        XCTAssertEqual(page.exchanges.map(\.taskId), ["task-sparse", "task-whole"])
        let sparse = try XCTUnwrap(page.exchanges.first)
        XCTAssertEqual(externalAgentFullName(sparse.externalAgent), "External agent")
        XCTAssertEqual(sparse.workflow.name, "")
        XCTAssertEqual(sparse.question, "")
        XCTAssertEqual(sparse.status, .unknown)
        XCTAssertEqual(sparse.outcome, .unknown)
        XCTAssertEqual(sparse.createdAt, 0)
        XCTAssertEqual(sparse.reductions, [])
        let legacy = try XCTUnwrap(page.exchanges.last)
        XCTAssertEqual(externalAgentNarrativeName(legacy.externalAgent), "Atlas")
        XCTAssertNil(legacy.externalAgent.narrativeName)
        XCTAssertNil(legacy.externalAgent.connectionName)
        XCTAssertNil(sparse.userDecision)
        XCTAssertNil(sparse.review)
        XCTAssertNil(sparse.failure)
        // Nothing about a sparse row may read as shared.
        XCTAssertNil(sparse.externallyVisibleAnswer)
        XCTAssertEqual(page.exchanges.last?.sharedAnswer, "Thursday.")
    }

    /// A row with no identity cannot be listed or navigated to, so it stays a
    /// hard decode failure rather than being invented into existence.
    func testExchangeWithoutATaskIdIsStillRejected() async {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: #"{"exchanges":[{"conversationId":"c","workflowId":"w"}]}"#)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        do {
            _ = try await client.listExchangeFeed()
            XCTFail("expected a decode failure")
        } catch GatewayClient.Error.decoding {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    /// The gateway maps every raw producer token onto the closed set and drops
    /// the rest. A code this client does not know renders nothing at all rather
    /// than arriving on screen styled as if it meant something.
    func testAuditStatusDecodesClosedSetAndDropsEverythingElse() throws {
        let cases: [(String, PrivacyAuditStatusDisplay?)] = [
            (
                #"{"code":"held","label":"Held for your review"}"#,
                PrivacyAuditStatusDisplay(code: .held, label: "Held for your review")
            ),
            (
                #"{"code":"allowed","label":"Left this machine"}"#,
                PrivacyAuditStatusDisplay(code: .allowed, label: "Left this machine")
            ),
            // A model's terminal stop reason, not a privacy status.
            (#"{"code":"stop","label":"Stop"}"#, nil),
            // A label the gateway blanked carries no meaning either.
            (#"{"code":"blocked","label":"   "}"#, nil),
            ("null", nil),
        ]

        for (statusJSON, expected) in cases {
            let display = try JSONDecoder().decode(
                PrivacyAuditEventDisplay.self,
                from: Data(#"{"title":"Privacy review","status":\#(statusJSON)}"#.utf8)
            )
            XCTAssertEqual(display.status, expected, "status: \(statusJSON)")
        }
    }

    func testAuditStatusIsAbsentWhenTheGatewayOmitsTheKey() throws {
        let display = try JSONDecoder().decode(
            PrivacyAuditEventDisplay.self,
            from: Data(#"{"title":"External request","reductions":["Removed the address"]}"#.utf8)
        )

        XCTAssertNil(display.status)
        XCTAssertEqual(display.reductions, ["Removed the address"])
    }
}
