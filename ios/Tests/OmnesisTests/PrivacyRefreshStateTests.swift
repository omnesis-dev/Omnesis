// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PrivacyRefreshStateTests: XCTestCase {
    private struct ReviewItem: Equatable, Identifiable {
        let id: String
    }

    func testCancellationWithoutPriorFailureRemainsClear() {
        XCTAssertNil(privacyRefreshFailure(previous: nil, caught: CancellationError()))
        XCTAssertNil(privacyRefreshFailure(previous: nil, caught: URLError(.cancelled)))
    }

    func testCancelledRetryPreservesPriorFailure() {
        let prior = GatewayClient.Error.forbidden

        XCTAssertEqual(
            privacyRefreshFailure(previous: prior, caught: CancellationError())
                as? GatewayClient.Error,
            prior
        )
    }

    func testRealFailureReplacesPriorFailureWithoutChangingItsType() {
        let timeout = URLError(.timedOut)

        XCTAssertEqual(
            privacyRefreshFailure(previous: GatewayClient.Error.forbidden, caught: timeout)
                as? URLError,
            timeout
        )
    }

    func testNewerPrivacyReviewRefreshOwnsItemsCountAndCursor() {
        var items = [ReviewItem(id: "old")]
        var totalCount = 19
        var paging = CursorPagingState(nextCursor: "old-next")
        let staleRequest = paging.beginRefresh()
        let currentRequest = paging.beginRefresh()

        XCTAssertFalse(paging.owns(staleRequest))
        XCTAssertTrue(paging.owns(currentRequest))

        if paging.owns(staleRequest) {
            replacePrivacyReviewPage(
                items: &items,
                totalCount: &totalCount,
                pageItems: [ReviewItem(id: "stale")],
                pageTotalCount: 2
            )
        }
        if paging.owns(currentRequest) {
            replacePrivacyReviewPage(
                items: &items,
                totalCount: &totalCount,
                pageItems: [ReviewItem(id: "current")],
                pageTotalCount: 73
            )
            paging.finishRefresh(currentRequest, nextCursor: "current-next")
        }

        XCTAssertEqual(items, [ReviewItem(id: "current")])
        XCTAssertEqual(totalCount, 73)
        XCTAssertEqual(paging.nextCursor, "current-next")
    }

    func testPrivacyReviewNextPageDeduplicatesAndPreservesExactTotal() throws {
        var items = [ReviewItem(id: "one"), ReviewItem(id: "two")]
        var totalCount = 5
        var paging = CursorPagingState(nextCursor: "next")
        let request = try XCTUnwrap(paging.beginLoadMore())

        appendPrivacyReviewPage(
            items: &items,
            totalCount: &totalCount,
            pageItems: [ReviewItem(id: "two"), ReviewItem(id: "three")],
            pageTotalCount: 61,
            id: \.id
        )
        paging.finishLoadMore(request, nextCursor: "later", madeProgress: true)

        XCTAssertEqual(
            items,
            [ReviewItem(id: "one"), ReviewItem(id: "two"), ReviewItem(id: "three")]
        )
        XCTAssertEqual(totalCount, 61)
        XCTAssertEqual(paging.nextCursor, "later")
    }

    func testApprovalRequestGateGivesResolutionOwnershipOverEarlierLoad() throws {
        var gate = PrivacyApprovalRequestGate()
        let load = try XCTUnwrap(gate.beginLoad(resolutionInFlight: false))

        let resolution = gate.beginResolution()

        XCTAssertFalse(gate.owns(load))
        XCTAssertTrue(gate.owns(resolution))
    }

    func testApprovalRequestGateRejectsRefreshDuringResolution() {
        var gate = PrivacyApprovalRequestGate()
        let resolution = gate.beginResolution()

        XCTAssertNil(gate.beginLoad(resolutionInFlight: true))
        XCTAssertTrue(gate.owns(resolution))
    }

    func testApprovalRequestGateInvalidatesWorkWhenViewDisappears() {
        var gate = PrivacyApprovalRequestGate()
        let resolution = gate.beginResolution()

        gate.invalidate()

        XCTAssertFalse(gate.owns(resolution))
    }
}
