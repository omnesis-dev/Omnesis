// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.DailyBriefReactionDto
import dev.omnesis.android.transport.dto.DailyBriefReactionKind
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A reaction shows on its item at once, settles on the gateway's answer, and goes back on a
 * refusal with the reason left for the footer. All fixture data is invented.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DailyBriefHolderReactionTest {

    private val day = DailyBriefFixtures.today.day

    private fun holder(sender: DailyBriefFixtures.Sender) =
        DailyBriefHolder(DailyBriefFixtures.CONVERSATION_ID, loader = null, preloaded = listOf(DailyBriefFixtures.today), reactions = sender)

    private fun DailyBriefHolder.reaction(observationId: String) = view.reaction(day, observationId)

    @Test
    fun a_reaction_shows_at_once_and_settles_on_the_gateway_answer() = runTest(UnconfinedTestDispatcher()) {
        val sender = DailyBriefFixtures.Sender(held = setOf("obs_deposit"))
        val holder = holder(sender)
        assertNull(holder.reaction("obs_deposit"))

        val send = launch { holder.react(day, "obs_deposit", DailyBriefReactionKind.UP) }
        // Optimistic: the kind is on the item before the gateway answers, with no time yet.
        assertEquals(DailyBriefReactionDto(kind = "up"), holder.reaction("obs_deposit"))

        sender.release("obs_deposit")
        send.join()
        assertEquals(DailyBriefReactionDto(kind = "up", at = sender.at), holder.reaction("obs_deposit"))
        assertEquals(listOf(DailyBriefFixtures.Reaction("obs_deposit", DailyBriefReactionKind.UP, null)), sender.sent)
        assertNull(holder.view.reactionError)
    }

    @Test
    fun a_refused_reaction_goes_back_and_says_why() = runTest(UnconfinedTestDispatcher()) {
        val sender = DailyBriefFixtures.Sender(failing = setOf("obs_review"))
        val holder = holder(sender)
        val before = holder.reaction("obs_review")
        assertEquals("not_interested", before?.kind)

        val refusal = holder.react(day, "obs_review", null)

        assertEquals(before, holder.reaction("obs_review"))
        assertTrue(refusal!!.startsWith("Couldn't save your reaction"))
        assertEquals(day, holder.view.reactionError?.day)
        assertEquals(refusal, holder.view.reactionError?.message)

        holder.ackReactionError()
        assertNull(holder.view.reactionError)
    }

    @Test
    fun the_words_of_a_thumbs_down_ride_with_it_and_a_clear_sends_null() = runTest(UnconfinedTestDispatcher()) {
        val sender = DailyBriefFixtures.Sender()
        val holder = holder(sender)

        assertNull(holder.react(day, "obs_deposit", DailyBriefReactionKind.FACTUAL_ERROR, note = " Paid on Monday. "))
        assertEquals(
            DailyBriefReactionDto(kind = "factual_error", note = "Paid on Monday.", at = sender.at),
            holder.reaction("obs_deposit"),
        )
        assertNull(holder.react(day, "obs_deposit", null))
        assertNull(holder.reaction("obs_deposit"))
        assertEquals(
            listOf(
                DailyBriefFixtures.Reaction("obs_deposit", DailyBriefReactionKind.FACTUAL_ERROR, " Paid on Monday. "),
                DailyBriefFixtures.Reaction("obs_deposit", null, null),
            ),
            sender.sent,
        )
    }

    /** The next reaction clears the last refusal's message, so a stale reason never outlives a success. */
    @Test
    fun a_later_success_clears_the_earlier_refusal() = runTest(UnconfinedTestDispatcher()) {
        val sender = DailyBriefFixtures.Sender(failing = setOf("obs_tuner"))
        val holder = holder(sender)
        holder.react(day, "obs_tuner", null)
        assertEquals(day, holder.view.reactionError?.day)

        holder.react(day, "obs_deposit", DailyBriefReactionKind.UP)
        assertNull(holder.view.reactionError)
        assertEquals("up", holder.reaction("obs_tuner")?.kind)
    }

    /** Without a sender the thumbs are inert: nothing changes and nothing is reported. */
    @Test
    fun no_sender_means_no_change() = runTest {
        val holder = DailyBriefHolder(DailyBriefFixtures.CONVERSATION_ID, loader = null, preloaded = listOf(DailyBriefFixtures.today))
        assertNull(holder.react(day, "obs_deposit", DailyBriefReactionKind.UP))
        assertNull(holder.reaction("obs_deposit"))
    }
}
