// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.transport.dto.PageInfo
import dev.omnesis.android.transport.dto.RecentDocument
import dev.omnesis.android.transport.dto.RecentItemsResponse
import dev.omnesis.android.ui.common.CursorPagingState
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SourceRecentPagingRaceTest {
    @Test
    fun successful_delete_invalidates_inflight_page_that_contains_deleted_row() {
        val paging = CursorPagingState(nextCursor = "page-2")
        val started = checkNotNull(paging.beginLoadMore())
        val afterDelete = started.state.reset(started.state.nextCursor)
        val current = RecentItemsResponse.Documents(listOf(document("keep")))
        val staleIncoming = RecentItemsResponse.Documents(
            listOf(document("deleted"), document("later")),
            PageInfo(nextCursor = "page-3"),
        )

        assertFalse(afterDelete.owns(started.request))
        assertEquals(listOf("keep"), current.documents.map { it.id })
        assertEquals(
            listOf("keep"),
            removeRecentDocument(
                RecentItemsResponse.Documents(listOf(document("keep"), document("deleted"))),
                "deleted",
            ).documents.map { it.id },
        )
        // The stale response is deliberately not merged once ownership is invalidated.
        assertTrue(staleIncoming.documents.any { it.id == "deleted" })
    }

    @Test
    fun page_completion_merges_into_latest_rows_not_the_request_snapshot() {
        val latest = RecentItemsResponse.Documents(
            listOf(document("first"), document("concurrent")),
        )
        val incoming = RecentItemsResponse.Documents(
            listOf(document("next")),
            PageInfo(nextCursor = "page-3"),
        )

        val merged = mergeRecentPage(latest, incoming) as RecentItemsResponse.Documents

        assertEquals(listOf("first", "concurrent", "next"), merged.documents.map { it.id })
    }

    private fun document(id: String) = RecentDocument(
        id = id,
        sourceId = "fictional:account",
        title = "Invented document $id",
        sourceCreatedAt = "2026-01-01T00:00:00Z",
    )

    @Test
    fun projection_change_adopts_the_incoming_shape() {
        // The source changed projection while the screen was open (first
        // documents arriving): keeping the stale shape would freeze the
        // screen until reload. Mirrors the iOS recent view.
        val current = RecentItemsResponse.Empty()
        val incoming = RecentItemsResponse.Documents(listOf(document("fresh")))
        assertEquals(incoming, mergeRecentPage(current, incoming))

        val docs = RecentItemsResponse.Documents(listOf(document("old")))
        val analytics = analytics(columns = listOf("a"))
        assertEquals(analytics, mergeRecentPage(docs, analytics))
    }

    @Test
    fun analytics_column_change_replaces_instead_of_concatenating() {
        // Concatenating rows across different columns would misalign them.
        val current = analytics(columns = listOf("a"))
        val incoming = analytics(columns = listOf("a", "b"))
        assertEquals(incoming, mergeRecentPage(current, incoming))
    }

    @Test
    fun analytics_same_schema_concatenates_rows() {
        val current = analytics(columns = listOf("a"))
        val incoming = analytics(columns = listOf("a"))
        val merged = mergeRecentPage(current, incoming) as RecentItemsResponse.Analytics
        assertEquals(current.rows + incoming.rows, merged.rows)
    }

    private fun analytics(columns: List<String>) = RecentItemsResponse.Analytics(
        table = "fictional_table",
        columns = columns,
        rows = listOf(listOf(JsonPrimitive("cell"))),
    )
}
