// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.AskActivitySnapshot
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskProgress
import dev.omnesis.android.wearprotocol.CaptureAnswer
import dev.omnesis.android.wearprotocol.CaptureButtons
import dev.omnesis.android.wearprotocol.CaptureDeferred
import dev.omnesis.android.wearprotocol.CaptureDismissal
import dev.omnesis.android.wearprotocol.CaptureLaunchRequests
import dev.omnesis.android.wearprotocol.CapturePatience
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.CaptureRouteUpdate
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.DisplayedReceipt
import dev.omnesis.android.wearprotocol.RecordingFormat
import dev.omnesis.android.wearprotocol.RecordingMetadata
import dev.omnesis.android.wearprotocol.VoiceKind
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.WearLine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

@OptIn(ExperimentalCoroutinesApi::class)
class CaptureFlowTest {
    private fun capture(body: suspend WatchHarness.() -> Unit) = runTest {
        val harness = WatchHarness(this)
        try {
            harness.body()
        } finally {
            // The level meter runs for as long as the microphone is open.
            harness.core.capture.cancel()
            harness.cleanUp()
        }
    }

    /** Open the recorder and let it reach the microphone. */
    private fun WatchHarness.record(followUp: Boolean = false, fromSurface: Boolean = false) {
        core.capture.start(followUp = followUp, fromSurface = fromSurface)
        settle()
    }

    private fun WatchHarness.sentRecording(): RecordingMetadata =
        link.items.keys.single { it.startsWith(WearDataLayer.RECORDING_PATH_PREFIX) }
            .let { link.item(it) as RecordingMetadata }

    private fun WatchHarness.state(): CaptureState = core.capture.state.value

    // Which buttons, for every gate the phone can have published.

    @Test
    fun the_buttons_follow_the_gate_and_whether_the_recording_follows_up() = capture {
        data class Case(val gate: DictationGate?, val followUp: Boolean, val expected: CaptureButtons)
        val fresh = now
        val stale = now - 8.days.inWholeMilliseconds
        fun gate(captureSupported: Boolean, decisionGate: Boolean, updatedAt: Long = fresh) =
            DictationGate(false, 0, updatedAt, decisionGate = decisionGate, captureSupported = captureSupported)
        val cases = listOf(
            Case(null, false, CaptureButtons.UNSUPPORTED),
            Case(null, true, CaptureButtons.UNSUPPORTED),
            Case(gate(captureSupported = false, decisionGate = true), false, CaptureButtons.UNSUPPORTED),
            Case(gate(captureSupported = true, decisionGate = false), false, CaptureButtons.ASK_AND_TELL),
            Case(gate(captureSupported = true, decisionGate = true), false, CaptureButtons.SEND),
            Case(gate(captureSupported = true, decisionGate = true, updatedAt = stale), false, CaptureButtons.ASK_AND_TELL),
            Case(gate(captureSupported = true, decisionGate = true), true, CaptureButtons.ASK_ONLY),
            Case(gate(captureSupported = true, decisionGate = false), true, CaptureButtons.ASK_ONLY),
        )
        for (case in cases) {
            // Each case gets its own watch, so a cached gate cannot stand in for the one under test.
            val watch = WatchHarness(test)
            watch.link.gate = case.gate
            watch.core.capture.start(followUp = case.followUp)
            watch.settle()
            val shown = watch.core.capture.state.value
            assertEquals("$case", case.expected, shown.buttons)
            val recording = case.expected != CaptureButtons.UNSUPPORTED
            assertEquals("$case", if (recording) CapturePhase.Recording else CapturePhase.Failed, shown.phase)
            watch.core.capture.cancel()
            watch.cleanUp()
        }
    }

