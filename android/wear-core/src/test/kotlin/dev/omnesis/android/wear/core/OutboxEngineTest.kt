// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.NoteCaptureTime
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.OutboxPolicy
import dev.omnesis.android.wearprotocol.OutboxPolicy.Trigger
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.RecordingMetadata
import dev.omnesis.android.wearprotocol.RecordingReceipt
import dev.omnesis.android.wearprotocol.RelayQueue
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.VoiceNudge
import dev.omnesis.android.wearprotocol.VoiceRecording
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

@OptIn(ExperimentalCoroutinesApi::class)
class OutboxEngineTest {
    private fun outbox(body: suspend WatchHarness.() -> Unit) = runTest {
        val harness = WatchHarness(this)
        try {
            harness.body()
        } finally {
            harness.cleanUp()
        }
    }

    private fun WatchHarness.captureTime() = NoteCaptureTime.at(now, environment.zone())

    private fun WatchHarness.addRecording(ref: String, route: CaptureRoute? = CaptureRoute.NOTE) {
        core.store.recordingFile(ref).writeBytes(byteArrayOf(7, 8, 9))
        core.store.add(VoiceRecording(ref, captureTime(), "en-GB", route))
    }

    private fun WatchHarness.addNote(ref: String, text: String = "Water the ferns on Friday") {
        core.store.add(TextNote.of(text, captureTime(), ref))
    }

    private fun WatchHarness.refs() = core.store.entries().map { it.ref }.toSet()

    private val recordingA = WearDataLayer.recordingPath("a")
    private val queuedN = WearDataLayer.queuedPath("n")

    @Test
    fun a_recording_goes_as_a_data_item_with_its_audio_and_a_nudge() = outbox {
        addRecording("a")
        val carried = core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        assertEquals(setOf("a"), carried)
        assertEquals("a", (link.item(recordingA) as RecordingMetadata).ref)
        assertArrayEquals(byteArrayOf(7, 8, 9), link.audio[recordingA])
        assertEquals(listOf(WearDataLayer.VOICE_NUDGE_PATH to VoiceNudge), link.sent)
        assertEquals(setOf("a"), refs())
    }

    @Test
    fun a_recording_a_data_item_already_holds_is_not_put_again() = outbox {
        addRecording("a")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        link.audio.clear()
        val carried = core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        assertEquals(setOf("a"), carried)
        assertTrue("the held item was not rewritten", link.audio.isEmpty())
    }

    @Test
    fun a_receipt_releases_the_recording_and_deletes_its_item() = outbox {
        addRecording("a")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        fromPhone(RecordingReceipt("a"), WearDataLayer.RECORDING_RECEIVED_PATH)
        assertTrue(refs().isEmpty())
        assertNull(link.item(recordingA))
        assertFalse(core.store.audioFile("a").exists())
    }

