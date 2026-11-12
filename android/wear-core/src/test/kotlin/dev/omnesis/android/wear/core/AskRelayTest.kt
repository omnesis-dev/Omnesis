// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.RelayPatience
import dev.omnesis.android.wearprotocol.VoiceNudge
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

@OptIn(ExperimentalCoroutinesApi::class)
class AskRelayTest {
    private val request = AskRequest("Is the market open on Sunday?", "q1")
    private val queuedPath = WearDataLayer.queuedPath("q1")

    private class Relay(val test: TestScope) {
        val link = FakeLink()
        val log = FakeLog()
        var waking = 0
        private val environment = object : WatchEnvironment {
            override fun now() = 1_790_000_000_000L + test.testScheduler.currentTime

            override fun zone() = java.time.ZoneId.of("UTC")

            override fun localeTag() = "en"

            override fun newRef() = "unused"
        }
        val relay = AskRelay(link, environment, log)

        fun start(request: AskRequest): Deferred<AskSettlement> =
            test.backgroundScope.async { relay.relay(request) { waking += 1 } }.also { test.runCurrent() }

        fun settle() = test.runCurrent()

        fun pass(duration: Duration) {
            test.advanceTimeBy(duration.inWholeMilliseconds)
            test.runCurrent()
        }
    }

    private fun relay(body: suspend Relay.() -> Unit) = runTest { Relay(this).body() }

    @Test
    fun the_phones_reply_settles_the_question() = relay {
        link.respond = { _, _ ->
            link.reply(AskResult.of(AskOutcome.Answered("Yes, from nine until one."), "q1", conversationId = "c7"))
        }
        val settled = start(request).await()
        assertEquals(AskOutcome.Answered("Yes, from nine until one."), settled.outcome)
        assertEquals("c7", settled.conversationId)
        assertEquals(WearDataLayer.ASK_PATH to request, link.requests.single())
        assertTrue(link.items.isEmpty())
        assertEquals(0, waking)
    }

    @Test
    fun a_failure_the_phone_reports_is_not_retried() = relay {
        link.respond = { _, _ -> link.reply(AskResult.of(AskOutcome.Unreachable, "q1")) }
        assertEquals(AskOutcome.Unreachable, start(request).await().outcome)
        assertEquals(1, link.requests.size)
    }

    @Test
    fun the_separate_result_message_settles_a_question_whose_reply_is_lost() = relay {
        link.respond = { _, _ -> awaitCancellation() }
        val waiting = start(request)
        relay.resolve("q1", AskResult.of(AskOutcome.StillWorking, "q1"))
        settle()
        assertEquals(AskOutcome.StillWorking, waiting.await().outcome)
    }

    @Test
    fun a_result_for_another_question_changes_nothing() = relay {
        link.respond = { _, _ -> awaitCancellation() }
        val waiting = start(request)
        relay.resolve("q0", AskResult.of(AskOutcome.Answered("Stale"), "q0"))
        settle()
        assertFalse(waiting.isCompleted)
    }

    @Test
    fun a_reply_that_cannot_be_read_is_a_relay_failure() = relay {
        link.respond = { _, _ -> LinkReply.Reply("nonsense".encodeToByteArray()) }
        assertEquals(AskOutcome.RelayFailed, start(request).await().outcome)
    }

    @Test
    fun a_reply_of_another_kind_or_for_another_question_is_a_relay_failure() = relay {
        link.respond = { _, _ -> link.reply(NoteAck.of(NoteOutcome.SAVED, "q1")) }
        assertEquals(AskOutcome.RelayFailed, start(request).await().outcome)
        link.respond = { _, _ -> link.reply(AskResult.of(AskOutcome.Answered("Wrong one"), "q0")) }
        assertEquals(AskOutcome.RelayFailed, start(request).await().outcome)
    }

    @Test
    fun a_reply_that_never_comes_ends_as_an_answer_waiting_on_the_phone() = relay {
        link.respond = { _, _ -> awaitCancellation() }
        val waiting = start(request)
        pass(RelayPatience.SEND_TIMEOUT - 1.seconds)
        assertFalse(waiting.isCompleted)
        pass(1.seconds)
        assertEquals(AskOutcome.AnswerOnPhone, waiting.await().outcome)
        assertTrue("a question the phone took is not queued as well", link.items.isEmpty())
    }

