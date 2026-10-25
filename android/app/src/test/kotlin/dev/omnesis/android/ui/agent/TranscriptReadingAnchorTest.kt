// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.DailyBriefMessageRef
import dev.omnesis.android.ui.agent.TranscriptReadingAnchor.Memory
import dev.omnesis.android.ui.agent.TranscriptReadingAnchor.Placement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TranscriptReadingAnchorTest {

    private fun user(id: String, text: String) = AgentTurn.User(id, text)
    private fun reply(id: String, text: String) = AgentTurn.Assistant(id, parts = listOf(AgentPart.Text(text)))

    private val conversation = listOf(
        user("u-0", "Which invoices are still open?"),
        reply("a-1", "Two are open: the print shop and the venue."),
        user("u-2", "Summarise the venue contract."),
        reply("a-3", "The venue contract runs to four pages."),
    )

    private fun step(
        turns: List<AgentTurn>,
        busy: Boolean = false,
        foreground: Boolean = true,
        memory: Memory = Memory(),
    ) = TranscriptReadingAnchor.step(turns, busy, foreground, memory)

    @Test
    fun a_loaded_conversation_ending_in_a_finished_reply_opens_at_that_reply() {
        assertEquals(Placement.Reply("a-3"), step(conversation).placement)
    }

    @Test
    fun a_pending_reply_or_a_busy_agent_follows_the_bottom() {
        val pending = conversation + user("u-4", "And the deposit?")
        assertEquals(Placement.FollowBottom, step(pending).placement)
        assertEquals(Placement.FollowBottom, step(conversation, busy = true).placement)
        assertEquals(Placement.FollowBottom, step(emptyList()).placement)
    }

    @Test
    fun a_reply_watched_to_its_end_in_the_foreground_is_not_repositioned_even_after_a_reload() {
        val asked = conversation + user("u-4", "And the deposit?")
        var memory = step(asked).memory
        val streaming = asked + reply("msg_live", "The deposit")
        memory = step(streaming, busy = true, memory = memory).memory
        val finished = asked + reply("msg_live", "The deposit is due on Friday.")
        val done = step(finished, memory = memory)
        assertEquals(Placement.Keep, done.placement)

        // A reload renumbers the ids; the reply is still the one the reader watched.
        val reloaded = asked + reply("a-5", "The deposit is due on Friday.")
        assertEquals(Placement.Keep, step(reloaded, memory = done.memory).placement)
    }

    @Test
    fun a_reply_that_finished_while_the_app_was_in_the_background_opens_at_its_top() {
        val asked = conversation + user("u-4", "And the deposit?")
        var memory = step(asked).memory
        memory = step(asked + reply("msg_live", "The deposit"), busy = true, memory = memory).memory
        // The app goes to the background mid-reply.
        memory = step(asked + reply("msg_live", "The deposit is"), busy = true, foreground = false, memory = memory).memory

        val reloaded = asked + reply("a-5", "The deposit is due on Friday.")
        assertEquals(Placement.Reply("a-5"), step(reloaded, memory = memory).placement)
        // Finishing on the live stream while away counts the same.
        val finishedAway = asked + reply("msg_live", "The deposit is due on Friday.")
        assertEquals(Placement.Reply("msg_live"), step(finishedAway, foreground = false, memory = memory).placement)
    }

    @Test
    fun a_reload_of_the_reply_the_reader_was_placed_on_keeps_their_place() {
        val opened = step(conversation)
        val reloaded = conversation.map {
            when (it) {
                is AgentTurn.User -> it.copy(id = "reload-${it.id}")
                is AgentTurn.Assistant -> it.copy(id = "reload-${it.id}")
            }
        }
        assertEquals(Placement.Keep, step(reloaded, memory = opened.memory).placement)
    }

    @Test
    fun a_new_reply_that_arrives_with_a_reload_is_placed_on() {
        val opened = step(conversation)
        val later = conversation + user("u-4", "And the deposit?") + reply("a-5", "The deposit is due on Friday.")
        assertEquals(Placement.Reply("a-5"), step(later, memory = opened.memory).placement)
    }

    @Test
    fun a_brief_is_placed_with_the_separator_that_heads_its_day_and_an_answer_on_its_own_row() {
        val ref = DailyBriefMessageRef(day = "2026-10-14", messageIndex = 0, messageId = "mb_today")
        val brief = reply(AgentTurnBuilder.briefTurnId(ref), "Good morning.")
        val question = user("u-1", "What first?")
        val answer = reply("a-2", "Start with the deposit.")
        val rows = listOf(
            DailyBriefRow.Separator(ref, foldable = false, open = true),
            DailyBriefRow.Brief(ref, brief),
            DailyBriefRow.Footer(ref),
            DailyBriefRow.Turn(question),
            DailyBriefRow.Turn(answer),
        )
        assertEquals(0, TranscriptReadingAnchor.briefRowIndex(rows, brief.id))
        assertEquals(4, TranscriptReadingAnchor.briefRowIndex(rows, answer.id))
        assertNull(TranscriptReadingAnchor.briefRowIndex(rows, "missing"))
    }
}