    @Test
    fun an_unreachable_phone_still_gets_the_recording_item_but_no_nudge() = outbox {
        link.reachable = false
        addRecording("a")
        assertEquals(setOf("a"), core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED))
        assertTrue(link.items.containsKey(recordingA))
        assertTrue(link.sent.isEmpty())
    }

    @Test
    fun nothing_is_handed_over_while_no_phone_has_the_app() = outbox {
        link.reachable = false
        link.installed = false
        addRecording("a")
        addNote("n")
        assertTrue(core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED).isEmpty())
        assertTrue(link.items.isEmpty())
        assertEquals(setOf("a", "n"), refs())
    }

    @Test
    fun a_text_note_goes_live_to_a_reachable_phone_and_its_reply_releases_it() = outbox {
        val reply = CompletableDeferred<LinkReply>()
        link.respond = { _, _ -> reply.await() }
        addNote("n")
        assertEquals(setOf("n"), core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED))
        settle()
        assertEquals(WearDataLayer.NOTE_PATH, link.requests.single().first)
        assertEquals("n", (link.requests.single().second as TextNote).ref)
        // While the request is out the note is carried, not sent a second time.
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        settle()
        assertEquals(1, link.requests.size)
        reply.complete(link.reply(NoteAck.of(NoteOutcome.SAVED, "n")))
        settle()
        assertTrue(refs().isEmpty())
        assertTrue(link.items.isEmpty())
    }

    @Test
    fun any_reply_releases_the_note_even_a_refusal() = outbox {
        link.respond = { _, _ -> link.reply(NoteAck.of(NoteOutcome.REJECTED, "n")) }
        addNote("n")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        settle()
        assertTrue(refs().isEmpty())
    }

    @Test
    fun a_failed_live_note_is_queued_with_the_time_it_joined_the_outbox() = outbox {
        link.respond = { _, _ -> LinkReply.Failed(13) }
        addNote("n")
        val joined = now
        pass(5.seconds)
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        settle()
        val queued = link.item(queuedN) as QueuedRelay
        assertEquals("n", (queued.message as TextNote).ref)
        assertEquals(joined, queued.queuedAt)
        assertEquals(setOf("n"), refs())
    }

    @Test
    fun a_text_note_for_an_unreachable_phone_is_queued_at_once() = outbox {
        link.reachable = false
        addNote("n")
        assertEquals(setOf("n"), core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED))
        assertTrue(link.requests.isEmpty())
        assertTrue(link.item(queuedN) is QueuedRelay)
        // The queued item carries it, so reconnecting does not send it again.
        link.reachable = true
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        settle()
        assertTrue(link.requests.isEmpty())
    }

    @Test
    fun an_acknowledgement_for_a_queued_note_releases_it_and_deletes_its_item() = outbox {
        link.reachable = false
        addNote("n")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        fromPhone(NoteAck.of(NoteOutcome.SAVED, "n"), WearDataLayer.NOTE_PATH)
        assertTrue(refs().isEmpty())
        assertNull(link.item(queuedN))
    }

    @Test
    fun a_failed_put_is_counted_and_retried_after_its_backoff() = outbox {
        link.putsSucceed = false
        addRecording("a")
        assertTrue(core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED).isEmpty())
        val entry = core.store.entries().single()
        assertEquals(1, entry.failures)
        assertEquals(now + OutboxPolicy.backoff(1).inWholeMilliseconds, retries.last())

        link.putsSucceed = true
        // A retry before the backoff ends waits.
        pass(10.seconds)
        assertTrue(core.outbox.flush(Trigger.RETRY).isEmpty())
        pass(OutboxPolicy.backoff(1))
        assertEquals(setOf("a"), core.outbox.flush(Trigger.RETRY))
        // Carried now: the only pass left is the one that would drop it after a week.
        assertEquals(entry.queuedAt + OutboxPolicy.RETENTION.inWholeMilliseconds + 1, retries.last())
    }

    @Test
    fun with_no_phone_app_anywhere_nothing_is_handed_over_and_a_pass_stays_scheduled() = outbox {
        link.reachable = false
        link.installed = false
        addRecording("a")
        addNote("n")

        assertTrue(core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED).isEmpty())

        assertTrue(link.items.isEmpty())
        assertTrue(link.requests.isEmpty())
        assertEquals(setOf("a", "n"), refs())
        assertTrue("waiting for a phone app is not a failed delivery", core.store.entries().all { it.failures == 0 })
        assertEquals(now + OutboxPolicy.UNCARRIED_RECHECK.inWholeMilliseconds, retries.last())
    }

    @Test
    fun each_scheduled_pass_with_still_no_phone_app_schedules_the_next() = outbox {
        link.reachable = false
        link.installed = false
        addRecording("a")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)

        repeat(3) {
            pass(OutboxPolicy.UNCARRIED_RECHECK)
            core.retryOutbox()
            assertTrue(link.items.isEmpty())
            assertEquals(now + OutboxPolicy.UNCARRIED_RECHECK.inWholeMilliseconds, retries.last())
        }
    }

    @Test
    fun a_scheduled_pass_hands_over_to_a_phone_app_whose_arrival_was_never_announced() = outbox {
        link.reachable = false
        link.installed = false
        addRecording("a")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)

        // The phone app appears, and nothing tells the watch.
        link.reachable = true
        link.installed = true
        pass(OutboxPolicy.UNCARRIED_RECHECK)
        core.retryOutbox()

        assertTrue(link.items.containsKey(recordingA))
        assertEquals(listOf(WearDataLayer.VOICE_NUDGE_PATH), link.sent.map { it.first })
    }

    @Test
    fun a_note_waiting_for_a_phone_app_is_dropped_by_the_pass_scheduled_for_its_expiry() = outbox {
        link.reachable = false
        addRecording("a")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        val expiry = retries.last()
        assertEquals(now + OutboxPolicy.RETENTION.inWholeMilliseconds + 1, expiry)

        pass(OutboxPolicy.RETENTION + 1.seconds)
        core.retryOutbox()

        assertTrue(refs().isEmpty())
        assertEquals(1, core.store.droppedCount)
        assertNull("an empty outbox schedules nothing", retries.last())
    }

    @Test
    fun the_last_confirmation_cancels_the_scheduled_pass() = outbox {
        link.reachable = false
        addRecording("a")
        addNote("n")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)

        fromPhone(RecordingReceipt("a"), WearDataLayer.RECORDING_RECEIVED_PATH)
        assertTrue("one note still waits", retries.last() != null)
        fromPhone(NoteAck.of(NoteOutcome.SAVED, "n"), WearDataLayer.NOTE_PATH)

        assertTrue(refs().isEmpty())
        assertNull(retries.last())
    }

    @Test
    fun the_link_changing_sends_a_failed_entry_without_waiting_out_its_backoff() = outbox {
        link.putsSucceed = false
        addRecording("a")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        link.putsSucceed = true
        assertEquals(setOf("a"), core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED))
    }

    @Test
    fun a_note_that_waited_a_week_is_dropped_and_the_person_is_told() = outbox {
        link.reachable = false
        addRecording("a")
        addNote("n")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        pass(OutboxPolicy.RETENTION + 1.minutes)
        assertTrue(core.outbox.flush(Trigger.RETRY).isEmpty())
        assertTrue(refs().isEmpty())
        assertTrue(link.items.isEmpty())
        assertEquals(2, core.store.droppedCount)
        assertEquals(VoiceNoteState.Dropped(2), core.voiceNote.state.value)
    }

    @Test
    fun an_item_for_a_note_no_longer_waiting_is_deleted() = outbox {
        link.items[recordingA] = WearCodec.encode(VoiceRecording("a", captureTime(), "en-GB").toMetadata())
        link.items[queuedN] = WearCodec.encode(QueuedRelay(TextNote.of("Call the plumber", captureTime(), "n"), now))
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        assertTrue(link.items.isEmpty())
    }

    @Test
    fun a_queued_question_too_old_to_answer_is_left_for_the_phone_to_report() = outbox {
        val path = WearDataLayer.queuedPath("q")
        link.items[path] = WearCodec.encode(QueuedRelay(AskRequest("When does the pool open?", "q"), now))
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        assertTrue(link.items.containsKey(path))
        // Expired: the phone, not the watch, is the one that says so.
        pass(RelayQueue.ASK_EXPIRY + 1.seconds)
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        assertTrue(link.items.containsKey(path))
        // No phone took it for as long as the outbox keeps anything.
        pass(OutboxPolicy.RETENTION)
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        assertFalse(link.items.containsKey(path))
    }

    @Test
    fun the_newest_fifty_entries_are_kept_and_the_rest_dropped() = outbox {
        link.reachable = false
        repeat(OutboxPolicy.MAX_ENTRIES + 2) { index ->
            addNote("n$index")
            pass(1.seconds)
        }
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        assertEquals(OutboxPolicy.MAX_ENTRIES, refs().size)
        assertFalse("n0" in refs())
        assertFalse("n1" in refs())
        assertEquals(2, core.store.droppedCount)
    }

    @Test
    fun launch_and_a_link_change_each_run_the_outbox() = outbox {
        addRecording("a")
        core.launched()
        settle()
        assertTrue(link.items.containsKey(recordingA))
        addRecording("b")
        core.linkChanged()
        settle()
        assertTrue(link.items.containsKey(WearDataLayer.recordingPath("b")))
    }

    @Test
    fun a_scheduled_retry_runs_a_retry_pass() = outbox {
        link.putsSucceed = false
        addRecording("a")
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        link.putsSucceed = true
        pass(OutboxPolicy.backoff(1) + 1.seconds)
        core.retryOutbox()
        assertTrue(link.items.containsKey(recordingA))
    }

    @Test
    fun retention_is_measured_from_when_the_note_joined_the_outbox() = outbox {
        link.reachable = false
        addNote("old")
        pass(6.days)
        addNote("new")
        pass(2.days)
        core.outbox.flush(Trigger.LINK_MAY_HAVE_CHANGED)
        assertEquals(setOf("new"), refs())
    }
}
