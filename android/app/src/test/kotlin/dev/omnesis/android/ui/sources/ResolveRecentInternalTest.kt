// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The recent screen's internal-source decision: the recent envelope's flag
 * wins, the sources list is the fallback for older gateways, and a
 * registered row of the same id always wins over an internal entry.
 */
class ResolveRecentInternalTest {

    @Test
    fun envelope_flag_wins_over_an_empty_list() {
        assertTrue(resolveRecentInternal("omnesis-notes", true, emptyList(), emptyList()))
    }

    @Test
    fun list_membership_covers_gateways_without_the_envelope_flag() {
        assertTrue(resolveRecentInternal("omnesis-notes", false, emptyList(), listOf("omnesis-notes")))
    }

    @Test
    fun unknown_source_is_not_internal() {
        assertFalse(resolveRecentInternal("gmail:a@example.com", false, listOf("gmail:a@example.com"), emptyList()))
    }

    @Test
    fun registered_row_wins_over_internal_entry() {
        assertFalse(
            resolveRecentInternal(
                "omnesis-notes",
                false,
                listOf("omnesis-notes"),
                listOf("omnesis-notes"),
            ),
        )
    }

    @Test
    fun envelope_flag_still_wins_when_registered() {
        // The envelope describes the source the gateway served: when it says
        // internal, the prompt collapses even if a stale list also names a
        // registration. (Unreachable in practice — the gateway never serves
        // both — but the precedence must be total.)
        assertTrue(
            resolveRecentInternal(
                "omnesis-notes",
                true,
                listOf("omnesis-notes"),
                listOf("omnesis-notes"),
            ),
        )
    }
}