    @Test
    fun the_last_gate_seen_is_used_when_the_data_layer_cannot_be_read_and_survives_a_restart() = capture {
        publishGate(decisionGate = true)
        record()
        assertEquals(CaptureButtons.SEND, state().buttons)
        core.capture.cancel()

        link.gate = null
        record()
        assertEquals(CaptureButtons.SEND, state().buttons)
        core.capture.cancel()

        val restarted = WatchHarness(test, storage)
        restarted.core.capture.start()
        restarted.settle()
        assertEquals(CaptureButtons.SEND, restarted.core.capture.state.value.buttons)
        restarted.core.capture.cancel()
    }

    @Test
    fun a_published_gate_is_cached_as_it_arrives() = capture {
        fromPhone(DictationGate(false, 0, now, decisionGate = true, captureSupported = true), WearDataLayer.GATE_PATH)
        record()
        assertEquals(CaptureButtons.SEND, state().buttons)
    }

    // Opening the microphone.

    @Test
    fun opening_shows_preparing_then_records_with_a_start_signal() = capture {
        publishGate()
        permission.prompt = CompletableDeferred()
        core.capture.start()
        settle()
        assertEquals(CapturePhase.Preparing, capturePhase)
        assertTrue(recorder.sessions.isEmpty())
        permission.prompt?.complete(true)
        settle()
        assertEquals(CapturePhase.Recording, capturePhase)
        assertEquals(listOf(WatchHaptic.START), haptics)
        assertEquals(RecordingFormat.MAX_DURATION, recorder.current.limit)
    }

    @Test
    fun a_gate_with_a_byte_limit_shortens_the_recording() = capture {
        // 30 000 bytes at 3 000 bytes a second, less the container's share.
        publishGate(active = true, maxAudioBytes = 30_000)
        record()
        assertEquals(9.seconds, recorder.current.limit)
    }

    @Test
    fun refusing_the_microphone_fails_without_recording() = capture {
        publishGate()
        permission.granted = false
        record()
        assertEquals(CapturePhase.Failed, capturePhase)
        assertTrue(recorder.sessions.isEmpty())
    }

    @Test
    fun a_microphone_that_cannot_be_opened_fails_and_leaves_no_file() = capture {
        publishGate()
        recorder.failsToOpen = true
        record()
        assertEquals(CapturePhase.Failed, capturePhase)
        assertTrue(core.store.entries().isEmpty())
        assertTrue(storage.resolve("outbox").list().orEmpty().isEmpty())
    }

    @Test
    fun try_again_after_a_failure_opens_the_recorder() = capture {
        record()
        assertEquals(CapturePhase.Failed, capturePhase)
        publishGate()
        record()
        assertEquals(CapturePhase.Recording, capturePhase)
    }

    @Test
    fun a_second_start_while_recording_is_ignored() = capture {
        publishGate()
        record()
        record()
        assertEquals(1, recorder.sessions.size)
    }

    @Test
    fun cancelling_while_the_permission_prompt_is_up_opens_nothing_when_it_is_answered() = capture {
        publishGate()
        permission.prompt = CompletableDeferred()
        core.capture.start()
        settle()
        core.capture.cancel()
        permission.prompt?.complete(true)
        settle()
        assertEquals(CapturePhase.Idle, capturePhase)
        assertTrue(recorder.sessions.isEmpty())
    }

    @Test
    fun the_halo_level_rises_with_the_voice_and_falls_back_slowly() = capture {
        publishGate()
        record()
        recorder.current.power = -15f
        pass(400.milliseconds)
        val loud = state().level
        assertTrue("level rose to $loud", loud > 0.5f)
        recorder.current.power = -60f
        pass(80.milliseconds)
        val after = state().level
        assertTrue("one quiet reading only eases the level down", after < loud && after > loud * 0.8f)
    }

    // Sending, by button and by what the phone decides.

