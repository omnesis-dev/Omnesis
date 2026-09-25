// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Spec for the forward-looking consent-expiry pill label (#927), which must be distinct
 * from the red terminal `needs-auth`. Keyed on the generic state string — no source-name
 * branching.
 */
class SourceFormattingTest {

    @Test
    fun `auth-expiring pill label is expiring and distinct from needs-auth`() {
        assertEquals("expiring", stateLabel("auth-expiring", paused = false))
        assertEquals("expiring", stateLabel("auth-expiring", paused = false, compact = true))
        assertNotEquals(
            stateLabel("needs-auth", paused = false),
            stateLabel("auth-expiring", paused = false),
        )
    }

    @Test
    fun `paused trumps the auth-expiring state`() {
        assertEquals("paused", stateLabel("auth-expiring", paused = true))
    }
}

/**
 * Spec for the `stale` pill label. The label mapping ends in a fallback, so an unmapped
 * state used to be silently relabelled "idle" — which for `stale` is not merely unstyled
 * but actively wrong: a source that has stopped receiving data would read as one that has
 * simply never synced. Keyed on the generic state string — no source-name branching.
 */
class StaleStateLabelTest {
    @Test
    fun `stale is labelled as itself, not collapsed into idle`() {
        assertEquals("stale", stateLabel("stale", paused = false))
        assertEquals("stale", stateLabel("stale", paused = false, compact = true))
        assertNotEquals(stateLabel("idle", paused = false), stateLabel("stale", paused = false))
    }

    @Test
    fun `pausing a source wins over its stale state`() {
        assertEquals("paused", stateLabel("stale", paused = true))
    }

    @Test
    fun `an unrecognised state keeps its own name rather than reading as idle`() {
        // A future gateway state must degrade honestly. Relabelling it "idle"
        // hides it, which is how the stale state itself went unnoticed here.
        assertEquals("some-future-state", stateLabel("some-future-state", paused = false))
    }

    @Test
    fun `a blank state still falls back to idle`() {
        assertEquals("idle", stateLabel("", paused = false))
    }
}
