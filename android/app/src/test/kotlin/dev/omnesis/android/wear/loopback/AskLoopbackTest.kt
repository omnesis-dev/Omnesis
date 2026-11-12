// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.loopback

import dev.omnesis.android.wear.AskRun
import dev.omnesis.android.wear.Asked
import dev.omnesis.android.wear.RelayNotice
import dev.omnesis.android.wear.core.AskState
import dev.omnesis.android.wear.core.WatchHaptic
import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.RelayPatience
import dev.omnesis.android.wearprotocol.RelayQueue
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.WearLine
import java.io.IOException
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A question typed on the watch, from the press to what both devices show for it. */
class AskLoopbackTest {
    private val question = "When is the budget review?"
    private val answer = AskRun(AskOutcome.Answered("Tuesday at ten."), "conversation-1", "message-1")

    private fun answered(text: String) = AskState.Answered(text, AskOutcome.Kind.ANSWER, WearLine.STATUS_STILL_WORKING.text)

    private fun status(outcome: AskOutcome) =
        AskState.Answered(WearLine.forOutcome(outcome), outcome.kind, WearLine.statusTitle(outcome))

    @Test
    fun a_question_is_asked_once_and_its_answer_is_shown_and_read_aloud() = loopback {
        asker.run = answer
        asker.activity = listOf(AskActivityEvent.AgentStarted)
        asker.gate = CompletableDeferred()

        typeQuestion(question)
        pass(1.seconds)

        // Mid-turn the watch shows the step the phone reports.
        assertTrue(asked is AskState.Asking)
        assertEquals(WearLine.THINKING.text, watch.core.ask.activity.value?.label)

        asker.gate?.complete(Unit)
        pass()

        assertEquals(listOf(Asked("ask", question, null)), asker.asked)
        assertEquals(answered("Tuesday at ten."), asked)
        assertEquals("Tuesday at ten.", watch.speech.spoken.single().first)
        assertEquals(WatchHaptic.SUCCESS, watch.haptics.last())
        // The conversation is kept for a follow-up.
        assertEquals("conversation-1", watch.core.ask.conversationId)
        assertTrue("an answer shown on the watch needs no notification", notifier.posted.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun a_turn_that_outlasts_the_phones_wait_says_the_answer_will_come_as_a_notification() = loopback {
        asker.run = AskRun(AskOutcome.StillWorking, "conversation-1")

        typeQuestion(question)
        pass()

        assertEquals(status(AskOutcome.StillWorking), asked)
        assertEquals(WearLine.STATUS_STILL_WORKING.text, (asked as AskState.Answered).statusTitle)
        assertEquals(WatchHaptic.NOTIFICATION, watch.haptics.last())
        // The gateway's own push announces it; the phone adds nothing.
        assertTrue(notifier.posted.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun a_turn_that_fails_says_why_when_the_gateway_did() = loopback {
        asker.run = AskRun(AskOutcome.Failed("Rate limit reached"), "conversation-1")
        typeQuestion(question)
        pass()
        assertEquals(status(AskOutcome.Failed("Rate limit reached")), asked)
        assertEquals("Sorry — Rate limit reached.", (asked as AskState.Answered).text)
        assertEquals(WatchHaptic.FAILURE, watch.haptics.last())

        // A turn that ends by throwing is a failure too, never a watch left waiting.
        asker.failure = IOException("socket closed")
        typeQuestion(question)
        pass()
        assertEquals(status(AskOutcome.Failed()), asked)
        assertNothingLeft()
    }

    @Test
    fun every_way_the_phone_cannot_ask_reaches_the_watch_as_its_own_sentence() = loopback {
        val outcomes = listOf(
            AskOutcome.NotPaired, AskOutcome.Unauthorized, AskOutcome.Unreachable, AskOutcome.SendFailed,
            AskOutcome.EmptyAnswer, AskOutcome.PreviousTurnRunning,
        )
        for (outcome in outcomes) {
            asker.run = AskRun(outcome)
            typeQuestion(question)
            pass()
            assertEquals(status(outcome), asked)
        }
        assertEquals(outcomes.size, asker.asked.size)
    }

    @Test
    fun a_phone_out_of_reach_for_a_few_seconds_is_waited_for_and_asked_once() = loopback {
        asker.run = answer
        layer.disconnect()

        typeQuestion(question)
        pass(8.seconds)

        assertTrue(asked is AskState.Asking)
        assertEquals(WearLine.WAKING_PHONE.text, watch.core.ask.activity.value?.label)
        assertTrue(asker.asked.isEmpty())

        layer.connect()
        pass(6.seconds)

        assertEquals(answered("Tuesday at ten."), asked)
        assertEquals(1, asker.asked.size)
        assertTrue(notifier.posted.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun a_watch_with_no_phone_app_to_relay_to_says_so_at_once() = loopback {
        layer.phoneApp = false

        typeQuestion(question)
        pass(5.seconds)

        assertEquals(status(AskOutcome.PhoneUnreachable), asked)
        assertNothingLeft()
    }

    @Test
    fun a_question_the_phone_never_took_is_queued_and_answered_by_notification_when_the_phone_returns() = loopback {
        asker.run = answer
        layer.disconnect()

        typeQuestion(question)
        pass(RelayPatience.DELIVERY_WINDOW + 10.seconds)

        assertEquals(status(AskOutcome.QueuedForPhone), asked)
        assertEquals(WearLine.STATUS_QUEUED.text, (asked as AskState.Answered).statusTitle)
        assertEquals(setOf(WearDataLayer.queuedPath(ref(1))), layer.leftovers())

        sleepThrough(RelayQueue.ASK_EXPIRY - 1.minutes)
        layer.connect()
        pass()

        // Nobody is waiting on the watch any more: the phone hands the question off and announces the answer.
        assertEquals(listOf(Asked("handOff", question, null)), asker.asked)
        assertEquals(listOf(RelayNotice("Answer ready", "Tuesday at ten.", "conversation-1")), notifier.posted)
        // The watch still says where the question went, and its queued copy is gone from both devices.
        assertEquals(status(AskOutcome.QueuedForPhone), asked)
        assertNothingLeft()
    }

    @Test
    fun a_queued_question_whose_turn_is_still_running_is_left_to_the_gateways_own_notification() = loopback {
        asker.run = AskRun(AskOutcome.StillWorking, "conversation-1")
        layer.disconnect()
        typeQuestion(question)
        pass(RelayPatience.DELIVERY_WINDOW + 10.seconds)

        layer.connect()
        pass()

        assertEquals(1, asker.asked.size)
        assertTrue(notifier.posted.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun a_queued_question_that_reaches_the_phone_too_late_is_reported_once_and_never_asked() = loopback {
        layer.disconnect()
        typeQuestion(question)
        pass(RelayPatience.DELIVERY_WINDOW + 10.seconds)
        assertEquals(status(AskOutcome.QueuedForPhone), asked)

        sleepThrough(RelayQueue.ASK_EXPIRY + 1.minutes)
        // The person looks at the watch again before the phone is back.
        watch.core.launched()
        pass()

        layer.connect()
        pass()
        // The Data Layer hands the phone the same item a second time.
        layer.deliveredToPhone.lastOrNull()?.let { phone.relay.onItem(it) }
        pass()

        assertTrue(asker.asked.isEmpty())
        assertEquals(listOf(RelayNotice.questionExpired), notifier.posted)
        assertNothingLeft()
    }

    @Test
    fun a_follow_up_typed_after_an_answer_starts_a_new_conversation() = loopback {
        asker.run = answer
        typeQuestion(question)
        pass()

        typeQuestion("And where?")
        pass()

        assertEquals(listOf(Asked("ask", question, null), Asked("ask", "And where?", null)), asker.asked)
    }

    @Test
    fun a_reply_lost_on_the_way_back_is_made_up_for_by_the_result_sent_beside_it() = loopback {
        asker.run = answer
        layer.losesReplies = true

        typeQuestion(question)
        pass()

        assertEquals(answered("Tuesday at ten."), asked)
        assertEquals(1, asker.asked.size)
        assertNothingLeft()
    }

    @Test
    fun a_reply_and_a_result_both_lost_end_as_an_answer_on_the_phone_never_a_second_ask() = loopback {
        asker.run = answer
        layer.losesReplies = true
        layer.losesMessagesToWatch = true

        typeQuestion(question)
        pass(RelayPatience.SEND_TIMEOUT + 5.seconds)

        assertEquals(status(AskOutcome.AnswerOnPhone), asked)
        assertEquals(1, asker.asked.size)
        assertNothingLeft()
    }

    @Test
    fun a_data_layer_that_gives_up_on_the_reply_says_the_answer_is_still_coming() = loopback {
        asker.run = answer
        asker.gate = CompletableDeferred()
        layer.requestTimeout = 30.seconds

        typeQuestion(question)
        pass(40.seconds)

        assertEquals(status(AskOutcome.StillWorking), asked)
        assertEquals(1, asker.asked.size)
    }

    @Test
    fun the_same_question_arriving_twice_is_asked_once_and_both_copies_get_the_one_answer() = loopback { test ->
        asker.run = answer
        asker.gate = CompletableDeferred()
        val request = WearCodec.encode(AskRequest(question, ref(40)))

        // A send the watch saw fail can still have landed; its retry is the second copy.
        val first = test.backgroundScope.async { phone.relay.onRequest(LoopbackDataLayer.WATCH, WearDataLayer.ASK_PATH, request) }
        val second = test.backgroundScope.async { phone.relay.onRequest(LoopbackDataLayer.WATCH, WearDataLayer.ASK_PATH, request) }
        pass(1.seconds)
        assertEquals(1, asker.asked.size)

        asker.gate?.complete(Unit)
        pass()
        val third = test.backgroundScope.async { phone.relay.onRequest(LoopbackDataLayer.WATCH, WearDataLayer.ASK_PATH, request) }
        pass()

        val expected = AskResult.of(answer.outcome, ref(40), "conversation-1", "message-1")
        for (copy in listOf(first, second, third)) {
            assertEquals(expected, WearCodec.decode(copy.getCompleted()!!))
        }
        assertEquals(1, asker.asked.size)
    }

    @Test
    fun a_question_answered_live_is_not_asked_again_from_a_queued_copy_that_arrives_later() = loopback { test ->
        asker.run = answer
        // The watch gave up on a send that had in fact landed, and queued the question as well.
        layer.losesReplies = true
        layer.losesMessagesToWatch = true
        layer.requestTimeout = null
        typeQuestion(question)
        pass(5.seconds)
        assertEquals(1, asker.asked.size)

        val queued = dev.omnesis.android.wearprotocol.QueuedRelay(AskRequest(question, ref(1)), queuedAt = now)
        test.backgroundScope.launch {
            layer.watchLink.putItem(WearDataLayer.queuedPath(ref(1)), WearCodec.encode(queued))
        }
        pass()

        assertEquals(1, asker.asked.size)
        assertTrue(notifier.posted.isEmpty())
        assertEquals(emptySet<String>(), layer.leftovers())
    }
}
