// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskProgress
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.AskToolOutcome
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.RelayInbox
import dev.omnesis.android.wearprotocol.RelayQueue
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.WearLine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TextAskRelayTest {
    private val gateway = FakeWearGateway()
    private val asker = FakeAsker()
    private val store = FakeStateStore()
    private fun relay() = TextAskRelay(gateway, asker, HandledRefs(store))

    @Test
    fun an_answer_is_the_reply_and_is_also_sent_on_its_own_after_the_progress() = runTest {
        asker.activity = listOf(
            AskActivityEvent.Connecting,
            AskActivityEvent.RequestSent,
            AskActivityEvent.AgentStarted,
            AskActivityEvent.ToolStarted("call-1", "search_documents"),
            // A replayed event changes nothing and is not sent again.
            AskActivityEvent.ToolStarted("call-1", "search_documents"),
            AskActivityEvent.ToolFinished("call-1", AskToolOutcome.Search(12)),
        )

        val result = relay().onRequest(WATCH, AskRequest("  When is the budget review? ", "ref-1"))

        val expected = AskResult("answered", "Tuesday at ten", "ref-1", "conversation-1", "message-1")
        assertEquals(expected, result)
        assertEquals(listOf(Asked("ask", "When is the budget review?", null)), asker.asked)
        assertEquals(
            listOf(
                Sent.Message(WATCH, WearDataLayer.PROGRESS_PATH, AskProgress(WearLine.RECEIVED.text, null, "ref-1")),
                Sent.Message(WATCH, WearDataLayer.PROGRESS_PATH, AskProgress(WearLine.ASKING.text, null, "ref-1")),
                Sent.Message(WATCH, WearDataLayer.PROGRESS_PATH, AskProgress(WearLine.THINKING.text, null, "ref-1")),
                Sent.Message(WATCH, WearDataLayer.PROGRESS_PATH, AskProgress(WearLine.SEARCHING.text, null, "ref-1")),
                Sent.Message(
                    WATCH,
                    WearDataLayer.PROGRESS_PATH,
                    AskProgress(WearLine.SEARCHING.text, "12 found", "ref-1"),
                ),
                Sent.Message(WATCH, WearDataLayer.RESULT_PATH, expected),
            ),
            gateway.sent,
        )
    }

    @Test
    fun a_turn_still_running_at_the_budget_tells_the_watch_a_notification_follows() = runTest {
        asker.run = AskRun(AskOutcome.StillWorking, "conversation-1", "message-1")
        val result = relay().onRequest(WATCH, AskRequest("Question", "ref-1"))

        assertEquals(AskOutcome.StillWorking, result.toOutcome())
        assertEquals("conversation-1", result.conversationId)
        assertEquals(result, gateway.messagesOn(WearDataLayer.RESULT_PATH).single())
    }

    @Test
    fun a_failure_travels_with_its_reason() = runTest {
        asker.run = AskRun(AskOutcome.Failed("The agent model is not assigned"))
        val result = relay().onRequest(WATCH, AskRequest("Question", "ref-1"))

        assertEquals(AskResult("failed", "The agent model is not assigned", "ref-1"), result)
        asker.run = AskRun(AskOutcome.NotPaired)
        assertEquals(AskResult("notPaired", null, "ref-2"), relay().onRequest(WATCH, AskRequest("Question", "ref-2")))
    }

    @Test
    fun a_follow_up_resumes_the_conversation_on_screen() = runTest {
        relay().onRequest(WATCH, AskRequest("And after that?", "ref-1", conversationId = "conversation-7"))
        assertEquals(listOf(Asked("ask", "And after that?", "conversation-7")), asker.asked)
    }

    @Test
    fun a_blank_question_fails_without_asking_or_spending_its_ref() = runTest {
        val relay = relay()
        assertEquals(AskResult("failed", null, "ref-1"), relay.onRequest(WATCH, AskRequest("   ", "ref-1")))
        assertTrue(asker.asked.isEmpty())
        assertTrue(store.refs.isEmpty())
    }

    @Test
    fun a_second_copy_arriving_mid_turn_waits_for_the_first_and_is_not_asked_again() = runTest {
        asker.gate = CompletableDeferred()
        val relay = relay()
        val first = async { relay.onRequest(WATCH, AskRequest("Question", "ref-1")) }
        runCurrent()
        val second = async { relay.onRequest(WATCH, AskRequest("Question", "ref-1")) }
        runCurrent()
        assertFalse(second.isCompleted)

        asker.gate?.complete(Unit)

        assertEquals(first.await(), second.await())
        assertEquals(1, asker.asked.size)
        assertEquals(1, gateway.messagesOn(WearDataLayer.RESULT_PATH).size)
    }

    @Test
    fun a_copy_arriving_after_the_turn_settled_gets_the_same_result() = runTest {
        val relay = relay()
        val first = relay.onRequest(WATCH, AskRequest("Question", "ref-1"))
        val again = relay.onRequest(WATCH, AskRequest("Question", "ref-1"))

        assertEquals(first, again)
        assertEquals(1, asker.asked.size)
    }

    @Test
    fun a_copy_of_a_question_an_earlier_process_took_is_not_asked_again() = runTest {
        relay().onRequest(WATCH, AskRequest("Question", "ref-1"))

        // A new process: the ledger is gone, the handled refs are not.
        val result = relay().onRequest(WATCH, AskRequest("Question", "ref-1"))

        assertEquals(AskResult("stillWorking", null, "ref-1"), result)
        assertEquals(1, asker.asked.size)
    }

    @Test
    fun a_turn_that_ends_in_an_error_is_settled_as_a_failure_for_every_copy() = runTest {
        asker.failure = IllegalStateException("session closed")
        val relay = relay()

        val first = relay.onRequest(WATCH, AskRequest("Question", "ref-1"))
        val again = relay.onRequest(WATCH, AskRequest("Question", "ref-1"))

        assertEquals(AskResult("failed", null, "ref-1"), first)
        assertEquals(first, again)
        assertEquals(first, gateway.messagesOn(WearDataLayer.RESULT_PATH).single())
    }

    @Test
    fun a_watch_out_of_reach_for_messages_still_gets_the_reply() = runTest {
        gateway.failMessages = true
        asker.activity = listOf(AskActivityEvent.AgentStarted)
        val result = relay().onRequest(WATCH, AskRequest("Question", "ref-1"))
        assertEquals(AskOutcome.Answered("Tuesday at ten"), result.toOutcome())
    }
}

