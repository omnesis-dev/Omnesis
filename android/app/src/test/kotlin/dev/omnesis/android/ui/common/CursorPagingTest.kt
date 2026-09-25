// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CursorPagingTest {

    @Test
    fun refresh_invalidates_an_older_page_request() {
        val first = CursorPagingState(nextCursor = "page-2").beginLoadMore()!!
        val refresh = first.state.beginRefresh()

        assertFalse(refresh.state.owns(first.request))
        assertTrue(refresh.state.owns(refresh.request))
    }

    @Test
    fun only_one_page_request_can_own_a_cursor() {
        val started = CursorPagingState(nextCursor = "page-2").beginLoadMore()!!

        assertNull(started.state.beginLoadMore())
        assertTrue(started.state.owns(started.request))
    }

    @Test
    fun repeated_cursor_or_duplicate_only_page_is_exhausted() {
        val repeated = CursorPagingState(nextCursor = "page-2").beginLoadMore()!!
        val afterRepeated = repeated.state.finishLoadMore(repeated.request, "page-2")
        assertFalse(afterRepeated.canLoadMore)
        assertTrue(afterRepeated.countIsPartial)

        val duplicateOnly = CursorPagingState(nextCursor = "page-2").beginLoadMore()!!
        val afterDuplicate = duplicateOnly.state.finishLoadMore(
            duplicateOnly.request,
            "page-3",
            madeProgress = false,
        )
        assertFalse(afterDuplicate.canLoadMore)
        assertTrue(afterDuplicate.countIsPartial)

        val complete = CursorPagingState(nextCursor = "page-2").beginLoadMore()!!
        val afterComplete = complete.state.finishLoadMore(
            complete.request,
            nextCursor = null,
            madeProgress = false,
        )
        assertFalse(afterComplete.canLoadMore)
        assertFalse(afterComplete.countIsPartial)
    }

    @Test
    fun failed_next_page_keeps_the_cursor_for_retry() {
        val started = CursorPagingState(nextCursor = "page-2").beginLoadMore()!!
        val failed = started.state.failLoadMore(started.request, IllegalStateException("offline"))

        assertTrue(failed.canLoadMore)
        assertFalse(failed.isLoadingMore)
        assertEquals("offline", failed.paginationError?.message)
    }

    @Test
    fun failed_refresh_is_separate_from_an_append_error() {
        val started = CursorPagingState().beginRefresh()
        val failed = started.state.failRefresh(
            started.request,
            IllegalStateException("offline"),
        )

        assertFalse(failed.isRefreshing)
        assertEquals("offline", failed.refreshError?.message)
        assertNull(failed.paginationError)
    }

    @Test
    fun definitive_empty_requires_a_successful_terminal_page() {
        assertTrue(CursorPagingState().canShowDefinitiveEmpty)
        assertFalse(
            CursorPagingState(nextCursor = "page-2").canShowDefinitiveEmpty,
        )
        assertFalse(
            CursorPagingState(isRefreshing = true).canShowDefinitiveEmpty,
        )
        assertFalse(
            CursorPagingState(isLoadingMore = true).canShowDefinitiveEmpty,
        )
        assertFalse(
            CursorPagingState(
                refreshError = IllegalStateException("initial failure"),
            ).canShowDefinitiveEmpty,
        )
        assertFalse(
            CursorPagingState(
                paginationError = IllegalStateException("page failure"),
            ).canShowDefinitiveEmpty,
        )
        assertFalse(
            CursorPagingState(stoppedBeforeEnd = true).canShowDefinitiveEmpty,
        )
    }

    @Test
    fun append_and_prepend_preserve_order_without_duplicate_ids() {
        data class Row(val id: Int)

        assertEquals(
            listOf(1, 2, 3),
            appendUnique(
                listOf(Row(1), Row(2)),
                listOf(Row(2), Row(3)),
            ) { it.id }.map { it.id },
        )
        assertEquals(
            listOf(0, 1, 2),
            prependUnique(
                listOf(Row(1), Row(2)),
                listOf(Row(0), Row(1)),
            ) { it.id }.map { it.id },
        )
    }

    @Test
    fun prepend_anchor_preserves_offsets_on_both_sides_of_the_viewport_start() {
        assertEquals(18, prependAnchorScrollOffset(-18))
        assertEquals(-12, prependAnchorScrollOffset(12))
        assertEquals(0, prependAnchorScrollOffset(0))
    }
}
