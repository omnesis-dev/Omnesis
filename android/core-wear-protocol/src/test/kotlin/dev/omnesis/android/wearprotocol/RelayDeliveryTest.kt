// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import dev.omnesis.android.wearprotocol.RelayInbox.Action
import dev.omnesis.android.wearprotocol.RelayInbox.DropReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

class RelayDeliveryTest {
    private val now = 1_790_000_000_000L
    private val captureTime = NoteCaptureTime(now - 3_600_000, "Asia/Tokyo", 32_400)

    // Patience.

    @Test
    fun the_first_retry_is_quick() {
        assertEquals(0.7.seconds, RelayPatience.pause(attempts = 1, elapsed = 0.2.seconds))
    }

    @Test
    fun the_pauses_lengthen_and_the_longest_repeats() {
        assertEquals(
            listOf(0.7.seconds, 0.7.seconds, 1.5.seconds, 2.5.seconds, 3.seconds, 3.seconds, 3.seconds),
            listOf(0, 1, 2, 3, 4, 5, 30).map { RelayPatience.pause(it, Duration.ZERO) },
        )
    }

    @Test
    fun retries_span_the_delivery_window() {
        // Sends that each fail at once: the schedule alone fills the window.
        var elapsed = Duration.ZERO
        var attempts = 1
        while (true) {
            val pause = RelayPatience.pause(attempts, elapsed) ?: break
            elapsed += pause
            attempts += 1
        }
        assertEquals(20.seconds, RelayPatience.DELIVERY_WINDOW)
        assertTrue("elapsed $elapsed", elapsed > 15.seconds && elapsed < 20.seconds)
        assertEquals(9, attempts)
    }

    @Test
    fun no_attempt_starts_past_the_window() {
        assertEquals(3.seconds, RelayPatience.pause(attempts = 6, elapsed = 16.9.seconds))
        assertNull(RelayPatience.pause(attempts = 6, elapsed = 17.seconds))
        assertNull(RelayPatience.pause(attempts = 1, elapsed = 19.3.seconds))
        assertNull(RelayPatience.pause(attempts = 1, elapsed = 25.seconds))
    }

    @Test
    fun the_waits_on_the_peer_are_bounded() {
        assertEquals(70.seconds, RelayPatience.SEND_TIMEOUT)
        assertEquals(2.seconds, RelayPatience.DISPLAYED_REPLY_TIMEOUT)
    }

    // Queue.

    @Test
    fun a_queued_ask_expires_after_ten_minutes() {
        val limit = 10.minutes.inWholeMilliseconds
        assertEquals(10.minutes, RelayQueue.ASK_EXPIRY)
        assertFalse(RelayQueue.askIsExpired(queuedAt = now - limit, now = now))
        assertTrue(RelayQueue.askIsExpired(queuedAt = now - limit - 1, now = now))
    }

    @Test
    fun a_queued_ask_from_the_future_is_fresh() {
        assertFalse(RelayQueue.askIsExpired(queuedAt = now + 3_600_000, now = now))
    }

    @Test
    fun the_watch_leaves_an_expired_ask_for_the_phone_and_removes_it_only_after_a_week() {
        val week = OutboxPolicy.RETENTION.inWholeMilliseconds
        assertFalse(RelayQueue.askIsAbandoned(queuedAt = now - RelayQueue.ASK_EXPIRY.inWholeMilliseconds - 1, now = now))
        assertFalse(RelayQueue.askIsAbandoned(queuedAt = now - week, now = now))
        assertTrue(RelayQueue.askIsAbandoned(queuedAt = now - week - 1, now = now))
    }

    // What the watch waits for after sending a recording.

    @Test
    fun a_sent_recording_is_waited_on_for_a_bounded_time_and_a_note_for_none() {
        assertEquals(CapturePatience.ROUTE_WAIT, CapturePatience.silenceLimit(CaptureRoute.AUTOMATIC))
        assertEquals(CapturePatience.ANSWER_WAIT, CapturePatience.silenceLimit(CaptureRoute.ASK))
        assertNull(CapturePatience.silenceLimit(CaptureRoute.NOTE))
        // A turn the phone is still running is never given up on.
        assertTrue(CapturePatience.ANSWER_WAIT > RelayPatience.SEND_TIMEOUT)
    }