    @Test
    fun each_link_failure_maps_to_its_outcome() = relay {
        link.respond = { _, _ -> LinkReply.TimedOut(15) }
        assertEquals(AskOutcome.StillWorking, start(request).await().outcome)
        link.respond = { _, _ -> LinkReply.LinkDown(17) }
        assertEquals(AskOutcome.WatchLinkInactive, start(request).await().outcome)
        link.respond = { _, _ -> LinkReply.Failed(13) }
        assertEquals(AskOutcome.RelayFailed, start(request).await().outcome)
    }

    @Test
    fun an_unreachable_phone_is_retried_through_the_window_then_the_question_is_queued() = relay {
        link.reachable = false
        val waiting = start(request)
        pass(RelayPatience.DELIVERY_WINDOW + 15.seconds)
        assertEquals(AskOutcome.QueuedForPhone, waiting.await().outcome)
        assertTrue("several attempts were made", link.requests.size > 2)
        assertEquals(link.requests.size - 1, waking)
        val queued = link.item(queuedPath) as QueuedRelay
        assertEquals(request, queued.message)
        assertEquals(link.requests.size, queued.relayAttempts)
        assertTrue(link.sent.isEmpty())
    }

    @Test
    fun a_phone_that_wakes_during_the_window_answers_and_nothing_is_queued() = relay {
        link.reachable = false
        link.respond = { _, _ -> link.reply(AskResult.of(AskOutcome.Answered("Tuesday."), "q1")) }
        val waiting = start(request)
        pass(5.seconds)
        assertFalse(waiting.isCompleted)
        link.reachable = true
        pass(5.seconds)
        assertEquals(AskOutcome.Answered("Tuesday."), waiting.await().outcome)
        assertNull(link.item(queuedPath))
        assertTrue(waking >= 1)
    }

    @Test
    fun a_connected_phone_whose_app_never_takes_the_question_is_nudged_once_it_is_queued() = relay {
        // The node is connected, but each send finds the phone app not running yet.
        link.respond = { _, _ -> LinkReply.Unreachable(phoneCannotReceive = false, code = 4000) }
        val waiting = start(request)
        pass(RelayPatience.DELIVERY_WINDOW)
        assertEquals(AskOutcome.QueuedForPhone, waiting.await().outcome)
        val queued = link.item(queuedPath) as QueuedRelay
        assertEquals(4000, queued.relayLastError)
        assertEquals(link.requests.size, queued.relayAttempts)
        assertEquals(listOf(WearDataLayer.VOICE_NUDGE_PATH to VoiceNudge), link.sent)
    }

    @Test
    fun a_watch_with_no_phone_app_to_reach_fails_at_once_and_queues_nothing() = relay {
        link.reachable = false
        link.installed = false
        val waiting = start(request)
        pass(4.seconds)
        assertEquals(AskOutcome.PhoneUnreachable, waiting.await().outcome)
        assertEquals(1, link.requests.size)
        assertTrue(link.items.isEmpty())
    }

    @Test
    fun a_question_that_cannot_be_queued_ends_unreachable() = relay {
        link.reachable = false
        link.putsSucceed = false
        val waiting = start(request)
        pass(RelayPatience.DELIVERY_WINDOW + 15.seconds)
        assertEquals(AskOutcome.PhoneUnreachable, waiting.await().outcome)
    }

    @Test
    fun a_cancelled_relay_queues_nothing() = relay {
        link.reachable = false
        val waiting = start(request)
        pass(6.seconds)
        waiting.cancel()
        pass(RelayPatience.DELIVERY_WINDOW + 15.seconds)
        assertTrue(link.items.isEmpty())
    }

    @Test
    fun a_late_reply_to_an_earlier_question_does_not_settle_the_next() = relay {
        val first = CompletableDeferred<LinkReply>()
        link.respond = { _, message -> if ((message as AskRequest).ref == "q1") first.await() else awaitCancellation() }
        val one = start(request)
        one.cancel()
        settle()
        val two = start(AskRequest("And on Monday?", "q2"))
        first.complete(link.reply(AskResult.of(AskOutcome.Answered("Stale"), "q1")))
        relay.resolve("q1", AskResult.of(AskOutcome.Answered("Stale"), "q1"))
        settle()
        assertFalse(two.isCompleted)
    }
}
