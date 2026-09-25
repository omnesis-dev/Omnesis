// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Day derivation and Tell Omnesis URL building for read-only Notes documents. */
class ManageNotesTest {

    @Test
    fun day_prefers_external_id_then_creation_date() {
        assertEquals("2026-03-01", notesDayForDocument("2026-03-01", "2026-03-02T10:00:00Z"))
        assertEquals("2026-03-02", notesDayForDocument("run-001", "2026-03-02T10:00:00Z"))
        assertNull(notesDayForDocument(null, null))
        assertNull(notesDayForDocument("nope", "also-nope"))
    }

    @Test
    fun url_seeds_the_day_and_carries_the_token() {
        assertEquals(
            "https://gateway.example:7942/portal/capture?day=2026-03-01&token=omn_t",
            manageNotesUrl("https://gateway.example:7942", "omn_t", "2026-03-01"),
        )
        assertEquals(
            "https://gateway.example:7942/portal/capture?token=omn_t",
            manageNotesUrl("https://gateway.example:7942/", "omn_t", null),
        )
    }

    @Test
    fun url_percent_encodes_a_token_with_reserved_characters() {
        // Locks the encoder against the iOS URLComponents builder, which
        // must produce the identical string for the same inputs.
        assertEquals(
            "https://gateway.example:7942/portal/capture?day=2026-03-01&token=a%2Bb%26c",
            manageNotesUrl("https://gateway.example:7942", "a+b&c", "2026-03-01"),
        )
    }

    @Test
    fun day_rejects_padded_and_truncated_dates() {
        // A padded external id is not a day, but the creation-date
        // fallback still applies when it is day-shaped.
        assertEquals(
            "2026-03-01",
            notesDayForDocument(" 2026-03-01", "2026-03-01T10:00:00Z"),
        )
        assertNull(notesDayForDocument(" 2026-03-01", "not-a-date"))
        assertNull(notesDayForDocument(null, "2026-03"))
        assertNull(notesDayForDocument("2026-03-01 ", null))
    }

    @Test
    fun only_the_notes_source_gets_the_manage_link() {
        assertTrue(isNotesSource(NOTES_SOURCE_ID))
        assertFalse(isNotesSource("gmail:fictional-account"))
    }
}