    // Recent refs.

    @Test
    fun a_ref_is_handled_once() {
        val refs = RecentRefs()
        assertTrue(refs.insert("a"))
        assertFalse(refs.insert("a"))
        assertTrue(refs.insert("b"))
        assertFalse(refs.insert("a"))
    }

    @Test
    fun the_oldest_ref_is_forgotten_past_capacity() {
        val refs = RecentRefs()
        assertEquals(32, RecentRefs.CAPACITY)
        for (index in 0..RecentRefs.CAPACITY) assertTrue(refs.insert("ref-$index"))
        assertFalse(refs.insert("ref-1"))
        assertFalse(refs.insert("ref-${RecentRefs.CAPACITY}"))
        assertTrue(refs.insert("ref-0"))
    }

    @Test
    fun a_relay_without_a_ref_is_always_new() {
        val refs = RecentRefs()
        assertTrue(refs.insert(null))
        assertTrue(refs.insert(null))
    }

    // Inbox.

    private fun queuedAsk(ref: String = "ask-1", ageMs: Long = 1_000, question: String = "Did the invoice go out?") =
        QueuedRelay(AskRequest(question, ref, "conversation-2"), queuedAt = now - ageMs, relayAttempts = 5)

    private fun queuedNote(ref: String = "note-1", ageMs: Long = 1_000, text: String = "Renew the passport") =
        QueuedRelay(TextNote.of(text, captureTime, ref), queuedAt = now - ageMs)

    @Test
    fun a_fresh_queued_ask_is_asked() {
        assertEquals(
            Action.Ask("ask-1", "Did the invoice go out?", "conversation-2"),
            RelayInbox.route(queuedAsk(question = "  Did the invoice go out? "), now, RecentRefs()),
        )
    }

    @Test
    fun a_stale_queued_ask_is_dropped() {
        assertEquals(
            Action.Drop(DropReason.EXPIRED),
            RelayInbox.route(queuedAsk(ageMs = 11.minutes.inWholeMilliseconds), now, RecentRefs()),
        )
    }

    @Test
    fun an_old_queued_note_is_still_saved() {
        assertEquals(
            Action.SaveNote("note-1", "Renew the passport", captureTime),
            RelayInbox.route(queuedNote(ageMs = 3.days.inWholeMilliseconds), now, RecentRefs()),
        )
    }

    @Test
    fun a_second_copy_of_a_relay_is_dropped() {
        val handled = RecentRefs()
        assertTrue(RelayInbox.route(queuedNote(), now, handled) is Action.SaveNote)
        assertEquals(Action.Drop(DropReason.DUPLICATE), RelayInbox.route(queuedNote(), now, handled))
        assertTrue(RelayInbox.route(queuedAsk(), now, handled) is Action.Ask)
        assertEquals(Action.Drop(DropReason.DUPLICATE), RelayInbox.route(queuedAsk(), now, handled))
    }

    @Test
    fun a_queued_copy_of_a_live_ask_is_dropped() {
        val handled = RecentRefs()
        assertTrue(handled.insert("ask-1"))
        assertEquals(Action.Drop(DropReason.DUPLICATE), RelayInbox.route(queuedAsk(), now, handled))
    }

    @Test
    fun a_dropped_relay_does_not_spend_its_ref() {
        val handled = RecentRefs()
        val expired = queuedAsk(ageMs = 11.minutes.inWholeMilliseconds)
        assertEquals(Action.Drop(DropReason.EXPIRED), RelayInbox.route(expired, now, handled))
        assertTrue(handled.insert("ask-1"))
    }

