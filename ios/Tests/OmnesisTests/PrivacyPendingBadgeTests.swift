// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The number on the drawer's Privacy entry. It is the count of decisions that
/// are genuinely still open, taken from the gateway's own ledger totals — a
/// badge built from a page would under-report the moment the backlog outgrew
/// one page, and the whole point of the badge is that it is not visited.
final class PrivacyPendingBadgeTests: PrivacyClientTestCase {
    private func page(_ totalCount: Int, rows: Int = 1) -> String {
        let approvals = (0 ..< rows).map { index in
            """
            {"id":"approval-\(index)","taskId":"task-\(index)","workflowId":"workflow-1",
             "conversationId":"conversation-1","workflowName":"Weekly digest",
             "externalAgent":{"displayName":"Studio agent","source":"token"},
             "status":"pending","createdAt":1786851000000,"expiresAt":1786854600000,
             "resolvedAt":null}
            """
        }
        let rowsJSON = approvals.joined(separator: ",")
        return "{\"approvals\":[\(rowsJSON)],\"nextCursor\":null,\"totalCount\":\(totalCount)}"
    }

    private func watchRequestPage(_ totalCount: Int) -> String {
        "{\"approvals\":[],\"nextCursor\":null,\"totalCount\":\(totalCount)}"
    }

    /// The ledger reports 7 open decisions while the requested page holds one
    /// row. The badge must read 7.
    func testCountsTheLedgerTotalNotThePageLength() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: self!.page(7))
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let total = try await privacyPendingDecisionTotal(
            client: client,
            includesWatchRequests: false
        )

        XCTAssertEqual(total, 7)
        XCTAssertEqual(queryItems(session.requests[0]), ["status": "pending", "limit": "1"])
        XCTAssertEqual(session.requests[0].url?.path, "/admin/privacy/approvals")
        XCTAssertEqual(session.requests.count, 1, "watch requests were not asked for")
    }

    /// Where the watch surface exists, a request for a standing watch is the
    /// same kind of open decision and is counted alongside the held answers.
    func testAddsWatchRequestsWhereThatSurfaceExists() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            let isWatchRequests = request.url?.path == "/admin/privacy/subscription-approvals"
            return self!.response(
                request,
                body: isWatchRequests ? self!.watchRequestPage(2) : self!.page(3)
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let total = try await privacyPendingDecisionTotal(
            client: client,
            includesWatchRequests: true
        )

        XCTAssertEqual(total, 5)
        XCTAssertEqual(session.requests.count, 2)
    }

    /// A gateway that does not serve the watch-request route must not take the
    /// held answers down with it — that half of the sum is best-effort.
    func testWatchRequestFailureLeavesTheHeldAnswersCounted() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            let isWatchRequests = request.url?.path == "/admin/privacy/subscription-approvals"
            return self!.response(
                request,
                status: isWatchRequests ? 404 : 200,
                body: isWatchRequests ? "{}" : self!.page(3)
            )
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let total = try await privacyPendingDecisionTotal(
            client: client,
            includesWatchRequests: true
        )

        XCTAssertEqual(total, 3)
    }

    /// The ledger read itself failing is not a count of zero dressed up as
    /// one — it throws, and the caller decides (the badge clears).
    func testLedgerFailureThrows() async {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, status: 500, body: "boom")
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        do {
            _ = try await privacyPendingDecisionTotal(client: client, includesWatchRequests: true)
            XCTFail("expected the ledger failure to propagate")
        } catch {
            // Expected.
        }
    }

    /// The page decodes what the badge and the auto-open both read off it: the
    /// exact total, and the oldest row's id.
    func testApprovalPageDecodesRowsAndTotal() async throws {
        let session = MockSession()
        session.responder = { [weak self] request in
            self!.response(request, body: self!.page(4, rows: 2))
        }
        let client = PrivacyClient(baseURL: baseURL, token: "omn_test", session: session)

        let page = try await client.listApprovals(status: "pending", limit: 2, cursor: "cursor 1")

        XCTAssertEqual(page.totalCount, 4)
        XCTAssertNil(page.nextCursor)
        XCTAssertEqual(page.approvals.map(\.id), ["approval-0", "approval-1"])
        XCTAssertEqual(page.approvals.first?.status, .pending)
        XCTAssertEqual(page.approvals.first?.externalAgent?.displayName, "Studio agent")
        XCTAssertEqual(
            queryItems(session.requests[0]),
            ["status": "pending", "limit": "2", "cursor": "cursor 1"]
        )
    }
}
