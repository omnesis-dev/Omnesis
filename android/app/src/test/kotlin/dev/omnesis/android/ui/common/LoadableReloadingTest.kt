// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A reload has to be sayable without throwing away what the reader is holding.
 *
 * Before `Content` could carry it, the only way a screen with rows could report "fetching" was
 * to go back to `Loading` — which is the same state as "nothing yet", so the rows vanished
 * behind a full-screen spinner every time somebody pulled to refresh.
 */
class LoadableReloadingTest {

    @Test
    fun a_reload_over_content_keeps_the_content() {
        val loaded: Loadable<List<String>> = Loadable.Content(listOf("a row"))

        val reloading = loaded.reloading()

        assertEquals(listOf("a row"), (reloading as Loadable.Content).value)
        assertTrue(reloading.refreshing)
        assertTrue(reloading.isReloading)
    }

    /** Nothing to keep, so this is an ordinary first load and reads as one. */
    @Test
    fun a_reload_with_nothing_on_screen_is_a_first_load() {
        assertSame(Loadable.Loading, Loadable.Loading.reloading())
        assertSame(Loadable.Loading, Loadable.Error(IllegalStateException("fictional")).reloading())
    }

    /** A second pull while one is already running must not stack or churn the state. */
    @Test
    fun reloading_twice_is_the_same_state() {
        val once = Loadable.Content(listOf("a row")).reloading()

        assertSame(once, once.reloading())
    }

    @Test
    fun freshly_loaded_content_is_not_reloading() {
        val settled = Loadable.Content(listOf("a row"))

        assertFalse(settled.refreshing)
        assertFalse(settled.isReloading)
        assertFalse(Loadable.Loading.isReloading)
    }
}