    @Test
    fun malformed_queued_relays_are_dropped() {
        val refs = RecentRefs()
        assertEquals(Action.Drop(DropReason.UNKNOWN_KIND), RelayInbox.route(QueuedRelay(VoiceNudge, now), now, refs))
        assertEquals(Action.Drop(DropReason.UNKNOWN_KIND), RelayInbox.route(queuedAsk(question = "  "), now, refs))
        assertEquals(Action.Drop(DropReason.UNKNOWN_KIND), RelayInbox.route(queuedNote(text = "\n"), now, refs))
        val timeless = QueuedRelay(TextNote("note-1", "Renew the passport", "soon", "Asia/Tokyo", 32_400), now)
        assertEquals(Action.Drop(DropReason.NOTE_WITHOUT_CAPTURE_TIME), RelayInbox.route(timeless, now, refs))
        assertTrue(refs.insert("note-1"))
    }

    // Live ask ledger.

    private val settled = AskResult.of(AskOutcome.Answered("It went out on Tuesday."), "ask-1")

    @Test
    fun the_first_copy_runs_and_a_later_one_waits_for_its_reply() {
        val ledger = LiveAskLedger<String>()
        assertEquals(LiveAskLedger.Claim.Run, ledger.claim("ask-1", isNew = true, waiter = "first"))
        assertEquals(LiveAskLedger.Claim.Held, ledger.claim("ask-1", isNew = false, waiter = "second"))
        assertEquals(LiveAskLedger.Claim.Held, ledger.claim("ask-1", isNew = false, waiter = "third"))
        assertEquals(listOf("second", "third"), ledger.settle("ask-1", settled))
    }

    @Test
    fun a_copy_after_the_first_settled_gets_its_reply() {
        val ledger = LiveAskLedger<String>()
        ledger.claim("ask-1", isNew = true, waiter = "first")
        assertEquals(emptyList<String>(), ledger.settle("ask-1", settled))
        assertEquals(LiveAskLedger.Claim.Reply(settled), ledger.claim("ask-1", isNew = false, waiter = "late"))
        assertEquals(emptyList<String>(), ledger.settle("ask-1", AskResult.of(AskOutcome.RelayFailed, "ask-1")))
        assertEquals(LiveAskLedger.Claim.Reply(settled), ledger.claim("ask-1", isNew = false, waiter = "later"))
    }

    @Test
    fun a_copy_of_an_ask_the_ledger_never_ran_is_untracked() {
        val ledger = LiveAskLedger<String>()
        assertEquals(LiveAskLedger.Claim.Untracked, ledger.claim("queued-ask", isNew = false, waiter = "copy"))
        assertEquals(emptyList<String>(), ledger.settle("queued-ask", settled))
    }

    @Test
    fun the_ledger_forgets_its_oldest_ask() {
        val ledger = LiveAskLedger<String>()
        for (index in 0..RecentRefs.CAPACITY) ledger.claim("ask-$index", isNew = true, waiter = "w")
        assertEquals(LiveAskLedger.Claim.Untracked, ledger.claim("ask-0", isNew = false, waiter = "copy"))
        assertEquals(LiveAskLedger.Claim.Held, ledger.claim("ask-1", isNew = false, waiter = "copy"))
    }

    // Recording inbox.

    @Test
    fun a_recording_older_than_the_outbox_keeps_it_is_expired() {
        val week = 7.days.inWholeMilliseconds
        assertEquals(3, RecordingInboxPolicy.MAX_ATTEMPTS)
        assertFalse(RecordingInboxPolicy.recordingIsExpired(capturedAt = now - week, now = now))
        assertTrue(RecordingInboxPolicy.recordingIsExpired(capturedAt = now - week - 1, now = now))
    }

    @Test
    fun a_completed_ref_is_remembered_for_two_weeks() {
        val twoWeeks = 14.days.inWholeMilliseconds
        assertEquals(14.days, RecordingInboxPolicy.RECEIPT_RETENTION)
        assertFalse(RecordingInboxPolicy.receiptIsExpired(completedAt = now - twoWeeks, now = now))
        assertTrue(RecordingInboxPolicy.receiptIsExpired(completedAt = now - twoWeeks - 1, now = now))
    }
}
