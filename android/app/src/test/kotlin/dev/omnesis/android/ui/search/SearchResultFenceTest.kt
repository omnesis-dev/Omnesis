// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SearchResultFenceTest {
    @Test fun `only the latest overlapping search may publish results`() {
        val fence = SearchResultFence()
        val first = fence.begin()
        val second = fence.begin()

        assertFalse(fence.isCurrent(first))
        assertTrue(fence.isCurrent(second))

        fence.invalidate()
        assertFalse(fence.isCurrent(second))
    }

    @Test fun `editing an in-flight query clears the invalidated loading state`() {
        val edited = searchStateAfterQueryEdit(
            SearchViewModel.State(
                query = "first",
                status = SearchViewModel.Status.Loading,
                hasSearched = true,
                lastQuery = "first",
            ),
            "second",
        )

        assertEquals("second", edited.query)
        assertEquals(SearchViewModel.Status.Idle, edited.status)
        assertFalse(edited.hasSearched)
    }
}
