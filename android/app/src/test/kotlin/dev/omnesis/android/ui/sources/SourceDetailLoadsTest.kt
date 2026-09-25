// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.ui.common.Loadable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SourceDetailLoadsTest {
    @Test fun reconnect_during_initial_load_reaches_content_and_rejects_the_old_response() {
        val loads = SourceDetailLoads<String>()
        val first = loads.begin(clear = true)
        val reconnect = loads.begin(clear = false)
        loads.succeeded(reconnect, "current")
        loads.succeeded(first, "stale")
        assertEquals(Loadable.Content("current"), loads.state.value)
    }

    @Test fun removal_invalidates_inflight_load_and_explicit_readd_recovers_from_removed_state() {
        val loads = SourceDetailLoads<String>()
        val first = loads.begin(clear = true)
        loads.removed(SourceNoLongerAvailable())
        loads.succeeded(first, "removed record")
        assertTrue(loads.state.value is Loadable.Error)
        val readd = loads.begin(clear = false)
        loads.succeeded(readd, "new record")
        assertEquals(Loadable.Content("new record"), loads.state.value)
    }
}
