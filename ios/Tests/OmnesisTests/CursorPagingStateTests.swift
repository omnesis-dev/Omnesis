// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class CursorPagingStateTests: XCTestCase {
    func testRefreshOwnsOnlyLatestGeneration() {
        var state = CursorPagingState(nextCursor: "old")
        let first = state.beginRefresh()
        let second = state.beginRefresh()

        XCTAssertFalse(state.owns(first))
        XCTAssertTrue(state.owns(second))

        state.finishRefresh(first, nextCursor: "stale")
        XCTAssertEqual(state.nextCursor, "old")
        state.finishRefresh(second, nextCursor: "fresh")
        XCTAssertEqual(state.nextCursor, "fresh")
        XCTAssertFalse(state.isRefreshing)
    }

    func testLoadMoreCapturesCursorAndRefusesConcurrentRequest() throws {
        var state = CursorPagingState(nextCursor: "cursor-1")
        let request = state.beginLoadMore()

        XCTAssertEqual(request?.cursor, "cursor-1")
        XCTAssertNil(state.beginLoadMore())
        XCTAssertTrue(state.isLoadingMore)

        try state.finishLoadMore(
            XCTUnwrap(request),
            nextCursor: "cursor-2",
            madeProgress: true
        )
        XCTAssertEqual(state.nextCursor, "cursor-2")
        XCTAssertFalse(state.isLoadingMore)
    }

    func testRefreshInvalidatesInFlightLoadMore() throws {
        var state = CursorPagingState(nextCursor: "cursor-1")
        let more = try XCTUnwrap(state.beginLoadMore())
        let refresh = state.beginRefresh()

        XCTAssertFalse(state.owns(more))
        XCTAssertFalse(
            state.isLoadingMore,
            "a refresh which supersedes automatic paging must clear its spinner immediately"
        )
        state.finishLoadMore(more, nextCursor: "stale", madeProgress: true)
        state.finishRefresh(refresh, nextCursor: "fresh")
        XCTAssertEqual(state.nextCursor, "fresh")
    }

    func testLoadMoreFailurePreservesCursorForRetry() throws {
        var state = CursorPagingState(nextCursor: "cursor-1")
        let request = try XCTUnwrap(state.beginLoadMore())
        let error = URLError(.timedOut)

        state.failLoadMore(request, error: error)

        XCTAssertEqual(state.nextCursor, "cursor-1")
        XCTAssertEqual((state.paginationError as? URLError)?.code, .timedOut)
        XCTAssertNotNil(state.beginLoadMore())
    }

    func testPersonDocumentPaginationFailureLeavesLoadedPageRetryable() throws {
        var documents = ["doc-1"]
        var state = CursorPagingState(nextCursor: "person-docs-next")
        let request = try XCTUnwrap(state.beginLoadMore())

        state.failLoadMore(request, error: URLError(.timedOut))

        XCTAssertEqual(documents, ["doc-1"])
        XCTAssertEqual(state.nextCursor, "person-docs-next")
        XCTAssertTrue(state.canLoadMore)
        XCTAssertNotNil(state.paginationError)

        let retry = try XCTUnwrap(state.beginLoadMore())
        appendUnique(["doc-2"], to: &documents, id: \.self)
        state.finishLoadMore(retry, nextCursor: nil, madeProgress: true)

        XCTAssertEqual(documents, ["doc-1", "doc-2"])
        XCTAssertFalse(state.canLoadMore)
        XCTAssertNil(state.paginationError)
    }

    func testStaleLoadMoreResetDiscardsCursorBeforePageOneRefresh() throws {
        var state = CursorPagingState(nextCursor: "stale-cursor")
        let staleRequest = try XCTUnwrap(state.beginLoadMore())

        XCTAssertTrue(state.resetAfterStaleLoadMore(staleRequest))
        XCTAssertNil(state.nextCursor)
        XCTAssertFalse(state.isLoadingMore)

        let refresh = state.beginRefresh()
        XCTAssertNil(refresh.cursor)
        state.finishRefresh(refresh, nextCursor: "fresh-cursor")
        XCTAssertEqual(state.nextCursor, "fresh-cursor")
    }

    func testOlderStaleResponseCannotResetNewerRefresh() throws {
        var state = CursorPagingState(nextCursor: "stale-cursor")
        let staleRequest = try XCTUnwrap(state.beginLoadMore())
        let refresh = state.beginRefresh()

        XCTAssertFalse(state.resetAfterStaleLoadMore(staleRequest))
        XCTAssertTrue(state.owns(refresh))
        state.finishRefresh(refresh, nextCursor: "fresh-cursor")
        XCTAssertEqual(state.nextCursor, "fresh-cursor")
    }

    func testNonAdvancingCursorStopsRequestsWithoutClaimingExactCount() throws {
        var state = CursorPagingState(nextCursor: "cursor-1")
        let request = try XCTUnwrap(state.beginLoadMore())

        state.finishLoadMore(request, nextCursor: "cursor-1", madeProgress: true)

        XCTAssertNil(state.nextCursor)
        XCTAssertFalse(state.canLoadMore)
        XCTAssertTrue(state.isTruncated)
        XCTAssertTrue(state.countIsPartial)
        XCTAssertEqual(
            pagingCountLabel(48, countIsPartial: state.countIsPartial),
            "48 loaded"
        )
    }

    func testResetCancelsLoadMoreAndClearsTruncation() throws {
        var state = CursorPagingState(nextCursor: "cursor-1", isTruncated: true)
        _ = try XCTUnwrap(state.beginLoadMore())

        state.reset()

        XCTAssertFalse(state.isLoadingMore)
        XCTAssertFalse(state.isTruncated)
        XCTAssertFalse(state.countIsPartial)
        XCTAssertNil(state.nextCursor)
    }

    func testEmptyCursorNormalizesToExhausted() {
        var state = CursorPagingState(nextCursor: "")
        XCTAssertFalse(state.canLoadMore)

        let request = state.beginRefresh()
        state.finishRefresh(request, nextCursor: "")
        XCTAssertNil(state.nextCursor)
    }

    func testAutomaticLoadKeyChangesWhenRefreshReturnsTheSameCursor() {
        var state = CursorPagingState(nextCursor: "stable-cursor")
        let beforeRefresh = state.automaticLoadKey

        let refresh = state.beginRefresh()
        XCTAssertNil(state.automaticLoadKey, "refreshing must hide the old paging boundary")
        state.finishRefresh(refresh, nextCursor: "stable-cursor")

        XCTAssertNotEqual(state.automaticLoadKey, beforeRefresh)
        XCTAssertEqual(state.automaticLoadKey?.cursor, "stable-cursor")
    }

    func testPagingBoundaryVisibilityUsesViewportAndPrefetchMargin() {
        let viewport = CGRect(x: 0, y: 0, width: 390, height: 800)

        XCTAssertTrue(
            pagingBoundaryIsVisible(
                CGRect(x: 0, y: 790, width: 390, height: 1),
                in: viewport
            )
        )
        XCTAssertTrue(
            pagingBoundaryIsVisible(
                CGRect(x: 0, y: 850, width: 390, height: 1),
                in: viewport
            ),
            "the boundary should prefetch just before it enters the viewport"
        )
        XCTAssertFalse(
            pagingBoundaryIsVisible(
                CGRect(x: 0, y: 900, width: 390, height: 1),
                in: viewport
            )
        )
        XCTAssertFalse(pagingBoundaryIsVisible(.null, in: viewport))
    }

    func testPagingCountLabelDistinguishesLoadedCountFromTotal() {
        XCTAssertEqual(pagingCountLabel(48, countIsPartial: true), "48 loaded")
        XCTAssertEqual(pagingCountLabel(48, countIsPartial: false), "48")
    }

    func testPagingCursorContinuationDistinguishesExhaustionFromStall() {
        XCTAssertEqual(
            pagingCursorContinuation(after: "cursor-1", next: nil, madeProgress: false),
            PagingCursorContinuation(nextCursor: nil, isTruncated: false)
        )
        XCTAssertEqual(
            pagingCursorContinuation(after: "cursor-1", next: "", madeProgress: false),
            PagingCursorContinuation(nextCursor: nil, isTruncated: false)
        )
        XCTAssertEqual(
            pagingCursorContinuation(
                after: "cursor-1",
                next: "cursor-1",
                madeProgress: true
            ),
            PagingCursorContinuation(nextCursor: nil, isTruncated: true)
        )
        XCTAssertEqual(
            pagingCursorContinuation(
                after: "cursor-1",
                next: "cursor-2",
                madeProgress: true
            ),
            PagingCursorContinuation(nextCursor: "cursor-2", isTruncated: false)
        )
    }

    func testAdvancingCursorWithoutVisibleProgressStopsAsTruncated() throws {
        var state = CursorPagingState(nextCursor: "cursor-1")
        let request = try XCTUnwrap(state.beginLoadMore())

        state.finishLoadMore(
            request,
            nextCursor: "cursor-2",
            madeProgress: false
        )

        XCTAssertNil(state.nextCursor)
        XCTAssertTrue(state.isTruncated)
        XCTAssertTrue(state.countIsPartial)
        XCTAssertFalse(state.isLoadingMore)
    }

    func testEmptyPageKeepsItsAutomaticBoundaryAndRetryMounted() {
        XCTAssertFalse(
            shouldShowPagedContent(
                itemCount: 0,
                canLoadMore: false,
                isLoadingMore: false,
                hasPaginationError: false
            )
        )
        XCTAssertTrue(
            shouldShowPagedContent(
                itemCount: 0,
                canLoadMore: true,
                isLoadingMore: false,
                hasPaginationError: false
            )
        )
        XCTAssertTrue(
            shouldShowPagedContent(
                itemCount: 0,
                canLoadMore: false,
                isLoadingMore: false,
                hasPaginationError: true
            )
        )
    }

    func testRefreshingAndTruncatedEmptyPagesKeepPagingContainerMounted() {
        var refreshing = CursorPagingState()
        _ = refreshing.beginRefresh()
        XCTAssertTrue(refreshing.hasPagingBoundary)
        XCTAssertTrue(shouldShowPagedContent(itemCount: 0, paging: refreshing))

        let truncated = CursorPagingState(isTruncated: true)
        XCTAssertTrue(truncated.hasPagingBoundary)
        XCTAssertTrue(truncated.countIsPartial)
        XCTAssertTrue(shouldShowPagedContent(itemCount: 0, paging: truncated))
        XCTAssertTrue(
            shouldShowPagedContent(
                itemCount: 0,
                canLoadMore: false,
                isLoadingMore: false,
                hasPaginationError: false,
                isTruncated: true
            )
        )
    }

    func testTopPagingWaitsForInteractionBeforeUsingAVisibleBoundary() {
        let key = PagingLoadKey(generation: 1, cursor: "older")
        let viewport = CGRect(x: 0, y: 0, width: 390, height: 800)
        let boundary = CGRect(x: 0, y: 40, width: 390, height: 1)

        XCTAssertFalse(
            shouldAutomaticallyLoadPage(
                automaticLoadingEnabled: false,
                hasError: false,
                isLoading: false,
                loadKey: key,
                lastRequested: nil,
                boundary: boundary,
                viewport: viewport
            ),
            "a short first history page must not prepend before the user interacts"
        )
        XCTAssertTrue(
            shouldAutomaticallyLoadPage(
                automaticLoadingEnabled: true,
                hasError: false,
                isLoading: false,
                loadKey: key,
                lastRequested: nil,
                boundary: boundary,
                viewport: viewport
            )
        )
    }

    func testPrependAnchorMathPreservesTheRowsViewportOffset() {
        let anchor = PagingPrependAnchor(
            id: "existing-row",
            viewportOffset: 120,
            rowHeight: 80
        )
        let unitY = pagingPrependRestorationUnitY(anchor, viewportHeight: 800)

        XCTAssertEqual(unitY, 1.0 / 6.0, accuracy: 0.0001)
        XCTAssertEqual(unitY * (800 - 80), 120, accuracy: 0.0001)
    }

    func testPrependAnchorMathPreservesAPartiallyClippedRow() {
        let anchor = PagingPrependAnchor(
            id: "existing-row",
            viewportOffset: -24,
            rowHeight: 80
        )
        let unitY = pagingPrependRestorationUnitY(anchor, viewportHeight: 800)

        XCTAssertLessThan(unitY, 0)
        XCTAssertEqual(unitY * (800 - 80), -24, accuracy: 0.0001)
    }

    func testAppendAndPrependUniquePreserveOrder() {
        var values = [2, 3]

        XCTAssertEqual(appendUnique([3, 4, 5], to: &values, id: \.self), [4, 5])
        XCTAssertEqual(values, [2, 3, 4, 5])

        XCTAssertEqual(prependUnique([0, 1, 2], to: &values, id: \.self), [0, 1])
        XCTAssertEqual(values, [0, 1, 2, 3, 4, 5])
    }
}
