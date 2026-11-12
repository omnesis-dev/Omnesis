// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskProgress
import dev.omnesis.android.wearprotocol.CaptureAnswer
import dev.omnesis.android.wearprotocol.CaptureDeferred
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.CaptureRouteUpdate
import dev.omnesis.android.wearprotocol.DisplayedReceipt
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.OutboxPolicy
import dev.omnesis.android.wearprotocol.RecordingInboxPolicy
import dev.omnesis.android.wearprotocol.RecordingMetadata
import dev.omnesis.android.wearprotocol.RecordingReceipt
import dev.omnesis.android.wearprotocol.RelayPatience
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.VoiceKind
import dev.omnesis.android.wearprotocol.VoiceRecording
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.WearLine
import java.io.File
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The recording pipeline's whole matrix, over the real inbox on disk and fakes for everything it calls. */
@OptIn(ExperimentalCoroutinesApi::class)
class RecordingPipelineTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val gateway = FakeWearGateway()
    private val backend = FakeBackend()
    private val transcriber = FakeTranscriber()
    private val notes = FakeNotes()
    private val asker = FakeAsker()
    private val notifier = FakeNotifier()
    private val scheduler = FakeScheduler()
    private var now = CAPTURED_AT + 5_000
    private val audio = byteArrayOf(1, 2, 3, 4)
    private val ref = "5f0c3b1e-8a47-4f6e-9d2b-7c1a2e3f4b5d"
    private val path = WearDataLayer.recordingPath(ref)

    private fun inbox() = RecordingInbox(File(folder.root, "inbox")) { now }

    /** A pipeline as a fresh process would build it: nothing owned, everything on disk kept. */
    private fun pipeline(inbox: RecordingInbox = inbox()) =
        RecordingPipeline(inbox, gateway, backend, transcriber, notes, asker, notifier, scheduler) { now }

    private fun metadata(
        route: CaptureRoute? = CaptureRoute.AUTOMATIC,
        conversationId: String? = null,
        ref: String = this.ref,
    ) = VoiceRecording(ref, CAPTURE_TIME, "en_GB", route, conversationId).toMetadata()

    private fun item(
        metadata: RecordingMetadata? = metadata(),
        path: String = this.path,
        copy: (suspend (File) -> Boolean)? = { file -> file.writeBytes(audio); true },
    ) = WearItem(path, WATCH, metadata, copy)

    private val receipt = Sent.Message(WATCH, WearDataLayer.RECORDING_RECEIVED_PATH, RecordingReceipt(ref))
    private val deleted = Sent.Deleted(path, WATCH)
    private fun routed(route: CaptureRoute) =
        Sent.Message(WATCH, WearDataLayer.CAPTURE_UPDATE_PATH, CaptureRouteUpdate(ref, route))

    private fun answers() = gateway.requests.map { it.message as CaptureAnswer }

    private fun displays(shown: Boolean) {
        gateway.reply = { DisplayedReceipt(shown, ref) }
    }

    // Tell.

    @Test
    fun a_note_recording_goes_to_the_gateway_as_audio_when_it_transcribes() = runTest {
        backend.gatewayDictation = true

        pipeline().onItem(item(metadata(route = null)))

        assertEquals("", notes.saved.single().text)
        assertEquals(CAPTURE_TIME, notes.saved.single().captureTime)
        assertEquals(ref, notes.saved.single().ref)
        assertArrayEquals(audio, notes.saved.single().audio)
        assertTrue("nothing is transcribed on the way", backend.transcribed.isEmpty() && transcriber.heard.isEmpty())
        // A recording from the note screen has no route to report.
        assertEquals(listOf(receipt, deleted), gateway.sent)
        assertEquals(0, inbox().count())
    }

    @Test
    fun a_capture_sent_with_tell_is_a_voice_note_too_and_the_watch_is_told_it_is_a_note() = runTest {
        backend.gatewayDictation = true

        pipeline().onItem(item(metadata(route = CaptureRoute.NOTE)))

        assertEquals("", notes.saved.single().text)
        assertArrayEquals(audio, notes.saved.single().audio)
        assertEquals(listOf(receipt, deleted, routed(CaptureRoute.NOTE)), gateway.sent)
    }

    @Test
    fun without_gateway_dictation_a_note_is_transcribed_on_the_phone_and_saved_as_text() = runTest {
        pipeline().onItem(item(metadata(route = CaptureRoute.NOTE)))

        assertEquals(listOf("en_GB"), transcriber.heard)
        assertTrue(backend.transcribed.isEmpty())
        assertEquals(listOf(SavedNote("Remember the blue folder", CAPTURE_TIME, ref, null)), notes.saved)
        assertTrue("an explicit route is never classified", backend.classified.isEmpty())
        assertEquals(listOf(receipt, deleted, routed(CaptureRoute.NOTE)), gateway.sent)
    }

    @Test
    fun a_note_screen_recording_without_gateway_dictation_is_a_text_note() = runTest {
        pipeline().onItem(item(metadata(route = null)))

        assertEquals(listOf(SavedNote("Remember the blue folder", CAPTURE_TIME, ref, null)), notes.saved)
        assertEquals(listOf(receipt, deleted), gateway.sent)
    }

    // Ask.

    @Test
    fun an_ask_is_transcribed_by_the_gateway_asked_and_marked_seen_when_the_watch_shows_it() = runTest {
        backend.gatewayDictation = true
        asker.activity = listOf(AskActivityEvent.AgentStarted)
        displays(true)

        pipeline().onItem(item(metadata(route = CaptureRoute.ASK, conversationId = "conversation-0")))

        assertEquals(listOf<String?>("en_GB"), backend.transcribed)
        assertEquals(listOf(Asked("capture", "When is the budget review", "conversation-0")), asker.asked)
        assertEquals(
            listOf(
                receipt,
                deleted,
                routed(CaptureRoute.ASK),
                Sent.Message(WATCH, WearDataLayer.PROGRESS_PATH, AskProgress(WearLine.THINKING.text, null, ref)),
                Sent.Request(
                    WATCH,
                    WearDataLayer.CAPTURE_UPDATE_PATH,
                    CaptureAnswer(ref, "answered", "Tuesday at ten", "conversation-1", "message-1"),
                ),
            ),
            gateway.sent,
        )
        assertEquals(listOf("conversation-1" to "message-1"), backend.seen)
        assertTrue(notifier.posted.isEmpty())
        assertTrue(notes.saved.isEmpty())
    }

    @Test
    fun an_answer_the_watch_did_not_show_is_left_to_the_gateway_to_announce() = runTest {
        displays(false)

        pipeline().onItem(item(metadata(route = CaptureRoute.ASK)))

        assertEquals(1, answers().size)
        assertTrue(backend.seen.isEmpty())
        assertTrue("the gateway announces a capture's answer", notifier.posted.isEmpty())
    }

    @Test
    fun a_watch_that_never_replies_is_treated_as_not_shown_after_the_patience() = runTest {
        gateway.reply = null

        pipeline().onItem(item(metadata(route = CaptureRoute.ASK)))

        assertEquals(RelayPatience.DISPLAYED_REPLY_TIMEOUT.inWholeMilliseconds, currentTime)
        assertTrue(backend.seen.isEmpty())
        assertEquals(0, inbox().count())
    }

    @Test
    fun a_display_receipt_arriving_after_the_patience_still_marks_the_answer_seen() = runTest {
        gateway.reply = null
        val pipeline = pipeline()
        pipeline.onItem(item(metadata(route = CaptureRoute.ASK)))

        pipeline.onDisplayed(DisplayedReceipt(true, ref))
        pipeline.onDisplayed(DisplayedReceipt(true, ref))

        assertEquals(listOf("conversation-1" to "message-1"), backend.seen)
    }

    @Test
    fun an_ask_that_fails_is_notified_by_the_phone_when_the_watch_does_not_show_it() = runTest {
        asker.run = AskRun(AskOutcome.Unreachable, notifyLocally = true)
        displays(false)

        pipeline().onItem(item(metadata(route = CaptureRoute.ASK)))

        assertEquals(CaptureAnswer(ref, "unreachable"), answers().single())
        assertEquals(
            listOf(RelayNotice("Couldn't ask your watch question", WearLine.UNREACHABLE.text)),
            notifier.posted,
        )
        assertTrue("an asked question is finished with, however it ended", inbox().wasCompleted(ref))
    }

    @Test
    fun a_failure_the_watch_showed_needs_no_notification() = runTest {
        asker.run = AskRun(AskOutcome.Unreachable, notifyLocally = true)
        displays(true)

        pipeline().onItem(item(metadata(route = CaptureRoute.ASK)))

        assertTrue(notifier.posted.isEmpty())
        assertTrue("only an answer is marked seen", backend.seen.isEmpty())
    }

    @Test
    fun a_gateway_without_completion_notifications_gets_the_hand_off_and_a_local_notice() = runTest {
        backend.completionNotifications = false
        asker.run = AskRun(AskOutcome.Answered("Tuesday at ten"), "conversation-1", "message-1")
        displays(false)

        pipeline().onItem(item(metadata(route = CaptureRoute.ASK, conversationId = "conversation-0")))

        assertEquals(listOf(Asked("handOff", "Remember the blue folder", "conversation-0")), asker.asked)
        // No message is named: this gateway keeps no read state for a watch answer.
        assertEquals(CaptureAnswer(ref, "answered", "Tuesday at ten", "conversation-1"), answers().single())
        assertEquals(listOf(RelayNotice("Answer ready", "Tuesday at ten", "conversation-1")), notifier.posted)
        assertTrue(gateway.messagesOn(WearDataLayer.PROGRESS_PATH).isEmpty())
    }

    // Send.

    @Test
    fun an_automatic_capture_classified_as_a_note_is_saved() = runTest {
        backend.route = CaptureRoute.NOTE

        pipeline().onItem(item())

        assertEquals(listOf("Remember the blue folder"), backend.classified)
        assertEquals(listOf(SavedNote("Remember the blue folder", CAPTURE_TIME, ref, null)), notes.saved)
        assertTrue(asker.asked.isEmpty())
        assertEquals(listOf(receipt, deleted, routed(CaptureRoute.NOTE)), gateway.sent)
    }

    @Test
    fun an_automatic_capture_classified_as_a_question_is_asked() = runTest {
        backend.route = CaptureRoute.ASK
        displays(true)

        pipeline().onItem(item())

        assertEquals(listOf(Asked("capture", "Remember the blue folder", null)), asker.asked)
        assertTrue(notes.saved.isEmpty())
        assertEquals(routed(CaptureRoute.ASK), gateway.messages[1])
        assertEquals(listOf("conversation-1" to "message-1"), backend.seen)
    }

    @Test
    fun a_classification_that_fails_keeps_the_recording_and_its_transcript_for_the_next_run() = runTest {
        backend.classifyFailure = IOException("gateway unreachable")

        pipeline().onItem(item())

        assertEquals(listOf(RelayNotice.captureDelayed), notifier.posted)
        assertEquals(1, scheduler.retries)
        assertEquals(1, inbox().count())
        assertTrue(notes.saved.isEmpty() && asker.asked.isEmpty())
        assertFalse("the watch is not told a route nobody decided", gateway.messages.any { it.message is CaptureRouteUpdate })

        backend.classifyFailure = null
        backend.route = CaptureRoute.NOTE
        pipeline().resume(retryKept = false)

        assertEquals(1, transcriber.heard.size)
        assertEquals("Remember the blue folder", notes.saved.single().text)
        assertEquals(0, inbox().count())
        assertEquals("the person is told once", 1, notifier.posted.size)
    }

    // Failure, retry and expiry.

    @Test
    fun a_recording_that_cannot_be_transcribed_is_kept_and_reported_once_however_often_it_is_retried() = runTest {
        transcriber.transcript = null

        pipeline().onItem(item(metadata(route = CaptureRoute.ASK)))
        repeat(RecordingInboxPolicy.MAX_ATTEMPTS + 2) { pipeline().resume(retryKept = false) }

        assertEquals(listOf(RelayNotice.captureDelayed), notifier.posted)
        assertEquals(RecordingInboxPolicy.MAX_ATTEMPTS + 3, scheduler.retries)
        assertEquals("a failure that is not a crash never uses up the recording", 1, inbox().count())
        // The watch is told once too, so it stops waiting for an answer.
        val deferred = Sent.Message(WATCH, WearDataLayer.CAPTURE_UPDATE_PATH, CaptureDeferred(ref))
        assertEquals(listOf(receipt, deleted, deferred), gateway.sent)

        transcriber.transcript = "When is the budget review"
        displays(true)
        pipeline().resume(retryKept = false)
        assertEquals(1, asker.asked.size)
        assertEquals(0, inbox().count())
    }

    @Test
    fun a_kept_recording_waits_for_a_retry_rather_than_run_again_whenever_the_relay_wakes() = runTest {
        transcriber.transcript = null
        val pipeline = pipeline()
        pipeline.onItem(item(metadata(route = CaptureRoute.NOTE)))
        assertEquals(1, transcriber.heard.size)

        // What a nudge from the watch, or any other event, makes the relay do, and the
        // same DataItem arriving again.
        repeat(3) { pipeline.resume(retryKept = false) }
        pipeline.onItem(item(metadata(route = CaptureRoute.NOTE)))
        assertEquals("not transcribed again for every event", 1, transcriber.heard.size)

        transcriber.transcript = "Remember the blue folder"
        pipeline.resume(retryKept = true)
        assertEquals(2, transcriber.heard.size)
        assertEquals(1, notes.saved.size)
        assertEquals(0, inbox().count())
    }

    @Test
    fun an_unreadable_gateway_status_keeps_the_recording() = runTest {
        backend.statusFailure = IOException("not paired")
        pipeline().onItem(item(metadata(route = CaptureRoute.NOTE)))

        assertEquals(1, inbox().count())
        assertEquals(listOf(RelayNotice.captureDelayed), notifier.posted)
        assertTrue(transcriber.heard.isEmpty())
    }

    @Test
    fun a_note_the_phone_could_not_keep_is_retried_and_one_the_gateway_refuses_is_reported() = runTest {
        notes.outcome = NoteOutcome.CAPTURE_FAILED
        pipeline().onItem(item(metadata(route = CaptureRoute.NOTE)))
        assertEquals(1, inbox().count())
        assertEquals(listOf(RelayNotice.captureDelayed), notifier.posted)

        notes.outcome = NoteOutcome.REJECTED
        pipeline().resume(retryKept = false)

        assertEquals(0, inbox().count())
        assertEquals(listOf(RelayNotice.captureDelayed, RelayNotice.voiceNoteFailed), notifier.posted)
        assertTrue(inbox().wasCompleted(ref))
    }

    @Test
    fun a_recording_a_week_old_is_removed_with_a_notice() = runTest {
        transcriber.transcript = null
        pipeline().onItem(item())

        now = CAPTURED_AT + OutboxPolicy.RETENTION.inWholeMilliseconds + 1
        transcriber.transcript = "Remember the blue folder"
        pipeline().resume(retryKept = false)

        assertEquals(listOf(RelayNotice.captureDelayed, RelayNotice.captureExpired), notifier.posted)
        assertEquals(0, inbox().count())
        assertTrue(notes.saved.isEmpty() && asker.asked.isEmpty())
        assertTrue(inbox().wasCompleted(ref))
    }

    @Test
    fun a_question_whose_hand_off_the_process_did_not_survive_is_reported_and_never_asked_again() = runTest {
        val inbox = inbox()
        val admitted = inbox.admit(ref, metadata(route = CaptureRoute.ASK), WATCH) { it.writeBytes(audio); true }
        val owned = (admitted as RecordingInbox.Admission.Owned).item
        owned.state = owned.state.copy(attempts = 1, transcript = "When is the budget review", route = CaptureRoute.ASK, askStarted = true)
        inbox.save(owned)

        // The next process finds it.
        pipeline().resume(retryKept = false)

        assertTrue(asker.asked.isEmpty())
        assertEquals(listOf(RelayNotice.askInterrupted), notifier.posted)
        assertEquals(0, inbox().count())
        assertTrue(inbox().wasCompleted(ref))
    }

    @Test
    fun a_recording_whose_processing_keeps_ending_the_process_is_given_up() = runTest {
        val inbox = inbox()
        val admitted = inbox.admit(ref, metadata(route = null), WATCH) { it.writeBytes(audio); true }
        val owned = (admitted as RecordingInbox.Admission.Owned).item
        owned.state = owned.state.copy(attempts = RecordingInboxPolicy.MAX_ATTEMPTS)
        inbox.save(owned)

        pipeline().resume(retryKept = false)

        assertEquals(listOf(RelayNotice.voiceNoteFailed), notifier.posted)
        assertTrue(notes.saved.isEmpty())
        assertEquals(0, inbox().count())
    }

    // Delivery.

    @Test
    fun a_recording_whose_audio_could_not_be_copied_is_not_confirmed_so_the_watch_offers_it_again() = runTest {
        pipeline().onItem(item(copy = { false }))

        assertTrue(gateway.sent.isEmpty())
        assertEquals(0, inbox().count())

        backend.route = CaptureRoute.NOTE
        pipeline().onItem(item())
        assertEquals(1, notes.saved.size)
    }

    @Test
    fun a_copy_that_fails_by_throwing_is_a_copy_that_failed() = runTest {
        pipeline().onItem(item(copy = { throw IOException("asset unavailable") }))

        assertTrue(gateway.sent.isEmpty())
        assertEquals(0, inbox().count())
        assertTrue(notifier.posted.isEmpty())
    }

    @Test
    fun a_data_item_delivered_again_after_it_was_handled_is_confirmed_and_not_processed() = runTest {
        backend.route = CaptureRoute.NOTE
        val pipeline = pipeline()
        pipeline.onItem(item())
        gateway.sent.clear()

        pipeline.onItem(item())
        pipeline().onItem(item())

        assertEquals(1, notes.saved.size)
        assertEquals(listOf(receipt, deleted, receipt, deleted), gateway.sent)
    }

    @Test
    fun a_data_item_delivered_again_while_it_is_kept_for_retry_is_processed_from_where_it_stopped() = runTest {
        backend.classifyFailure = IOException("gateway unreachable")
        pipeline().onItem(item())
        backend.classifyFailure = null
        backend.route = CaptureRoute.NOTE

        // The copy is not taken again: the phone already holds the audio.
        pipeline().onItem(item(copy = { error("copied twice") }))

        assertEquals(1, transcriber.heard.size)
        assertEquals(1, notes.saved.size)
    }

    @Test
    fun an_item_the_phone_can_never_process_is_confirmed_so_the_watch_stops_offering_it() = runTest {
        val pipeline = pipeline()
        // Unreadable metadata, a capture without its route, a ref that is not a UUID.
        pipeline.onItem(item(metadata = null))
        pipeline.onItem(item(metadata().copy(captureRoute = null)))
        val named = WearDataLayer.recordingPath("not-a-uuid")
        pipeline.onItem(item(metadata(ref = "not-a-uuid"), path = named))

        assertEquals(
            listOf(
                receipt,
                deleted,
                receipt,
                deleted,
                Sent.Message(WATCH, WearDataLayer.RECORDING_RECEIVED_PATH, RecordingReceipt("not-a-uuid")),
                Sent.Deleted(named, WATCH),
            ),
            gateway.sent,
        )
        assertEquals(0, inbox().count())
        assertTrue(notifier.posted.isEmpty())
    }

    @Test
    fun a_path_that_names_no_recording_is_ignored() = runTest {
        pipeline().onItem(WearItem(WearDataLayer.queuedPath(ref), WATCH, TextNote.of("Buy oat milk", CAPTURE_TIME, ref)))
        assertTrue(gateway.sent.isEmpty())
    }

    @Test
    fun the_watch_metadata_decides_the_kind_of_recording() {
        assertEquals(VoiceKind.NOTE, metadata(route = null).voiceKind)
        assertEquals(VoiceKind.CAPTURE, metadata(route = CaptureRoute.AUTOMATIC).voiceKind)
    }
}
