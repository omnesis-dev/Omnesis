// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The watch half of `PrivacyClient`: the subscription-approval and
/// subscription routes, the trusted-contract check that rejects an approval the
/// gateway did not fully describe, and the reconciliation that keeps a lost
/// response from repeating a POST.
final class PrivacySubscriptionClientTests: PrivacyClientTestCase {
    func testOnlyNonterminalSubscriptionsCanBeRevoked() {
        XCTAssertTrue(canRevokePrivacySubscription("pending_approval"))
        XCTAssertTrue(canRevokePrivacySubscription("active"))
        XCTAssertTrue(canRevokePrivacySubscription("paused"))
        XCTAssertFalse(canRevokePrivacySubscription("denied"))
        XCTAssertFalse(canRevokePrivacySubscription("revoked"))
        XCTAssertFalse(canRevokePrivacySubscription("expired"))
    }

    /// A gateway that predates cursor paging omits both keys. The page still
    /// has to describe itself, or the list renders as if there were more.
    func testSubscriptionApprovalPageDefaultsLegacyPagingMetadata() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: """
            {"approvals":[{"id":"watch-approval","subscriptionId":"subscription-example",
            "workflowHandle":"workflow-example",
            "integration":{"displayName":"Fictional integration","source":"token"},
            "status":"pending","interpretedCondition":{"summary":"A fictional update",
            "pushDetail":"existence"},"revisionId":"revision-example","revision":1,
            "createdAt":100,"expiresAt":200,"resolvedAt":null}]}
            """)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let page = try await client.listSubscriptionApprovals()

        XCTAssertEqual(page.approvals.map(\.id), ["watch-approval"])
        XCTAssertNil(page.nextCursor)
        XCTAssertEqual(page.totalCount, 1)
    }

    func testSubscriptionReadRoutesDecodeMetadataWithoutEvidence() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            let path = request.url!.path
            if path.hasSuffix("/subscription-approvals") {
                return self!.response(request, body: """
                {"approvals":[{"id":"approval-example","subscriptionId":"subscription-example",
                "workflowHandle":"workflow-example","integration":{"displayName":"OpenClaw","source":"token"},
                "status":"pending","interpretedCondition":{"summary":"A fictional update requests a decision",
                "pushDetail":"existence"},"revisionId":"revision-example","revision":1,
                "createdAt":100,"expiresAt":200,"resolvedAt":null}],
                "nextCursor":"subscription-approval-next","totalCount":61}
                """)
            }
            return self!.response(request, body: """
            {"firings":[{"id":"firing-example","subscriptionId":"subscription-example",
            "revisionId":"revision-example","workflowHandle":"workflow-example","createdAt":150,
            "deliveryStatus":"delivered","acceptedAt":151}],"nextCursor":null}
            """)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let approvals = try await client.listSubscriptionApprovals(
            limit: 25,
            cursor: "approval+/="
        )
        let firings = try await client.listSubscriptionFirings(
            subscriptionId: "subscription/example",
            cursor: "firing/cursor"
        )

        XCTAssertEqual(
            approvals.approvals.first?.interpretedCondition.pushDetail,
            "existence"
        )
        XCTAssertEqual(approvals.nextCursor, "subscription-approval-next")
        XCTAssertEqual(approvals.totalCount, 61)
        XCTAssertEqual(firings.firings.first?.deliveryStatus, "delivered")
        XCTAssertEqual(queryItems(session.requests[0]), [
            "cursor": "approval+/=",
            "limit": "25",
            "status": "pending",
        ])
        XCTAssertEqual(
            session.requests[1].url?.absoluteString,
            "http://gateway.example:7600/admin/privacy/subscriptions/subscription%2Fexample/firings?limit=50&cursor=firing/cursor"
        )
    }

    func testGetSubscriptionApprovalAcceptsCompleteTrustedDetail() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: """
            {"approval":{"id":"approval-example","subscriptionId":"subscription-example",
            "workflowHandle":"review-fictional-project",
            "integration":{"displayName":"OpenClaw","source":"token"},"status":"pending",
            "interpretedCondition":{"summary":"A fictional project update requests a decision",
            "pushDetail":"existence"},
            "interpretation":{"summary":"A fictional project update requests a decision",
            "pushDetail":"existence"},"workflowId":"workflow-example",
            "integrationDeviceId":"integration-device-example",
            "integrationDevice":{"id":"integration-device-example",
            "name":"Fictional OpenClaw integration","kind":"agent"},
            "workflow":{"id":"workflow-example","name":"Fictional project review",
            "purpose":"Review invented project updates"},
            "revisionId":"revision-example","revision":2,
            "createdAt":100,"expiresAt":200,"resolvedAt":null,
            "condition":{"kind":"natural-language",
            "description":"A fictional project update requests a decision"},
            "reaction":{"kind":"agent-workflow",
            "instruction":"Review the fictional project update"},
            "categories":["documents"],"policyRevision":"policy-example"}}
            """)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let approval = try await client.getSubscriptionApproval(id: "approval/example")

        XCTAssertEqual(approval.id, "approval-example")
        XCTAssertEqual(approval.reaction.instruction, "Review the fictional project update")
        XCTAssertEqual(approval.workflow.name, "Fictional project review")
        XCTAssertEqual(
            session.requests.first?.url?.absoluteString,
            "http://gateway.example:7600/admin/privacy/subscription-approvals/approval%2Fexample"
        )
    }

    func testGetSubscriptionApprovalRejectsSyntacticallyIncompleteDetail() async {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: """
            {"approval":{"id":"approval-example","subscriptionId":"subscription-example"}}
            """)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        do {
            _ = try await client.getSubscriptionApproval(id: "approval-example")
            XCTFail("expected incomplete approval to fail decoding")
        } catch GatewayClient.Error.decoding {
            // Expected: required wire fields are absent.
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testGetSubscriptionApprovalRejectsSemanticallyUntrustedDetail() async {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: """
            {"approval":{"id":" ","subscriptionId":" ","workflowHandle":" ",
            "integration":{"displayName":" ","source":"fallback"},"status":"unknown",
            "interpretedCondition":{"summary":" ","pushDetail":"summary"},
            "interpretation":{"summary":" ","pushDetail":"summary"},
            "workflowId":" ","integrationDeviceId":" ",
            "integrationDevice":{"id":" ","name":" ","kind":"unknown"},
            "workflow":{"id":" ","name":" ","purpose":" "},
            "revisionId":" ","revision":0,"createdAt":0,"expiresAt":0,"resolvedAt":null,
            "condition":{"kind":"structured","description":" "},
            "reaction":{"kind":"webhook","instruction":" "},
            "categories":[],"policyRevision":" "}}
            """)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        do {
            _ = try await client.getSubscriptionApproval(id: "approval-example")
            XCTFail("expected untrusted approval to fail validation")
        } catch GatewayClient.Error.decoding(let message) {
            XCTAssertEqual(
                message,
                "Subscription approval response was incomplete or untrusted."
            )
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testGetSubscriptionApprovalRejectsMismatchedTrustedIdentity() async {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: """
            {"approval":{"id":"approval-example","subscriptionId":"subscription-example",
            "workflowHandle":"review-fictional-project",
            "integration":{"displayName":"OpenClaw","source":"token"},"status":"pending",
            "interpretedCondition":{"summary":"A fictional project update requests a decision",
            "pushDetail":"existence"},
            "interpretation":{"summary":"A fictional project update requests a decision",
            "pushDetail":"existence"},"workflowId":"workflow-example",
            "integrationDeviceId":"integration-device-example",
            "integrationDevice":{"id":"different-device",
            "name":"Fictional OpenClaw integration","kind":"agent"},
            "workflow":{"id":"workflow-example","name":"Fictional project review",
            "purpose":"Review invented project updates"},
            "revisionId":"revision-example","revision":1,"createdAt":100,"expiresAt":200,
            "condition":{"kind":"natural-language","description":"A fictional condition"},
            "reaction":{"kind":"agent-workflow","instruction":"Prepare an invented checklist."},
            "categories":["documents"],"policyRevision":"policy-example"}}
            """)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        do {
            _ = try await client.getSubscriptionApproval(id: "approval-example")
            XCTFail("expected identity mismatch to fail closed")
        } catch GatewayClient.Error.decoding {
            // Expected.
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testLostSubscriptionApprovalResponseReconcilesWithoutRepeatingPost() async throws {
        var postCount = 0
        var getCount = 0
        let outcome = try await resolveSubscriptionApprovalAndReconcile(
            resolve: {
                postCount += 1
                throw URLError(.networkConnectionLost)
            },
            reload: {
                getCount += 1
                return self.subscriptionApprovalDetail(status: "approved")
            }
        )

        XCTAssertEqual(postCount, 1)
        XCTAssertEqual(getCount, 1)
        guard case .reconciled(let detail) = outcome else {
            return XCTFail("expected reconciled approval")
        }
        XCTAssertEqual(detail.status, "approved")
    }

    func testNonTerminalSubscriptionApprovalReconciliationPreservesOriginalFailure() async throws {
        let actionError = URLError(.networkConnectionLost)
        let outcome = try await resolveSubscriptionApprovalAndReconcile(
            resolve: { throw actionError },
            reload: { self.subscriptionApprovalDetail(status: "pending") }
        )

        guard case .failed(let error, let latest) = outcome else {
            return XCTFail("expected original failure")
        }
        XCTAssertEqual((error as? URLError)?.code, actionError.code)
        XCTAssertEqual(latest?.status, "pending")
    }

    func testLostRevokeResponseReconcilesTerminalStateWithoutRepeatingPost() async throws {
        var postCount = 0
        var getCount = 0
        let outcome = try await revokeSubscriptionAndReconcile(
            revoke: {
                postCount += 1
                throw URLError(.networkConnectionLost)
            },
            reload: {
                getCount += 1
                return self.subscriptionDetail(status: "revoked")
            }
        )

        XCTAssertEqual(postCount, 1)
        XCTAssertEqual(getCount, 1)
        guard case .reconciled(let detail) = outcome else {
            return XCTFail("expected reconciled revoke")
        }
        XCTAssertEqual(detail.status, "revoked")
    }

    func testNonTerminalRevokeReconciliationPreservesOriginalFailure() async throws {
        let actionError = URLError(.networkConnectionLost)
        let outcome = try await revokeSubscriptionAndReconcile(
            revoke: { throw actionError },
            reload: { self.subscriptionDetail(status: "active") }
        )

        guard case .failed(let error, let latest) = outcome else {
            return XCTFail("expected original revoke failure")
        }
        XCTAssertEqual((error as? URLError)?.code, actionError.code)
        XCTAssertEqual(latest?.status, "active")
    }

    func testSubscriptionMutationsUseDistinctTrustedRoutes() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            let body = request.url?.path.hasSuffix("/revoke") == true
                ? """
                {"subscription":{"id":"subscription-example","workflowHandle":"workflow-example",
                "integration":{"displayName":"OpenClaw","source":"token"},"status":"revoked",
                "interpretedCondition":{"summary":"A fictional update requests a decision",
                "pushDetail":"existence"},"revisionId":"revision-example","revision":1,
                "createdAt":100,"updatedAt":200,"expiresAt":300,"revokedAt":200,
                "firingCount":0,"lastFiredAt":null,
                "condition":{"kind":"natural-language","description":"A fictional condition"},
                "reaction":{"kind":"agent-workflow","instruction":"Prepare an invented checklist."},
                "categories":["documents"],"policyRevision":"policy-example"}}
                """
                : "{}"
            return self!.response(request, body: body)
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        try await client.approveSubscription(id: "approval/example")
        try await client.denySubscription(id: "approval/example")
        try await client.revokeSubscription(id: "subscription/example")

        XCTAssertEqual(
            try session.requests.map { try XCTUnwrap($0.url).absoluteString },
            [
                "http://gateway.example:7600/admin/privacy/subscription-approvals/approval%2Fexample/resolve",
                "http://gateway.example:7600/admin/privacy/subscription-approvals/approval%2Fexample/resolve",
                "http://gateway.example:7600/admin/privacy/subscriptions/subscription%2Fexample/revoke",
            ]
        )
        XCTAssertEqual(
            session.requests.prefix(2).compactMap(\.httpBody).compactMap {
                try? JSONDecoder().decode([String: String].self, from: $0)["decision"]
            },
            ["approve", "deny"]
        )
        XCTAssertTrue(session.requests.allSatisfy { $0.httpMethod == "POST" })
        XCTAssertTrue(session.requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Cache-Control") == "no-store"
        })
    }

    private func subscriptionApprovalDetail(status: String) -> PrivacySubscriptionApprovalDetail {
        let interpretation = PrivacyInterpretedCondition(
            summary: "A fictional project update requests a decision."
        )
        return PrivacySubscriptionApprovalDetail(
            id: "approval-example",
            subscriptionId: "subscription-example",
            workflowHandle: "workflow-example",
            integration: PrivacyExternalAgent(displayName: "OpenClaw", source: .token),
            status: status,
            interpretedCondition: interpretation,
            interpretation: interpretation,
            workflowId: "workflow-example",
            integrationDeviceId: "integration-device-example",
            integrationDevice: PrivacySubscriptionIntegrationDevice(
                id: "integration-device-example",
                name: "Fictional OpenClaw integration"
            ),
            workflow: PrivacySubscriptionWorkflow(
                id: "workflow-example",
                name: "Fictional project review",
                purpose: "Review invented project updates."
            ),
            revisionId: "revision-example",
            revision: 1,
            createdAt: 100,
            expiresAt: 200,
            resolvedAt: status == "pending" ? nil : 150,
            condition: PrivacySubscriptionCondition(
                description: "A fictional project update requests a decision."
            ),
            reaction: PrivacySubscriptionReaction(
                instruction: "Prepare an invented checklist."
            ),
            categories: ["documents"],
            policyRevision: "policy-example"
        )
    }

    private func subscriptionDetail(status: String) -> PrivacySubscriptionDetail {
        PrivacySubscriptionDetail(
            id: "subscription-example",
            workflowHandle: "workflow-example",
            integration: PrivacyExternalAgent(displayName: "OpenClaw", source: .token),
            status: status,
            interpretedCondition: PrivacyInterpretedCondition(
                summary: "A fictional project update requests a decision."
            ),
            revisionId: "revision-example",
            revision: 1,
            createdAt: 100,
            updatedAt: 200,
            expiresAt: 300,
            revokedAt: status == "revoked" ? 200 : nil,
            firingCount: 0,
            lastFiredAt: nil,
            condition: PrivacySubscriptionCondition(
                description: "A fictional project update requests a decision."
            ),
            reaction: PrivacySubscriptionReaction(
                instruction: "Prepare an invented checklist."
            ),
            categories: ["documents"],
            policyRevision: "policy-example"
        )
    }
}