    @Test
    fun ask_sends_the_recording_as_a_question_and_waits_for_the_answer() = capture {
        publishGate()
        record()
        core.capture.send(CaptureRoute.ASK)
        settle()
        assertEquals(CapturePhase.Sent(CaptureRoute.ASK), capturePhase)
        assertEquals(WearLine.WAITING_FOR_ANSWER.text, state().sentLine)
        assertEquals(listOf(WatchHaptic.START, WatchHaptic.SUCCESS), haptics)
        val sent = sentRecording()
        assertEquals(VoiceKind.CAPTURE, sent.voiceKind)
        assertEquals(CaptureRoute.ASK, sent.captureRoute)
        assertEquals("en-GB", sent.locale)
        assertNull(sent.conversationId)
        assertFalse("the microphone is closed", recorder.current.open)
        // Waiting for an answer never leaves the app.
        pass(CaptureDismissal.CONFIRMATION_DELAY * 3)
        assertTrue(effects.isEmpty())
    }

    @Test
    fun progress_for_the_sent_question_shows_under_got_it() = capture {
        publishGate()
        record()
        core.capture.send(CaptureRoute.ASK)
        settle()
        val ref = sentRecording().ref
        fromPhone(AskProgress.of(AskActivitySnapshot("Searching…", "12 found"), "another"), WearDataLayer.PROGRESS_PATH)
        assertEquals(WearLine.WAITING_FOR_ANSWER.text, state().sentLine)
        fromPhone(AskProgress.of(AskActivitySnapshot("Searching…", "12 found"), ref), WearDataLayer.PROGRESS_PATH)
        assertEquals("Searching…", state().sentLine)
    }

    @Test
    fun the_answer_to_a_recorded_question_is_shown_unspoken_and_acknowledged() = capture {
        publishGate()
        record()
        core.capture.send(CaptureRoute.ASK)
        settle()
        val ref = sentRecording().ref
        val answer = CaptureAnswer.of(AskOutcome.Answered("The dentist is at 3 pm on Thursday."), ref, conversationId = "c1")
        val reply = fromPhone(answer, WearDataLayer.CAPTURE_UPDATE_PATH, isRequest = true)
        assertEquals(DisplayedReceipt(displayed = true, ref = ref), reply)
        // Said on its own as well, for a phone that stopped waiting for the reply.
        assertEquals(listOf(WearDataLayer.DISPLAYED_PATH to DisplayedReceipt(true, ref)), link.sent.takeLast(1))
        assertEquals(CapturePhase.Idle, capturePhase)
        assertEquals(WatchScreen.ASK, core.screen.value)
        assertEquals(
            AskState.Answered("The dentist is at 3 pm on Thursday.", AskOutcome.Kind.ANSWER, WearLine.STATUS_STILL_WORKING.text),
            core.ask.state.value,
        )
        assertEquals("c1", core.ask.conversationId)
        assertEquals(WatchHaptic.NOTIFICATION, haptics.last())
        assertTrue("a recorded question's answer is not read aloud by itself", speech.spoken.isEmpty())
        assertEquals("The dentist is at 3 pm on Thursday.", core.speaker.state.value.text)
        // Speak answer reads it.
        core.speaker.replay()
        assertEquals("The dentist is at 3 pm on Thursday.", speech.spoken.single().first)
    }

    @Test
    fun an_answer_that_arrives_with_the_app_off_screen_is_reported_as_not_shown() = capture {
        publishGate()
        record()
        core.capture.send(CaptureRoute.ASK)
        settle()
        val ref = sentRecording().ref
        onScreen = false
        val reply = fromPhone(CaptureAnswer.of(AskOutcome.Answered("Bins go out tonight."), ref), isRequest = true)
        assertEquals(DisplayedReceipt(displayed = false, ref = ref), reply)
        // It is on the ask screen for when the app is next opened.
        assertTrue(core.ask.state.value is AskState.Answered)
    }