class TextNoteRelayTest {
    private val notes = FakeNotes()
    private val store = FakeStateStore()
    private val relay = TextNoteRelay(notes, HandledRefs(store))
    private fun note(text: String = "Buy oat milk", ref: String = "ref-1") = TextNote.of(text, CAPTURE_TIME, ref)

    @Test
    fun a_note_is_saved_with_the_time_the_watch_captured_it() = runTest {
        assertEquals(NoteAck("saved", "ref-1"), relay.onRequest(note("  Buy oat milk ")))
        assertEquals(listOf(SavedNote("Buy oat milk", CAPTURE_TIME, "ref-1", null)), notes.saved)
    }

    @Test
    fun the_ack_says_what_the_phone_did() = runTest {
        notes.outcome = NoteOutcome.QUEUED_ON_PHONE
        assertEquals(NoteAck("queuedOnPhone", "ref-1"), relay.onRequest(note(ref = "ref-1")))
        notes.outcome = NoteOutcome.REJECTED
        assertEquals(NoteAck("rejected", "ref-2"), relay.onRequest(note(ref = "ref-2")))
        notes.outcome = NoteOutcome.CAPTURE_FAILED
        assertEquals(NoteAck("captureFailed", "ref-3"), relay.onRequest(note(ref = "ref-3")))
    }

    @Test
    fun a_second_copy_reached_the_phone_and_is_not_saved_twice() = runTest {
        relay.onRequest(note())
        assertEquals(NoteAck("reachedPhone", "ref-1"), relay.onRequest(note()))
        assertEquals(1, notes.saved.size)
    }

    @Test
    fun a_note_that_cannot_be_read_as_one_is_refused_without_spending_its_ref() = runTest {
        assertEquals(NoteAck("relayFailed", "ref-1"), relay.onRequest(note("   ")))
        val timeless = TextNote("ref-1", "Buy oat milk", "not a time", "Europe/Lisbon", 0)
        assertEquals(NoteAck("relayFailed", "ref-1"), relay.onRequest(timeless))
        assertTrue(notes.saved.isEmpty())
        assertEquals(NoteAck("saved", "ref-1"), relay.onRequest(note()))
    }
}

class QueuedRelayHandlerTest {
    private val gateway = FakeWearGateway()
    private val asker = FakeAsker()
    private val notes = FakeNotes()
    private val notifier = FakeNotifier()
    private val store = FakeStateStore()
    private var now = CAPTURED_AT + 60_000
    private fun handler() = QueuedRelayHandler(gateway, asker, notes, HandledRefs(store), notifier) { now }

    private fun item(queued: QueuedRelay, ref: String = "ref-1") =
        WearItem(WearDataLayer.queuedPath(ref), WATCH, queued)

    private fun queuedAsk(ref: String = "ref-1", conversationId: String? = null) =
        QueuedRelay(AskRequest("When is the budget review?", ref, conversationId), queuedAt = CAPTURED_AT)

    private val deleted = Sent.Deleted(WearDataLayer.queuedPath("ref-1"), WATCH)

    @Test
    fun a_fresh_question_is_handed_off_and_its_answer_arrives_as_a_notification() = runTest {
        asker.run = AskRun(AskOutcome.Answered("Tuesday at ten"), "conversation-1", notifyLocally = true)

        val action = handler().handle(item(queuedAsk(conversationId = "conversation-0")))

        assertEquals(RelayInbox.Action.Ask("ref-1", "When is the budget review?", "conversation-0"), action)
        assertEquals(listOf(Asked("handOff", "When is the budget review?", "conversation-0")), asker.asked)
        assertEquals(listOf(RelayNotice("Answer ready", "Tuesday at ten", "conversation-1")), notifier.posted)
        assertEquals(listOf<Sent>(deleted), gateway.sent)
    }

