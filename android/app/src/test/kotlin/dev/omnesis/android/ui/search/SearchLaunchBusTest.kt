// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SearchLaunchBusTest {
    @Test fun `query and fallback launches remain distinct and consume safely`() {
        val bus = SearchLaunchBus()
        bus.post("  Q4 budget  ")
        val query = bus.request.value!!
        assertEquals("Q4 budget", query.query)

        bus.post(null)
        val fallback = bus.request.value!!
        assertEquals("", fallback.query)

        bus.consume(query)
        assertEquals(fallback, bus.request.value)
        bus.consume(fallback)
        assertNull(bus.request.value)
    }
}