    @Test
    fun a_second_copy_of_the_answer_changes_nothing_and_reports_the_same() = capture {
        publishGate()
        record()
        core.capture.send(CaptureRoute.ASK)
        settle()
        val ref = sentRecording().ref
        val answer = CaptureAnswer.of(AskOutcome.Answered("Bins go out tonight."), ref)
        fromPhone(answer, isRequest = true)
        val signals = haptics.size
        val again = fromPhone(answer, isRequest = true)
        assertEquals(DisplayedReceipt(displayed = true, ref = ref), again)
        assertEquals(signals, haptics.size)
    }

    @Test
    fun an_answer_sent_as_a_plain_message_is_acknowledged_on_the_displayed_path() = capture {
        publishGate()
        record()
        core.capture.send(CaptureRoute.ASK)
        settle()
        val ref = sentRecording().ref
        link.sent.clear()
        assertNull(fromPhone(CaptureAnswer.of(AskOutcome.Answered("Bins go out tonight."), ref)))
        assertEquals(listOf(WearDataLayer.DISPLAYED_PATH to DisplayedReceipt(true, ref)), link.sent)
    }

    @Test
    fun an_answer_for_a_recording_this_screen_did_not_send_is_not_shown() = capture {
        publishGate()
        val reply = fromPhone(CaptureAnswer.of(AskOutcome.Answered("Stale"), "elsewhere"), isRequest = true)
        assertEquals(DisplayedReceipt(displayed = false, ref = "elsewhere"), reply)
        assertEquals(AskState.Idle, core.ask.state.value)
    }

    @Test
    fun a_failed_recorded_question_is_presented_as_a_failure() = capture {
        publishGate()
        record()
        core.capture.send(CaptureRoute.ASK)
        settle()
        fromPhone(CaptureAnswer.of(AskOutcome.Unreachable, sentRecording().ref), isRequest = true)
        val shown = core.ask.state.value as AskState.Answered
        assertEquals(AskOutcome.Kind.FAILURE, shown.kind)
        assertEquals(WearLine.UNREACHABLE.text, shown.text)
    }

    @Test
    fun tell_confirms_then_leaves_once_the_outbox_has_handed_the_note_over() = capture {
        publishGate()
        record()
        core.capture.send(CaptureRoute.NOTE)
        settle()
        assertEquals(CapturePhase.Sent(CaptureRoute.NOTE), capturePhase)
        assertEquals(WearLine.NOTE_ACCEPTED.text, state().sentLine)
        assertEquals(CaptureRoute.NOTE, sentRecording().captureRoute)
        pass(CaptureDismissal.CONFIRMATION_DELAY - 100.milliseconds)
        assertTrue("the confirmation is still being read", effects.isEmpty())
        pass(100.milliseconds)
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
    }

    @Test
    fun tell_stays_on_the_confirmation_when_nothing_carries_the_note_yet() = capture {
        publishGate()
        link.putsSucceed = false
        record()
        core.capture.send(CaptureRoute.NOTE)
        pass(CaptureDismissal.CONFIRMATION_DELAY * 2)
        assertEquals(CapturePhase.Sent(CaptureRoute.NOTE), capturePhase)
        assertTrue(effects.isEmpty())
        assertEquals("the note waits in the outbox", 1, core.store.entries().size)
    }

    @Test
    fun tell_does_not_leave_while_an_answer_is_being_read_aloud() = capture {
        publishGate()
        core.ask.answered(AskOutcome.Answered("Earlier answer."))
        record()
        core.capture.send(CaptureRoute.NOTE)
        settle()
        core.speaker.replay()
        pass(CaptureDismissal.CONFIRMATION_DELAY * 2)
        assertTrue(effects.isEmpty())
    }

    @Test
    fun done_on_the_confirmation_closes_the_recorder_and_cancels_leaving() = capture {
        publishGate()
        record()
        core.capture.send(CaptureRoute.NOTE)
        settle()
        core.capture.cancel()
        pass(CaptureDismissal.CONFIRMATION_DELAY * 2)
        assertEquals(CapturePhase.Idle, capturePhase)
        assertTrue(effects.isEmpty())
        assertEquals("the sent note stays in the outbox", 1, core.store.entries().size)
    }

