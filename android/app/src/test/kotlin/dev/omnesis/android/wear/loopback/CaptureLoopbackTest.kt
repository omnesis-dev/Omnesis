// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.loopback

import dev.omnesis.android.wear.AskRun
import dev.omnesis.android.wear.Asked
import dev.omnesis.android.wear.RelayNotice
import dev.omnesis.android.wear.core.AskState
import dev.omnesis.android.wear.core.CapturePhase
import dev.omnesis.android.wear.core.WatchEffect
import dev.omnesis.android.wear.core.WatchHaptic
import dev.omnesis.android.wear.core.WatchScreen
import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.CaptureButtons
import dev.omnesis.android.wearprotocol.CaptureDismissal
import dev.omnesis.android.wearprotocol.CapturePatience
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.NoteCaptureTime
import dev.omnesis.android.wearprotocol.OutboxPolicy
import dev.omnesis.android.wearprotocol.RelayPatience
import dev.omnesis.android.wearprotocol.WearLine
import java.io.IOException
import java.time.ZoneId
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A recording from the unified recorder: Tell, Ask, and Send, which leaves the choice to the phone. */
class CaptureLoopbackTest {
    private val answer = AskRun(AskOutcome.Answered("Tuesday at ten."), "conversation-1", "message-1")
    private val spoken = "When is the budget review"

    private fun Loopback.answerShown(text: String = "Tuesday at ten.") {
        assertEquals(AskState.Answered(text, AskOutcome.Kind.ANSWER, WearLine.STATUS_STILL_WORKING.text), asked)
        assertEquals(WatchScreen.ASK, watch.core.screen.value)
        assertEquals(CapturePhase.Idle, recorder.phase)
    }

    // Tell.

    @Test
    fun tell_with_a_gateway_that_transcribes_uploads_the_recording_as_a_voice_note() = loopback {
        publishGate(dictationMaxAudioBytes = 4_000_000)
        backend.gatewayDictation = true
        val capturedAt = now

        record(CaptureRoute.NOTE)
        assertEquals(CapturePhase.Sent(CaptureRoute.NOTE), recorder.phase)
        assertEquals(WearLine.NOTE_ACCEPTED.text, recorder.sentLine)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)

        val saved = notes.saved.single()
        assertEquals("", saved.text)
        assertArrayEquals(byteArrayOf(1, 2, 3), saved.audio)
        assertEquals("en-GB", saved.locale)
        assertEquals(NoteCaptureTime.at(capturedAt, ZoneId.of("Europe/London")), saved.captureTime)
        assertTrue(backend.transcribed.isEmpty() && transcriber.heard.isEmpty() && backend.classified.isEmpty())
        assertEquals(WatchEffect.Leave, watch.effects.last())
        assertTrue(notifier.posted.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun tell_with_a_gateway_that_does_not_transcribe_is_transcribed_on_the_phone_and_saved_as_text() = loopback {
        publishGate()
        backend.gatewayDictation = false
        transcriber.transcript = "Remember the blue folder"

        record(CaptureRoute.NOTE)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)

        val saved = notes.saved.single()
        assertEquals("Remember the blue folder", saved.text)
        assertNull("a transcribed note carries no audio", saved.audio)
        // In the language the watch recorded it under.
        assertEquals(listOf<String?>("en-GB"), transcriber.heard)
        assertEquals(WatchEffect.Leave, watch.effects.last())
        assertNothingLeft()
    }

    // Ask.

