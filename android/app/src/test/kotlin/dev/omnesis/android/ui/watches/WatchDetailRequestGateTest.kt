// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.watches

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The watch detail reads four things in sequence, and a revoke re-reads all of them. Two of
 * those runs can overlap — a revoke finishes and reloads while the reader has already pulled to
 * retry — so the screen has to show the newest answer, not whichever request happened to
 * return last.
 */
class WatchDetailRequestGateTest {

    @Test
    fun a_newer_load_retires_the_one_already_in_flight() {
        val gate = WatchDetailRequestGate()

        val first = gate.beginLoad()
        val second = gate.beginLoad()

        assertFalse("the slower first read must not land", gate.ownsLoad(first))
        assertTrue(gate.ownsLoad(second))
    }

    /**
     * A revoke's own re-read is the authority: whatever was already being fetched describes the
     * access the operator just withdrew, and letting it land would show it as still granted.
     */
    @Test
    fun a_revoke_retires_whatever_was_already_being_read() {
        val gate = WatchDetailRequestGate()

        val load = gate.beginLoad()
        val revocation = gate.invalidate()

        assertFalse(gate.ownsLoad(load))
        assertTrue(gate.ownsLoad(revocation))
    }

    @Test
    fun a_load_with_nothing_after_it_still_owns_the_screen() {
        val gate = WatchDetailRequestGate()

        assertTrue(gate.ownsLoad(gate.beginLoad()))
    }
}