    @Test
    fun send_waits_for_the_phone_to_decide_then_a_note_confirms_and_leaves() = capture {
        publishGate(decisionGate = true)
        record()
        core.capture.send(CaptureRoute.AUTOMATIC)
        settle()
        assertEquals(CapturePhase.Sent(CaptureRoute.AUTOMATIC), capturePhase)
        assertEquals(WearLine.WORKING_OUT_ROUTE.text, state().sentLine)
        val ref = sentRecording().ref
        assertEquals(CaptureRoute.AUTOMATIC, sentRecording().captureRoute)
        pass(CaptureDismissal.CONFIRMATION_DELAY * 2)
        assertTrue("undecided, the app stays", effects.isEmpty())

        fromPhone(CaptureRouteUpdate(ref, CaptureRoute.NOTE), WearDataLayer.CAPTURE_UPDATE_PATH)
        assertEquals(CapturePhase.Sent(CaptureRoute.NOTE), capturePhase)
        pass(CaptureDismissal.CONFIRMATION_DELAY)
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
    }

    @Test
    fun a_note_the_phone_decided_leaves_even_when_the_put_was_not_confirmed() = capture {
        publishGate(decisionGate = true)
        record()
        link.putsSucceed = false
        core.capture.send(CaptureRoute.AUTOMATIC)
        settle()
        val ref = core.store.entries().single().ref
        // The phone naming the route proves it has the audio.
        fromPhone(CaptureRouteUpdate(ref, CaptureRoute.NOTE))
        pass(CaptureDismissal.CONFIRMATION_DELAY)
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
    }

    @Test
    fun send_that_the_phone_decides_is_a_question_shows_progress_then_the_answer() = capture {
        publishGate(decisionGate = true)
        record()
        core.capture.send(CaptureRoute.AUTOMATIC)
        settle()
        val ref = sentRecording().ref
        fromPhone(CaptureRouteUpdate(ref, CaptureRoute.ASK))
        assertEquals(CapturePhase.Sent(CaptureRoute.ASK), capturePhase)
        assertEquals(WearLine.WAITING_FOR_ANSWER.text, state().sentLine)
        fromPhone(AskProgress.of(AskActivitySnapshot("Reading…", "3 read"), ref))
        assertEquals("Reading…", state().sentLine)
        fromPhone(CaptureAnswer.of(AskOutcome.Answered("The boiler service is booked for the 14th."), ref), isRequest = true)
        assertEquals(CapturePhase.Idle, capturePhase)
        assertEquals("The boiler service is booked for the 14th.", (core.ask.state.value as AskState.Answered).text)
        pass(CaptureDismissal.CONFIRMATION_DELAY * 2)
        assertTrue(effects.isEmpty())
    }

    // Not waiting on the phone for good.

    private fun WatchHarness.send(route: CaptureRoute): String {
        publishGate(decisionGate = route == CaptureRoute.AUTOMATIC)
        record()
        core.capture.send(route)
        settle()
        return sentRecording().ref
    }

    @Test
    fun a_phone_that_keeps_the_recording_for_later_ends_the_wait_and_the_app_leaves() = capture {
        val ref = send(CaptureRoute.AUTOMATIC)
        assertEquals(WearLine.WORKING_OUT_ROUTE.text, state().sentLine)

        fromPhone(CaptureDeferred("another"), WearDataLayer.CAPTURE_UPDATE_PATH)
        assertFalse(state().deferred)

        fromPhone(CaptureDeferred(ref), WearDataLayer.CAPTURE_UPDATE_PATH)
        assertTrue(state().deferred)
        assertEquals(WearLine.CAPTURE_DEFERRED.text, state().sentLine)
        assertEquals(WatchHaptic.NOTIFICATION, haptics.last())
        assertTrue(effects.isEmpty())
        pass(CaptureDismissal.CONFIRMATION_DELAY)
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
    }