    @Test
    fun a_turn_still_running_is_left_to_the_gateway_push() = runTest {
        asker.run = AskRun(AskOutcome.StillWorking, "conversation-1")
        handler().handle(item(queuedAsk()))
        assertTrue(notifier.posted.isEmpty())
        assertEquals(listOf<Sent>(deleted), gateway.sent)
    }

    @Test
    fun a_question_that_could_not_be_asked_says_so() = runTest {
        asker.run = AskRun(AskOutcome.Unreachable)
        handler().handle(item(queuedAsk()))
        assertEquals(
            listOf(RelayNotice("Couldn't ask your watch question", WearLine.UNREACHABLE.text)),
            notifier.posted,
        )
    }

    @Test
    fun a_question_older_than_ten_minutes_is_reported_and_never_asked() = runTest {
        now = CAPTURED_AT + RelayQueue.ASK_EXPIRY.inWholeMilliseconds + 1

        val action = handler().handle(item(queuedAsk()))

        assertEquals(RelayInbox.Action.Drop(RelayInbox.DropReason.EXPIRED), action)
        assertTrue(asker.asked.isEmpty())
        assertEquals(listOf(RelayNotice.questionExpired), notifier.posted)
        assertEquals(listOf<Sent>(deleted), gateway.sent)
    }

    @Test
    fun an_expired_question_delivered_again_is_reported_once() = runTest {
        now = CAPTURED_AT + RelayQueue.ASK_EXPIRY.inWholeMilliseconds + 1
        handler().handle(item(queuedAsk()))
        handler().handle(item(queuedAsk()))
        assertEquals(listOf(RelayNotice.questionExpired), notifier.posted)
    }

    @Test
    fun a_question_answered_live_is_not_reported_expired_when_its_queued_copy_turns_up_late() = runTest {
        TextAskRelay(gateway, asker, HandledRefs(store)).onRequest(WATCH, AskRequest("When is the budget review?", "ref-1"))
        now = CAPTURED_AT + RelayQueue.ASK_EXPIRY.inWholeMilliseconds + 1

        handler().handle(item(queuedAsk()))

        assertTrue(notifier.posted.isEmpty())
        assertEquals(1, asker.asked.size)
    }

    @Test
    fun a_question_already_taken_live_is_dropped_even_by_a_later_process() = runTest {
        TextAskRelay(gateway, asker, HandledRefs(store)).onRequest(WATCH, AskRequest("When is the budget review?", "ref-1"))
        gateway.sent.clear()

        val action = handler().handle(item(queuedAsk()))

        assertEquals(RelayInbox.Action.Drop(RelayInbox.DropReason.DUPLICATE), action)
        assertEquals(1, asker.asked.size)
        assertTrue(notifier.posted.isEmpty())
        assertEquals(listOf<Sent>(deleted), gateway.sent)
    }

    @Test
    fun a_queued_copy_delivered_twice_is_asked_once() = runTest {
        handler().handle(item(queuedAsk()))
        handler().handle(item(queuedAsk()))
        assertEquals(1, asker.asked.size)
    }

    @Test
    fun a_queued_note_is_saved_acknowledged_and_deleted() = runTest {
        val queued = QueuedRelay(TextNote.of("Buy oat milk", CAPTURE_TIME, "ref-1"), queuedAt = CAPTURED_AT)
        // A note has no expiry, however long it waited.
        now = CAPTURED_AT + 3 * 24 * 60 * 60 * 1000L

        handler().handle(item(queued))

        assertEquals(listOf(SavedNote("Buy oat milk", CAPTURE_TIME, "ref-1", null)), notes.saved)
        assertEquals(
            listOf(Sent.Message(WATCH, WearDataLayer.NOTE_PATH, NoteAck("saved", "ref-1")), deleted),
            gateway.sent,
        )
    }

    @Test
    fun a_queued_copy_of_a_note_saved_live_only_releases_the_watch() = runTest {
        val note = TextNote.of("Buy oat milk", CAPTURE_TIME, "ref-1")
        TextNoteRelay(notes, HandledRefs(store)).onRequest(note)

        handler().handle(item(QueuedRelay(note, queuedAt = CAPTURED_AT)))

        assertEquals(1, notes.saved.size)
        assertEquals(
            listOf(Sent.Message(WATCH, WearDataLayer.NOTE_PATH, NoteAck("reachedPhone", "ref-1")), deleted),
            gateway.sent,
        )
    }

    @Test
    fun an_item_that_is_not_a_queued_relay_is_deleted_and_nothing_else() = runTest {
        assertNull(handler().handle(WearItem(WearDataLayer.queuedPath("ref-1"), WATCH, payload = null)))
        val wrong = QueuedRelay(NoteAck("saved", "ref-1"), queuedAt = CAPTURED_AT)
        assertEquals(RelayInbox.Action.Drop(RelayInbox.DropReason.UNKNOWN_KIND), handler().handle(item(wrong)))
        assertEquals(listOf<Sent>(deleted, deleted), gateway.sent)
        assertTrue(notifier.posted.isEmpty())
    }
}
