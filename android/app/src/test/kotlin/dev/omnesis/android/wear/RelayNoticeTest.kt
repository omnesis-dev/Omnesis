// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.assistant.VoiceAskOutcome
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.WearLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayNoticeTest {
    @Test
    fun an_answer_and_a_failure_open_the_conversation_they_belong_to() {
        assertEquals(
            RelayNotice("Answer ready", "Tuesday at ten", "conversation-1"),
            RelayNotice.queuedAsk(AskOutcome.Answered("Tuesday\n  at ten"), "conversation-1"),
        )
        assertEquals(
            RelayNotice("Answer failed", "Sorry — The agent model is not assigned.", "conversation-1"),
            RelayNotice.queuedAsk(AskOutcome.Failed("The agent model is not assigned"), "conversation-1"),
        )
        assertEquals(
            RelayNotice("Answer failed", WearLine.EMPTY_ANSWER.text, "conversation-1"),
            RelayNotice.queuedAsk(AskOutcome.EmptyAnswer, "conversation-1"),
        )
    }

    @Test
    fun a_turn_still_running_is_the_gateway_push_to_announce() {
        assertNull(RelayNotice.queuedAsk(AskOutcome.StillWorking, "conversation-1"))
        assertNull(RelayNotice.queuedAsk(AskOutcome.PreviousTurnRunning, "conversation-1"))
    }

    @Test
    fun a_question_that_never_reached_the_gateway_says_why() {
        for (outcome in listOf(AskOutcome.NotPaired, AskOutcome.Unauthorized, AskOutcome.Unreachable, AskOutcome.SendFailed)) {
            val notice = RelayNotice.queuedAsk(outcome, null)
            assertEquals("Couldn't ask your watch question", notice?.title)
            assertEquals(WearLine.forOutcome(outcome), notice?.body)
            assertNull(notice?.conversationId)
        }
    }

    @Test
    fun a_long_answer_is_clipped_to_banner_length() {
        val body = RelayNotice.queuedAsk(AskOutcome.Answered("word ".repeat(80)), null)!!.body
        assertEquals(RelayNotice.MAX_BODY_LENGTH, body.length)
        assertTrue(body.endsWith("…"))
    }

    @Test
    fun capture_notices_share_one_slot_and_read_the_shared_lines() {
        val notices = listOf(
            RelayNotice.captureDelayed to WearLine.CAPTURE_DELAYED,
            RelayNotice.captureExpired to WearLine.CAPTURE_EXPIRED,
            RelayNotice.askInterrupted to WearLine.CAPTURE_ASK_INTERRUPTED,
            RelayNotice.captureAbandoned to WearLine.RECORDING_NOT_SAVED,
        )
        for ((notice, line) in notices) {
            assertEquals(WearLine.CAPTURE_NOTICE_TITLE.text, notice.title)
            assertEquals(line.text, notice.body)
        }
        assertEquals(1, notices.map { it.first.slot }.toSet().size)
        assertNull(RelayNotice.voiceNoteFailed.slot)
        assertNull(RelayNotice.questionExpired.slot)
    }

    @Test
    fun every_phone_outcome_has_a_watch_outcome() {
        val mapped = mapOf(
            VoiceAskOutcome.Answered("Tuesday at ten") to AskOutcome.Answered("Tuesday at ten"),
            VoiceAskOutcome.Failed("Model unavailable") to AskOutcome.Failed("Model unavailable"),
            VoiceAskOutcome.EmptyAnswer to AskOutcome.EmptyAnswer,
            VoiceAskOutcome.StillWorking to AskOutcome.StillWorking,
            VoiceAskOutcome.PreviousTurnRunning to AskOutcome.PreviousTurnRunning,
            VoiceAskOutcome.NotPaired to AskOutcome.NotPaired,
            VoiceAskOutcome.Unauthorized to AskOutcome.Unauthorized,
            VoiceAskOutcome.Unreachable to AskOutcome.Unreachable,
            VoiceAskOutcome.SendFailed to AskOutcome.SendFailed,
        )
        for ((phone, watch) in mapped) assertEquals(watch, RunnerWatchAsker.watchOutcome(phone))
        // A send that may have landed is a failure whose sentence says to check before asking again.
        val uncertain = RunnerWatchAsker.watchOutcome(VoiceAskOutcome.DeliveryUncertain) as AskOutcome.Failed
        assertTrue(WearLine.forOutcome(uncertain).startsWith("Sorry — The connection dropped while sending."))
    }
}