    @Test
    fun a_recording_the_phone_says_nothing_about_stops_waiting_for_its_route() = capture {
        send(CaptureRoute.AUTOMATIC)

        pass(CapturePatience.ROUTE_WAIT - 1.seconds)
        assertFalse(state().deferred)
        assertEquals(WearLine.WORKING_OUT_ROUTE.text, state().sentLine)

        pass(1.seconds)
        assertTrue(state().deferred)
        assertEquals(WearLine.CAPTURE_DEFERRED.text, state().sentLine)
        // The DataItem carries the recording, so the app leaves once the line has been seen.
        pass(CaptureDismissal.CONFIRMATION_DELAY)
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
        assertEquals("the recording still waits for the phone", 1, core.store.entries().size)
    }

    @Test
    fun a_deferred_recording_nothing_carries_keeps_the_app_open() = capture {
        publishGate(decisionGate = true)
        record()
        link.putsSucceed = false
        core.capture.send(CaptureRoute.AUTOMATIC)
        settle()

        pass(CapturePatience.ROUTE_WAIT + CaptureDismissal.CONFIRMATION_DELAY)

        assertTrue(state().deferred)
        assertTrue("leaving could lose a recording only this process is retrying", effects.isEmpty())
    }

    @Test
    fun a_recorded_question_is_waited_on_for_as_long_as_its_turn_shows_signs_of_life() = capture {
        val ref = send(CaptureRoute.ASK)

        // Each step the phone reports starts the wait again.
        repeat(3) {
            pass(CapturePatience.ANSWER_WAIT - 1.seconds)
            fromPhone(AskProgress.of(AskActivitySnapshot("Searching…"), ref), WearDataLayer.PROGRESS_PATH)
            assertFalse(state().deferred)
        }

        pass(CapturePatience.ANSWER_WAIT)
        assertTrue(state().deferred)
        assertEquals(WearLine.CAPTURE_DEFERRED.text, state().sentLine)
    }

    @Test
    fun a_route_decided_after_the_wait_ran_out_is_still_shown() = capture {
        val ref = send(CaptureRoute.AUTOMATIC)
        // Keep the app open through the deferral, as with something else still in flight.
        link.putsSucceed = false
        pass(CapturePatience.ROUTE_WAIT)
        assertTrue(state().deferred)

        fromPhone(CaptureRouteUpdate(ref, CaptureRoute.ASK))
        assertFalse(state().deferred)
        assertEquals(WearLine.WAITING_FOR_ANSWER.text, state().sentLine)

        fromPhone(CaptureAnswer.of(AskOutcome.Answered("The boiler service is booked for the 14th."), ref), isRequest = true)
        assertEquals("The boiler service is booked for the 14th.", (core.ask.state.value as AskState.Answered).text)
    }

    @Test
    fun an_answer_that_arrives_after_the_wait_ran_out_is_still_shown() = capture {
        val ref = send(CaptureRoute.ASK)
        pass(CapturePatience.ANSWER_WAIT)
        assertTrue(state().deferred)

        val reply = fromPhone(CaptureAnswer.of(AskOutcome.Answered("Thursday at 3 pm."), ref), isRequest = true)

        assertEquals(DisplayedReceipt(displayed = true, ref = ref), reply)
        assertEquals("Thursday at 3 pm.", (core.ask.state.value as AskState.Answered).text)
    }

    @Test
    fun a_note_waits_for_nothing() = capture {
        send(CaptureRoute.NOTE)
        pass(CapturePatience.ANSWER_WAIT * 2)
        assertFalse(state().deferred)
        assertEquals(WearLine.NOTE_ACCEPTED.text, state().sentLine)
    }

