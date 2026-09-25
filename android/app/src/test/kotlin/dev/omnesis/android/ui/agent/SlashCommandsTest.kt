// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit coverage for the composer's `/`→Deep Research affordance:
 *   - the pure slash-command matching/decision logic (the menu open/close
 *     rules + which commands surface), and
 *   - the per-message arming bridge that maps an armed command to the
 *     `deepResearch` send flag.
 *
 * The interactive arm→send→clear behaviour is a Compose gesture sequence
 * snapshots can't catch; it's reasoned about against these pure functions
 * (arming seeds `armedId`; `submit()` reads it, clears it, and hands the
 * resolved command to `onSend` — so the flag governs exactly one send).
 */
class SlashCommandsTest {

    // --- Registry ---

    @Test
    fun registry_seeded_with_deep_research() {
        val cmd = SlashCommand.byId("deep-research")
        assertNotNull(cmd)
        assertTrue(cmd?.deepResearch == true)
        assertEquals(false, cmd?.experimental)
    }

    @Test
    fun unknown_id_returns_null() {
        assertNull(SlashCommand.byId("does-not-exist"))
        assertNull(SlashCommand.byId(null))
    }

    // --- matchSlashCommands ---

    @Test
    fun non_slash_text_closes_menu() {
        assertFalse(matchSlashCommands("").isOpen)
        assertFalse(matchSlashCommands("hello").isOpen)
        assertFalse(matchSlashCommands(" /deep").isOpen)
    }

    @Test
    fun bare_slash_lists_everything_when_experimental_mode_is_off() {
        val state = matchSlashCommands("/")
        assertTrue(state.isOpen)
        assertEquals(SlashCommand.all.size, state.matches.size)
    }

    @Test
    fun bare_slash_lists_everything_in_experimental_mode() {
        val state = matchSlashCommands("/", experimental = true)
        assertTrue(state.isOpen)
        assertEquals(SlashCommand.all.size, state.matches.size)
    }

    @Test
    fun deep_research_surfaces_off_experimental_mode() {
        assertEquals("deep-research", matchSlashCommands("/deep").matches.firstOrNull()?.id)
        assertEquals("deep-research", matchSlashCommands("/research").matches.firstOrNull()?.id)
        assertEquals("deep-research", matchSlashCommands("/").matches.firstOrNull()?.id)
    }

    @Test
    fun partial_token_matches_by_trigger_and_label() {
        assertEquals("deep-research", matchSlashCommands("/deep").matches.firstOrNull()?.id)
        assertEquals("deep-research", matchSlashCommands("/research").matches.firstOrNull()?.id)
        // Case-insensitive.
        assertEquals("deep-research", matchSlashCommands("/DEEP").matches.firstOrNull()?.id)
    }

    @Test
    fun whitespace_closes_menu_even_after_slash_word() {
        // Once the user types a space, they're composing a real prompt — the
        // menu must close even though the text still starts with `/`.
        assertFalse(matchSlashCommands("/deep research my running").isOpen)
    }

    @Test
    fun no_match_keeps_menu_open_but_empty() {
        val state = matchSlashCommands("/zzzz")
        assertTrue(state.isOpen)
        assertTrue(state.matches.isEmpty())
    }

    // --- Armed-command → send-flag bridge ---

    @Test
    fun armed_deep_research_command_maps_to_flag() {
        // The bridge the composer uses (`command?.deepResearch ?: false`) when
        // handing the send to the coordinator.
        val armed = SlashCommand.byId("deep-research")
        assertEquals(true, armed?.deepResearch ?: false)
        // No armed command ⇒ ordinary turn.
        val none: SlashCommand? = null
        assertEquals(false, none?.deepResearch ?: false)
    }
}