    @Test
    fun ask_shows_the_turn_then_the_answer_and_the_phone_marks_it_seen() = loopback {
        publishGate()
        asker.run = answer
        asker.activity = listOf(AskActivityEvent.AgentStarted)
        asker.gate = CompletableDeferred()

        record(CaptureRoute.ASK)
        assertEquals(WearLine.WAITING_FOR_ANSWER.text, recorder.sentLine)
        pass(1.seconds)

        // The recording was transcribed on the phone and asked as a capture; the watch follows the turn.
        assertEquals(listOf(Asked("capture", "Remember the blue folder", null)), asker.asked)
        assertEquals(WearLine.THINKING.text, recorder.sentLine)

        asker.gate?.complete(Unit)
        pass()

        answerShown()
        assertEquals(WatchHaptic.NOTIFICATION, watch.haptics.last())
        assertTrue("a recorded question's answer is shown, not spoken unasked", watch.speech.spoken.isEmpty())
        assertEquals(listOf("conversation-1" to "message-1"), backend.seen)
        assertTrue(notifier.posted.isEmpty())
        assertTrue(notes.saved.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun an_answer_shown_after_the_phone_stopped_waiting_to_hear_is_still_marked_seen_once() = loopback {
        publishGate()
        asker.run = answer
        layer.watchReplyDelay = RelayPatience.DISPLAYED_REPLY_TIMEOUT + 1.seconds

        record(CaptureRoute.ASK)
        pass(6.seconds)

        answerShown()
        assertEquals(listOf("conversation-1" to "message-1"), backend.seen)
    }

    @Test
    fun an_answer_that_arrives_with_the_watch_screen_gone_is_not_marked_seen() = loopback {
        publishGate()
        asker.run = answer
        asker.gate = CompletableDeferred()
        record(CaptureRoute.ASK)
        pass(1.seconds)

        // The wrist goes down before the answer comes.
        watch.onScreen = false
        watch.core.enteredBackground()
        asker.gate?.complete(Unit)
        pass()

        // It waits on the ask screen for the next look, unspoken.
        answerShown()
        assertTrue(watch.speech.spoken.isEmpty())
        assertTrue(backend.seen.isEmpty())
        // This gateway announces every recorded question's answer itself, so the phone adds nothing.
        assertTrue(notifier.posted.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun on_a_gateway_that_does_not_announce_answers_the_phone_notifies_when_the_watch_did_not_show_one() = loopback {
        publishGate()
        backend.completionNotifications = false
        asker.run = answer
        watch.onScreen = false

        record(CaptureRoute.ASK)
        pass()

        assertEquals(listOf(Asked("handOff", "Remember the blue folder", null)), asker.asked)
        assertEquals(listOf(RelayNotice("Answer ready", "Tuesday at ten.", "conversation-1")), notifier.posted)
        assertTrue(backend.seen.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun on_a_gateway_that_does_not_announce_answers_an_answer_the_watch_showed_needs_no_notification() = loopback {
        publishGate()
        backend.completionNotifications = false
        asker.run = answer

        record(CaptureRoute.ASK)
        pass()

        answerShown()
        assertTrue(notifier.posted.isEmpty())
        // There is no announcement to withdraw, so nothing is marked seen.
        assertTrue(backend.seen.isEmpty())
    }

    // Send: the phone decides.

    @Test
    fun send_classified_as_a_note_is_saved_and_the_watch_confirms_and_leaves() = loopback {
        publishGate(decisionGate = true)
        backend.route = CaptureRoute.NOTE
        watch.core.capture.start()
        settle()
        assertEquals(CaptureButtons.SEND, recorder.buttons)

        watch.core.capture.send(CaptureRoute.AUTOMATIC)
        settle()
        assertEquals(WearLine.WORKING_OUT_ROUTE.text, recorder.sentLine)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)

        assertEquals(listOf("Remember the blue folder"), backend.classified)
        assertEquals("Remember the blue folder", notes.saved.single().text)
        assertEquals(CapturePhase.Sent(CaptureRoute.NOTE), recorder.phase)
        assertEquals(WearLine.NOTE_ACCEPTED.text, recorder.sentLine)
        assertEquals(WatchEffect.Leave, watch.effects.last())
        assertTrue(asker.asked.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun send_classified_as_a_question_is_asked_and_answered_on_the_watch() = loopback {
        publishGate(decisionGate = true)
        backend.route = CaptureRoute.ASK
        transcriber.transcript = spoken
        asker.run = answer

        record(CaptureRoute.AUTOMATIC)
        pass()

        assertEquals(listOf(Asked("capture", spoken, null)), asker.asked)
        answerShown()
        assertTrue(notes.saved.isEmpty())
        assertFalse("an answer keeps the app open", WatchEffect.Leave in watch.effects)
        assertNothingLeft()
    }

    @Test
    fun a_recording_the_phone_cannot_classify_is_kept_there_and_the_watch_stops_waiting_at_once() = loopback {
        publishGate(decisionGate = true)
        backend.classifyFailure = IOException("gateway unreachable")

        record(CaptureRoute.AUTOMATIC)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)

        // The phone keeps the recording, says so once, and will try again.
        assertEquals(listOf(RelayNotice.captureDelayed), notifier.posted)
        assertEquals(1, phone.relay.waitingRecordings())
        assertEquals(1, phone.retriesAsked)
        // The watch does not sit on "Working out what you need…": it says who has it now, and leaves.
        assertTrue(recorder.deferred)
        assertEquals(WearLine.CAPTURE_DEFERRED.text, recorder.sentLine)
        assertEquals(WatchHaptic.NOTIFICATION, watch.haptics.last())
        assertEquals(WatchEffect.Leave, watch.effects.last())
        // Its own copy is released: the phone owns the recording.
        assertEquals(emptyList<String>(), outbox())

        // Later the gateway is back and the retry decides it was a note.
        backend.classifyFailure = null
        backend.route = CaptureRoute.NOTE
        phone.runRetry()
        pass()

        assertEquals("Remember the blue folder", notes.saved.single().text)
        assertEquals(listOf("en-GB"), transcriber.heard.map { it })
        assertEquals("told once, and nothing more once it worked", 1, notifier.posted.size)
        assertNothingLeft()
    }

    @Test
    fun a_recording_classified_late_as_a_question_is_answered_wherever_the_watch_is_by_then() = loopback {
        publishGate(decisionGate = true)
        backend.classifyFailure = IOException("gateway unreachable")
        record(CaptureRoute.AUTOMATIC)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)
        assertTrue(recorder.deferred)

        backend.classifyFailure = null
        backend.route = CaptureRoute.ASK
        asker.run = answer
        phone.runRetry()
        pass()

        // The watch app is still on screen in this test, so the late answer is shown and marked seen.
        answerShown()
        assertEquals(listOf("conversation-1" to "message-1"), backend.seen)
        assertNothingLeft()
    }

    @Test
    fun a_recording_sent_with_the_phone_out_of_reach_stops_waiting_after_a_bounded_time() = loopback {
        publishGate(decisionGate = true)
        layer.disconnect()
        pass(1.seconds)

        record(CaptureRoute.AUTOMATIC)
        pass(CapturePatience.ROUTE_WAIT - 2.seconds)
        assertEquals(WearLine.WORKING_OUT_ROUTE.text, recorder.sentLine)

        pass(4.seconds + CaptureDismissal.CONFIRMATION_DELAY)
        assertEquals(WearLine.CAPTURE_DEFERRED.text, recorder.sentLine)
        // A DataItem carries the recording, so leaving loses nothing.
        assertEquals(WatchEffect.Leave, watch.effects.last())
        assertEquals(listOf(ref(1)), outbox())

        backend.route = CaptureRoute.NOTE
        layer.connect()
        pass()

        assertEquals(1, notes.saved.size)
        assertNothingLeft()
    }

    @Test
    fun a_recorded_question_nobody_answers_stops_waiting_too() = loopback {
        publishGate()
        layer.disconnect()
        pass(1.seconds)

        record(CaptureRoute.ASK)
        pass(CapturePatience.ANSWER_WAIT + 1.seconds)

        assertEquals(WearLine.CAPTURE_DEFERRED.text, recorder.sentLine)
    }

    // Follow-ups.

    @Test
    fun ask_again_after_an_answer_resumes_its_conversation() = loopback {
        publishGate()
        asker.run = answer
        typeQuestion("When is the budget review?")
        pass()

        watch.core.capture.start(followUp = true)
        settle()
        assertEquals(CaptureButtons.ASK_ONLY, recorder.buttons)
        watch.core.capture.send(CaptureRoute.ASK)
        pass()

        assertEquals(Asked("capture", "Remember the blue folder", "conversation-1"), asker.asked.last())
        answerShown()

        // And again, from the recorded answer.
        asker.run = answer.copy(conversationId = "conversation-1", messageId = "message-2")
        record(CaptureRoute.ASK, followUp = true)
        pass()
        assertEquals(3, asker.asked.size)
        assertEquals("conversation-1", asker.asked.last().resuming)
        assertNothingLeft()
    }

    @Test
    fun a_new_recording_after_an_answer_starts_a_new_conversation() = loopback {
        publishGate()
        asker.run = answer
        typeQuestion("When is the budget review?")
        pass()

        record(CaptureRoute.ASK)
        pass()

        assertNull(asker.asked.last().resuming)
    }

    // Duplicates, restarts, failure and expiry.

    @Test
    fun a_recording_delivered_twice_is_processed_once() = loopback {
        publishGate()
        record(CaptureRoute.NOTE)
        pass()
        assertEquals(1, notes.saved.size)

        phone.relay.onItem(layer.deliveredToPhone.last())
        pass()

        assertEquals(1, notes.saved.size)
        assertEquals(1, transcriber.heard.size)
        assertNothingLeft()
    }

    @Test
    fun a_phone_app_that_dies_mid_transcription_finishes_the_recording_once_when_it_restarts() = loopback {
        publishGate()
        transcriber.gate = CompletableDeferred()
        record(CaptureRoute.NOTE)
        pass(1.seconds)
        assertTrue(notes.saved.isEmpty())
        // The phone already owns the recording: the watch's copy is released.
        assertEquals(emptyList<String>(), outbox())

        transcriber.gate = null
        restartPhone()
        pass()

        assertEquals("Remember the blue folder", notes.saved.single().text)
        assertTrue(notifier.posted.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun a_phone_app_that_dies_mid_question_reports_it_and_never_asks_twice() = loopback {
        publishGate()
        asker.gate = CompletableDeferred()
        record(CaptureRoute.ASK)
        pass(1.seconds)
        assertEquals(1, asker.asked.size)

        asker.gate = null
        restartPhone()
        pass()

        // Whether the question arrived is unknown, so it is reported, not replayed.
        assertEquals(1, asker.asked.size)
        assertEquals(listOf(RelayNotice.askInterrupted), notifier.posted)
        assertEquals(0, phone.relay.waitingRecordings())

        // The watch, which will hear nothing more, stops waiting on its own.
        pass(CapturePatience.ANSWER_WAIT)
        assertEquals(WearLine.CAPTURE_DEFERRED.text, recorder.sentLine)
        assertNothingLeft()
    }

    @Test
    fun a_recording_that_cannot_be_transcribed_is_kept_for_retry_and_later_succeeds() = loopback {
        publishGate()
        transcriber.transcript = null

        record(CaptureRoute.NOTE)
        pass()
        phone.runRetry()
        pass()

        assertTrue(notes.saved.isEmpty())
        assertEquals(1, phone.relay.waitingRecordings())
        assertEquals("told once however often it is retried", listOf(RelayNotice.captureDelayed), notifier.posted)
        assertEquals(2, phone.retriesAsked)

        transcriber.transcript = "Remember the blue folder"
        phone.runRetry()
        pass()

        assertEquals("Remember the blue folder", notes.saved.single().text)
        assertEquals(1, notifier.posted.size)
        assertNothingLeft()
    }

    @Test
    fun a_recording_the_phone_could_not_process_for_a_week_is_removed_and_reported() = loopback {
        publishGate()
        transcriber.transcript = null
        record(CaptureRoute.NOTE)
        pass()

        sleepThrough(OutboxPolicy.RETENTION + 1.seconds)
        transcriber.transcript = "Remember the blue folder"
        phone.runRetry()
        pass()

        assertEquals(listOf(RelayNotice.captureDelayed, RelayNotice.captureExpired), notifier.posted)
        assertTrue("too old to file under the moment it was said", notes.saved.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun a_recording_no_phone_took_for_a_week_is_dropped_on_the_watch_and_the_person_is_told_there() = loopback {
        publishGate()
        layer.disconnect()
        pass(1.seconds)
        record(CaptureRoute.NOTE)
        pass(5.seconds)
        watch.core.capture.cancel()

        sleepThrough(OutboxPolicy.RETENTION + 1.seconds)
        watch.core.launched()
        pass()
        watch.core.screenAppeared()

        assertEquals(dev.omnesis.android.wear.core.VoiceNoteState.Dropped(1), watch.core.voiceNote.state.value)
        layer.connect()
        pass()
        assertTrue(notes.saved.isEmpty())
        assertNothingLeft()
    }
}