    @Test
    fun a_route_update_for_another_recording_is_ignored() = capture {
        publishGate(decisionGate = true)
        record()
        core.capture.send(CaptureRoute.AUTOMATIC)
        settle()
        fromPhone(CaptureRouteUpdate("another", CaptureRoute.NOTE))
        assertEquals(CapturePhase.Sent(CaptureRoute.AUTOMATIC), capturePhase)
    }

    @Test
    fun a_recording_that_cannot_be_kept_fails_with_the_failure_signal() = capture {
        publishGate()
        record()
        // An empty file is not a recording the outbox will take.
        recorder.current.file.writeBytes(ByteArray(0))
        core.capture.send(CaptureRoute.NOTE)
        settle()
        assertEquals(CapturePhase.Failed, capturePhase)
        assertEquals(WatchHaptic.FAILURE, haptics.last())
        assertTrue(core.store.entries().isEmpty())
    }

    @Test
    fun a_recorder_that_ends_badly_fails_and_deletes_the_file() = capture {
        publishGate()
        record()
        recorder.current.stopsCleanly = false
        val file = recorder.current.file
        core.capture.send(CaptureRoute.ASK)
        settle()
        assertEquals(CapturePhase.Failed, capturePhase)
        assertFalse(file.exists())
    }

    // The microphone stopping by itself never sends.

    @Test
    fun the_time_limit_stops_into_ready_to_send_and_sends_only_on_a_press() = capture {
        publishGate()
        record()
        recorder.current.reachLimit()
        settle()
        assertEquals(CapturePhase.Ready, capturePhase)
        pass(30.seconds)
        assertTrue("nothing was sent without a press", core.store.entries().isEmpty())
        core.capture.send(CaptureRoute.ASK)
        settle()
        assertEquals(CapturePhase.Sent(CaptureRoute.ASK), capturePhase)
        assertEquals(1, core.store.entries().size)
    }

    @Test
    fun leaving_the_screen_while_recording_stops_into_ready_to_send() = capture {
        publishGate()
        record()
        core.enteredBackground()
        settle()
        assertEquals(CapturePhase.Ready, capturePhase)
        assertFalse(recorder.current.open)
        assertTrue(core.store.entries().isEmpty())
        assertTrue(recorder.current.file.exists())
    }

    @Test
    fun an_interruption_stops_into_ready_to_send() = capture {
        publishGate()
        record()
        recorder.current.interrupt()
        settle()
        assertEquals(CapturePhase.Ready, capturePhase)
        assertTrue(core.store.entries().isEmpty())
    }

    @Test
    fun leaving_the_screen_while_the_microphone_is_opening_closes_the_recorder() = capture {
        publishGate()
        permission.prompt = CompletableDeferred()
        core.capture.start()
        settle()
        core.enteredBackground()
        assertEquals(CapturePhase.Idle, capturePhase)
    }

    // Cancel, by where the recorder was opened from.

    @Test
    fun cancel_from_a_tile_or_complication_launch_discards_and_leaves() = capture {
        publishGate()
        record(fromSurface = true)
        val file = recorder.current.file
        core.capture.cancelByUser()
        settle()
        assertEquals(CapturePhase.Idle, capturePhase)
        assertFalse(file.exists())
        assertFalse(recorder.current.open)
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
    }

    @Test
    fun cancel_from_inside_the_app_discards_and_stays() = capture {
        publishGate()
        record(fromSurface = false)
        core.capture.cancelByUser()
        settle()
        assertEquals(CapturePhase.Idle, capturePhase)
        assertTrue(effects.isEmpty())
    }

    @Test
    fun cancel_from_a_surface_launch_hands_over_older_waiting_notes_before_leaving() = capture {
        publishGate()
        link.putsSucceed = false
        record()
        core.capture.send(CaptureRoute.NOTE)
        settle()
        core.capture.cancel()
        link.putsSucceed = true
        record(fromSurface = true)
        core.capture.cancelByUser()
        settle()
        assertEquals(1, link.items.size)
    }

    @Test
    fun cancelling_a_ready_recording_deletes_it() = capture {
        publishGate()
        record()
        recorder.current.reachLimit()
        val file = recorder.current.file
        core.capture.cancelByUser()
        assertFalse(file.exists())
        assertTrue(core.store.entries().isEmpty())
    }

    // Follow-ups.

    @Test
    fun a_follow_up_keeps_the_answer_under_it_and_resumes_its_conversation() = capture {
        publishGate(decisionGate = true)
        core.ask.answered(AskOutcome.Answered("The ferry leaves at 09:40."), conversationId = "conv-9")
        record(followUp = true)
        assertEquals(CaptureButtons.ASK_ONLY, state().buttons)
        assertTrue("the answer stays under the recorder", core.ask.state.value is AskState.Answered)
        core.capture.send(CaptureRoute.ASK)
        settle()
        assertEquals("conv-9", sentRecording().conversationId)
    }

    @Test
    fun cancelling_a_follow_up_opened_from_a_surface_launch_stays_in_the_app() = capture {
        publishGate()
        core.ask.answered(AskOutcome.Answered("The ferry leaves at 09:40."), conversationId = "conv-9")
        record(followUp = true, fromSurface = true)
        core.capture.cancelByUser()
        settle()
        assertTrue(effects.isEmpty())
        assertTrue(core.ask.state.value is AskState.Answered)
    }

    @Test
    fun a_new_recording_that_is_not_a_follow_up_clears_the_previous_answer() = capture {
        publishGate()
        core.ask.answered(AskOutcome.Answered("The ferry leaves at 09:40."), conversationId = "conv-9")
        record()
        assertEquals(AskState.Idle, core.ask.state.value)
        core.capture.send(CaptureRoute.ASK)
        settle()
        assertNull(sentRecording().conversationId)
    }

    // The speaker and the microphone never overlap.

    @Test
    fun opening_the_recorder_stops_an_answer_being_read_aloud() = capture {
        publishGate()
        core.ask.answered(AskOutcome.Answered("A long answer."))
        core.speaker.replay()
        assertTrue(core.speaker.isSpeaking)
        record(followUp = true)
        assertFalse(core.speaker.isSpeaking)
    }

    @Test
    fun nothing_is_spoken_while_the_microphone_is_open() = capture {
        publishGate()
        record()
        core.speaker.speak("An answer that arrived mid-recording.")
        assertTrue(speech.spoken.isEmpty())
        assertFalse(core.speaker.isSpeaking)
        // It is kept, fully marked as read, for Speak answer.
        assertEquals("An answer that arrived mid-recording.", core.speaker.state.value.text)
    }

    // Launches from the tile and the complication.

    @Test
    fun a_surface_request_opens_the_recorder_once_the_screen_consumes_it() = capture {
        publishGate()
        core.requestCapture()
        core.requestCapture()
        assertEquals(2, core.launchRequests.value)
        assertEquals(CapturePhase.Idle, capturePhase)
        core.openRequestedCapture()
        settle()
        assertEquals(CapturePhase.Recording, capturePhase)
        assertTrue(state().fromSurface)
        // The burst opened one recorder; consuming again opens nothing.
        core.capture.cancel()
        core.openRequestedCapture()
        settle()
        assertEquals(CapturePhase.Idle, capturePhase)
    }

    @Test
    fun a_surface_request_the_screen_reaches_too_late_is_not_acted_on() = capture {
        publishGate()
        core.requestCapture()
        pass(CaptureLaunchRequests.FRESHNESS_WINDOW + 1.seconds)
        core.openRequestedCapture()
        settle()
        assertEquals(CapturePhase.Idle, capturePhase)
    }

    @Test
    fun opening_the_app_from_the_launcher_opens_no_recorder() = capture {
        publishGate()
        core.openRequestedCapture()
        settle()
        assertEquals(CapturePhase.Idle, capturePhase)
    }
}
