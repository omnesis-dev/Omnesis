// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.core

import dev.omnesis.android.wearprotocol.AskActivity
import dev.omnesis.android.wearprotocol.AskActivitySnapshot
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskProgress
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.CaptureAnswer
import dev.omnesis.android.wearprotocol.CaptureDismissal
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.DisplayedReceipt
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.OutboxPolicy
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.RecordingMetadata
import dev.omnesis.android.wearprotocol.RelayPatience
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.VoiceKind
import dev.omnesis.android.wearprotocol.VoiceNudge
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.WearLine
import dev.omnesis.android.wearprotocol.WearMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/** The ask flow, the two note flows, and the routing of what the phone sends. */
@OptIn(ExperimentalCoroutinesApi::class)
class FlowsTest {
    private fun watch(body: suspend WatchHarness.() -> Unit) = runTest {
        val harness = WatchHarness(this)
        try {
            harness.body()
        } finally {
            harness.core.capture.cancel()
            harness.cleanUp()
        }
    }

    private fun WatchHarness.asking(): AskState.Asking = core.ask.state.value as AskState.Asking

    private fun answering(outcome: AskOutcome, conversationId: String? = null): suspend (String, WearMessage?) -> LinkReply =
        { _, message -> LinkReply.Reply(encode(AskResult.of(outcome, (message as AskRequest).ref, conversationId))) }

    private fun encode(message: WearMessage) = dev.omnesis.android.wearprotocol.WearCodec.encode(message)

    // Asking by text.

    @Test
    fun a_typed_question_is_relayed_shown_signalled_and_read_aloud() = watch {
        val reply = CompletableDeferred<LinkReply>()
        link.respond = { _, _ -> reply.await() }
        core.enterQuestion()
        settle()
        assertEquals(listOf<WatchEffect>(WatchEffect.RequestTextInput(TextInputPurpose.QUESTION)), effects)
        core.textEntered(TextInputPurpose.QUESTION, "  When is the school play?  ")
        settle()
        assertEquals("When is the school play?", asking().question)
        val sent = link.requests.single().second as AskRequest
        assertEquals("When is the school play?", sent.question)
        assertEquals(asking().ref, sent.ref)
        assertNull(sent.conversationId)

        reply.complete(link.reply(AskResult.of(AskOutcome.Answered("Friday at 6 pm, in the hall."), sent.ref, "conv-2")))
        settle()
        assertEquals(
            AskState.Answered("Friday at 6 pm, in the hall.", AskOutcome.Kind.ANSWER, WearLine.STATUS_STILL_WORKING.text),
            core.ask.state.value,
        )
        assertEquals("conv-2", core.ask.conversationId)
        assertEquals(listOf(WatchHaptic.SUCCESS), haptics)
        assertEquals("Friday at 6 pm, in the hall.", speech.spoken.single().first)
        assertTrue(core.speaker.isSpeaking)
    }

    @Test
    fun an_answer_that_lands_after_the_app_left_the_screen_is_kept_but_not_read_aloud() = watch {
        val reply = CompletableDeferred<LinkReply>()
        link.respond = { _, _ -> reply.await() }
        core.ask.submit("When is the school play?")
        settle()
        onScreen = false
        reply.complete(link.reply(AskResult.of(AskOutcome.Answered("Friday at 6 pm."), asking().ref)))
        settle()
        assertEquals("Friday at 6 pm.", (core.ask.state.value as AskState.Answered).text)
        assertEquals("the wrist still hears about it", listOf(WatchHaptic.SUCCESS), haptics)
        assertTrue(speech.spoken.isEmpty())
        // Speak answer reads it once the person is back.
        core.speaker.replay()
        assertEquals("Friday at 6 pm.", speech.spoken.single().first)
    }

    @Test
    fun leaving_the_app_stops_an_answer_being_read_aloud() = watch {
        link.respond = answering(AskOutcome.Answered("A long answer about the ferry timetable."))
        core.ask.submit("When does the ferry run?")
        settle()
        assertTrue(core.speaker.isSpeaking)
        core.enteredBackground()
        assertFalse(core.speaker.isSpeaking)
        assertTrue("the answer stays on screen", core.ask.state.value is AskState.Answered)
    }

    @Test
    fun nothing_entered_leaves_the_screen_as_it_was() = watch {
        core.textEntered(TextInputPurpose.QUESTION, "   ")
        core.textEntered(TextInputPurpose.NOTE, null)
        settle()
        assertEquals(AskState.Idle, core.ask.state.value)
        assertEquals(NoteState.Idle, core.note.state.value)
        assertTrue(link.requests.isEmpty())
    }

    @Test
    fun each_kind_of_outcome_has_its_own_signal_and_title() = watch {
        data class Case(val outcome: AskOutcome, val haptic: WatchHaptic, val kind: AskOutcome.Kind, val title: String)
        val stillWorking = WearLine.STATUS_STILL_WORKING.text
        val cases = listOf(
            Case(AskOutcome.Answered("Yes."), WatchHaptic.SUCCESS, AskOutcome.Kind.ANSWER, stillWorking),
            Case(AskOutcome.StillWorking, WatchHaptic.NOTIFICATION, AskOutcome.Kind.STATUS, stillWorking),
            Case(AskOutcome.PreviousTurnRunning, WatchHaptic.NOTIFICATION, AskOutcome.Kind.STATUS, stillWorking),
            Case(AskOutcome.EmptyAnswer, WatchHaptic.FAILURE, AskOutcome.Kind.FAILURE, stillWorking),
            Case(AskOutcome.Failed("The model is overloaded"), WatchHaptic.FAILURE, AskOutcome.Kind.FAILURE, stillWorking),
            Case(AskOutcome.NotPaired, WatchHaptic.FAILURE, AskOutcome.Kind.FAILURE, stillWorking),
            Case(AskOutcome.Unauthorized, WatchHaptic.FAILURE, AskOutcome.Kind.FAILURE, stillWorking),
            Case(AskOutcome.Unreachable, WatchHaptic.FAILURE, AskOutcome.Kind.FAILURE, stillWorking),
        )
        for (case in cases) {
            haptics.clear()
            link.respond = answering(case.outcome)
            core.ask.submit("Did the parcel arrive?")
            settle()
            val shown = core.ask.state.value as AskState.Answered
            assertEquals("$case", case.kind, shown.kind)
            assertEquals("$case", case.title, shown.statusTitle)
            assertEquals("$case", WearLine.forOutcome(case.outcome), shown.text)
            assertEquals("$case", listOf(case.haptic), haptics)
            assertEquals("$case", hapticFor(case.kind), case.haptic)
        }
    }

    @Test
    fun a_question_the_phone_never_takes_is_queued_and_says_so() = watch {
        link.reachable = false
        core.ask.submit("What time is the delivery?")
        settle()
        pass(4.seconds)
        assertEquals(AskActivitySnapshot(AskActivity.wakingPhoneLabel), core.ask.activity.value)
        pass(RelayPatience.DELIVERY_WINDOW + 15.seconds)
        val shown = core.ask.state.value as AskState.Answered
        assertEquals(AskOutcome.Kind.STATUS, shown.kind)
        assertEquals(WearLine.STATUS_QUEUED.text, shown.statusTitle)
        assertEquals(WearLine.QUEUED_FOR_PHONE.text, shown.text)
        assertEquals(listOf(WatchHaptic.NOTIFICATION), haptics)
        val queued = link.items.values.single().let { dev.omnesis.android.wearprotocol.WearCodec.decode(it) } as QueuedRelay
        assertEquals("What time is the delivery?", (queued.message as AskRequest).question)
        assertNull(core.ask.activity.value)
    }

    @Test
    fun progress_shows_only_for_the_question_being_asked() = watch {
        link.respond = { _, _ -> awaitCancellation() }
        core.ask.submit("Where did I park?")
        settle()
        val ref = asking().ref
        fromPhone(AskProgress.of(AskActivitySnapshot("Searching…", "4 found"), "earlier"), WearDataLayer.PROGRESS_PATH)
        assertNull(core.ask.activity.value)
        fromPhone(AskProgress.of(AskActivitySnapshot("Searching…", "4 found"), ref), WearDataLayer.PROGRESS_PATH)
        assertEquals("Searching… · 4 found", core.ask.activity.value?.line)
        // A label too long to be one is not shown; the previous step stays.
        fromPhone(AskProgress("x".repeat(60), ref = ref))
        assertEquals("Searching…", core.ask.activity.value?.label)
    }

    @Test
    fun the_backup_result_message_settles_the_wait() = watch {
        link.respond = { _, _ -> awaitCancellation() }
        core.ask.submit("Where did I park?")
        settle()
        fromPhone(AskResult.of(AskOutcome.Answered("Level 2, bay 14."), asking().ref), WearDataLayer.RESULT_PATH)
        assertEquals("Level 2, bay 14.", (core.ask.state.value as AskState.Answered).text)
    }

    @Test
    fun a_result_without_a_ref_or_for_another_question_is_ignored() = watch {
        link.respond = { _, _ -> awaitCancellation() }
        core.ask.submit("Where did I park?")
        settle()
        fromPhone(AskResult.of(AskOutcome.Answered("Unattributed"), null))
        fromPhone(AskResult.of(AskOutcome.Answered("Stale"), "earlier"))
        assertTrue(core.ask.state.value is AskState.Asking)
    }

    @Test
    fun a_newer_question_replaces_the_one_in_flight_and_its_late_answer_is_dropped() = watch {
        val first = CompletableDeferred<LinkReply>()
        link.respond = { _, message ->
            if ((message as AskRequest).question == "First?") first.await() else awaitCancellation()
        }
        core.ask.submit("First?")
        settle()
        val firstRef = asking().ref
        core.ask.submit("Second?")
        settle()
        first.complete(link.reply(AskResult.of(AskOutcome.Answered("Late"), firstRef)))
        fromPhone(AskResult.of(AskOutcome.Answered("Late"), firstRef))
        assertEquals("Second?", asking().question)
        assertTrue(haptics.isEmpty())
        assertTrue(speech.spoken.isEmpty())
    }

    @Test
    fun a_typed_question_closes_a_recorder_that_was_open() = watch {
        publishGate()
        core.capture.start()
        settle()
        val file = recorder.current.file
        core.ask.submit("Is the gym open?")
        assertEquals(CapturePhase.Idle, capturePhase)
        assertFalse(file.exists())
    }

    // Notes entered as text.

    @Test
    fun a_typed_note_is_kept_confirmed_and_handed_to_a_reachable_phone() = watch {
        link.respond = { _, message -> link.reply(NoteAck.of(NoteOutcome.SAVED, (message as TextNote).ref)) }
        core.textEntered(TextInputPurpose.NOTE, " Order more printer paper ")
        assertEquals(WatchScreen.NOTE, core.screen.value)
        assertEquals(NoteState.Sent("Order more printer paper"), core.note.state.value)
        assertEquals(VoiceNoteState.Sent(recorded = false), core.voiceNote.state.value)
        assertEquals(listOf(WatchHaptic.SUCCESS), haptics)
        settle()
        val sent = link.requests.single()
        assertEquals(WearDataLayer.NOTE_PATH, sent.first)
        val note = sent.second as TextNote
        assertEquals("Order more printer paper", note.text)
        assertEquals("Europe/London", note.capturedTimeZoneId)
        assertEquals(now, note.captureTime?.capturedAt)
        assertTrue("the phone's reply released it", core.store.entries().isEmpty())
    }

    @Test
    fun a_typed_note_leaves_for_the_watch_face_once_it_is_carried() = watch {
        link.respond = { _, _ -> awaitCancellation() }
        core.note.submit("Book the car in for its service")
        pass(CaptureDismissal.CONFIRMATION_DELAY - 100.milliseconds)
        assertTrue(effects.isEmpty())
        pass(100.milliseconds)
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
    }

    @Test
    fun a_typed_note_for_an_unreachable_phone_is_queued_and_still_counts_as_sent() = watch {
        link.reachable = false
        core.note.submit("Return the drill to Sam")
        settle()
        assertEquals(NoteState.Sent("Return the drill to Sam"), core.note.state.value)
        val queued = link.item(link.items.keys.single()) as QueuedRelay
        assertEquals("Return the drill to Sam", (queued.message as TextNote).text)
        assertEquals(1, core.store.entries().size)
        pass(CaptureDismissal.CONFIRMATION_DELAY)
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
    }

    @Test
    fun a_typed_note_nothing_carries_stays_on_screen_then_returns_to_the_note() = watch {
        link.reachable = false
        link.installed = false
        core.note.submit("Return the drill to Sam")
        pass(CaptureDismissal.CONFIRMATION_DELAY)
        assertTrue(effects.isEmpty())
        assertEquals(VoiceNoteState.Sent(recorded = false), core.voiceNote.state.value)
        pass(2.seconds)
        assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)
        assertEquals(NoteState.Sent("Return the drill to Sam"), core.note.state.value)
    }

    @Test
    fun a_note_that_cannot_be_kept_keeps_its_text_on_screen_with_the_failure_signal() = watch {
        // A file where the outbox directory should be makes every write fail.
        File(storage, "outbox").writeText("in the way")
        core.note.submit("Remember the umbrella")
        assertEquals(NoteState.Failed("Remember the umbrella"), core.note.state.value)
        assertEquals(listOf(WatchHaptic.FAILURE), haptics)
        assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)
    }

    // Notes recorded for the gateway.

    @Test
    fun new_note_records_while_the_gateway_transcribes() = watch {
        publishGate(active = true, maxAudioBytes = 2_000_000)
        core.dictateNote()
        settle()
        val state = core.voiceNote.state.value as VoiceNoteState.Recording
        assertEquals(WatchScreen.NOTE, core.screen.value)
        assertEquals(now, state.startedAt)
        assertEquals(120.seconds, state.limit)
        assertEquals(listOf(WatchHaptic.START), haptics)
        assertTrue(effects.isEmpty())
    }

    @Test
    fun new_note_asks_for_text_when_the_gateway_does_not_transcribe() = watch {
        for (gate in listOf(false, true)) {
            effects.clear()
            if (gate) publishGate(active = false) else link.gate = null
            core.dictateNote()
            settle()
            assertEquals(listOf<WatchEffect>(WatchEffect.RequestTextInput(TextInputPurpose.NOTE)), effects)
            assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)
        }
    }

    @Test
    fun new_note_asks_for_text_when_the_gate_is_stale_or_the_microphone_is_refused() = watch {
        publishGate(active = true, maxAudioBytes = 2_000_000, updatedAt = now - 8L * 24 * 60 * 60 * 1000)
        core.dictateNote()
        settle()
        assertEquals(listOf<WatchEffect>(WatchEffect.RequestTextInput(TextInputPurpose.NOTE)), effects)

        effects.clear()
        publishGate(active = true, maxAudioBytes = 2_000_000)
        permission.granted = false
        core.dictateNote()
        settle()
        assertEquals(listOf<WatchEffect>(WatchEffect.RequestTextInput(TextInputPurpose.NOTE)), effects)

        effects.clear()
        permission.granted = true
        recorder.failsToOpen = true
        core.dictateNote()
        settle()
        assertEquals(listOf<WatchEffect>(WatchEffect.RequestTextInput(TextInputPurpose.NOTE)), effects)
    }

    @Test
    fun sending_a_recorded_note_confirms_it_and_leaves() = watch {
        publishGate(active = true, maxAudioBytes = 2_000_000)
        core.dictateNote()
        settle()
        core.voiceNote.send()
        assertEquals(VoiceNoteState.Sent(recorded = true), core.voiceNote.state.value)
        assertEquals(listOf(WatchHaptic.START, WatchHaptic.SUCCESS), haptics)
        settle()
        val sent = link.item(link.items.keys.single()) as RecordingMetadata
        assertEquals(VoiceKind.NOTE, sent.voiceKind)
        assertNull(sent.captureRoute)
        assertEquals(WearDataLayer.VOICE_NUDGE_PATH to VoiceNudge, link.sent.single())
        pass(CaptureDismissal.CONFIRMATION_DELAY)
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
    }

    @Test
    fun the_time_limit_sends_a_recorded_note() = watch {
        publishGate(active = true, maxAudioBytes = 2_000_000)
        core.dictateNote()
        settle()
        recorder.current.reachLimit()
        assertEquals(VoiceNoteState.Sent(recorded = true), core.voiceNote.state.value)
        assertEquals(1, core.store.entries().size)
    }

    @Test
    fun leaving_the_screen_or_an_interruption_sends_what_was_recorded() = watch {
        publishGate(active = true, maxAudioBytes = 2_000_000)
        core.dictateNote()
        settle()
        core.enteredBackground()
        assertEquals(1, core.store.entries().size)

        pass(4.seconds)
        core.dictateNote()
        settle()
        recorder.current.interrupt()
        assertEquals(2, core.store.entries().size)
    }

    @Test
    fun cancelling_a_recorded_note_throws_it_away() = watch {
        publishGate(active = true, maxAudioBytes = 2_000_000)
        core.dictateNote()
        settle()
        val file = recorder.current.file
        core.voiceNote.cancel()
        assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)
        assertFalse(file.exists())
        assertTrue(core.store.entries().isEmpty())
        assertEquals(listOf(WatchHaptic.START), haptics)
    }

    @Test
    fun a_recorded_note_that_cannot_be_kept_says_so() = watch {
        publishGate(active = true, maxAudioBytes = 2_000_000)
        core.dictateNote()
        settle()
        recorder.current.stopsCleanly = false
        core.voiceNote.send()
        assertEquals(VoiceNoteState.Failed, core.voiceNote.state.value)
        assertEquals(WatchHaptic.FAILURE, haptics.last())
        assertFalse(recorder.current.file.exists())
        pass(3.seconds)
        assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)
        assertTrue(effects.isEmpty())
    }

    @Test
    fun the_confirmation_gives_way_after_three_seconds_or_on_a_press() = watch {
        link.reachable = false
        link.installed = false
        core.note.submit("Check the smoke alarm")
        pass(2.9.seconds)
        assertEquals(VoiceNoteState.Sent(recorded = false), core.voiceNote.state.value)
        pass(0.1.seconds)
        assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)

        core.note.submit("And the one upstairs")
        core.voiceNote.dismiss()
        assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)
    }

    @Test
    fun the_recorder_takes_over_from_a_note_being_recorded() = watch {
        publishGate(active = true, maxAudioBytes = 2_000_000)
        core.dictateNote()
        settle()
        val noteFile = recorder.current.file
        core.capture.start()
        settle()
        assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)
        assertFalse(noteFile.exists())
        assertEquals(CapturePhase.Recording, capturePhase)
    }

    // The notice about dropped notes.

    @Test
    fun dropped_notes_are_told_on_the_next_visit_until_acknowledged() = watch {
        link.reachable = false
        core.note.submit("Feed the neighbour's cat")
        core.voiceNote.dismiss()
        pass(OutboxPolicy.RETENTION + 1.seconds)
        core.launched()
        settle()
        assertEquals(VoiceNoteState.Dropped(1), core.voiceNote.state.value)

        // Still there on the next visit of a new process.
        val next = WatchHarness(test, storage)
        next.core.screenAppeared()
        assertEquals(VoiceNoteState.Dropped(1), next.core.voiceNote.state.value)
        next.core.voiceNote.dismiss()
        assertEquals(0, next.core.store.droppedCount)
        next.core.screenAppeared()
        assertEquals(VoiceNoteState.Idle, next.core.voiceNote.state.value)
    }

    @Test
    fun the_dropped_notice_waits_while_something_else_is_on_screen() = watch {
        link.reachable = false
        core.note.submit("Feed the neighbour's cat")
        core.voiceNote.dismiss()
        pass(OutboxPolicy.RETENTION + 1.seconds)
        core.note.submit("Second note")
        core.launched()
        settle()
        assertEquals(VoiceNoteState.Sent(recorded = false), core.voiceNote.state.value)
        assertEquals(1, core.store.droppedCount)
    }

    // Back, or a swipe away.

    @Test
    fun back_closes_the_topmost_thing_as_its_own_button_would() = watch {
        publishGate(active = true, maxAudioBytes = 2_000_000)

        // The note screen gives way to the ask screen.
        core.showNotes()
        assertEquals(WatchScreen.NOTE, core.screen.value)
        core.dismissTop()
        assertEquals(WatchScreen.ASK, core.screen.value)

        // A note being recorded is thrown away, and the note screen stays.
        core.dictateNote()
        settle()
        core.dismissTop()
        assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)
        assertTrue(core.store.entries().isEmpty())
        assertEquals(WatchScreen.NOTE, core.screen.value)

        // A confirmation is dismissed.
        link.installed = false
        link.reachable = false
        core.note.submit("Defrost the freezer")
        core.dismissTop()
        assertEquals(VoiceNoteState.Idle, core.voiceNote.state.value)
        assertEquals(WatchScreen.NOTE, core.screen.value)
        assertTrue(effects.isEmpty())
    }

    @Test
    fun back_on_the_recorder_cancels_it_and_leaves_only_after_a_surface_launch() = watch {
        publishGate()
        core.capture.start()
        settle()
        core.dismissTop()
        settle()
        assertEquals(CapturePhase.Idle, capturePhase)
        assertTrue(effects.isEmpty())

        core.capture.start(fromSurface = true)
        settle()
        core.dismissTop()
        settle()
        assertEquals(listOf<WatchEffect>(WatchEffect.Leave), effects)
    }

    @Test
    fun back_on_a_sent_recording_closes_the_recorder_and_keeps_the_recording() = watch {
        publishGate()
        core.capture.start(fromSurface = true)
        settle()
        core.capture.send(CaptureRoute.ASK)
        settle()
        core.dismissTop()
        settle()
        assertEquals(CapturePhase.Idle, capturePhase)
        assertEquals(1, core.store.entries().size)
        assertTrue("Done never leaves the app", effects.isEmpty())
    }

    // What the phone sends.

    @Test
    fun an_unreadable_or_unknown_request_is_answered_as_not_displayed() = watch {
        val garbage = core.received("/omnesis/capture-update", "nonsense".encodeToByteArray(), isRequest = true)
        assertEquals(DisplayedReceipt(displayed = false), garbage?.let(dev.omnesis.android.wearprotocol.WearCodec::decode))
        assertNull(core.received("/omnesis/progress", "nonsense".encodeToByteArray(), isRequest = false))
        assertEquals(DisplayedReceipt(displayed = false), fromPhone(VoiceNudge, isRequest = true))
    }

    @Test
    fun messages_are_routed_by_kind_whatever_path_they_arrive_on() = watch {
        publishGate()
        core.capture.start()
        settle()
        core.capture.send(CaptureRoute.ASK)
        settle()
        val ref = core.store.entries().single().ref
        fromPhone(dev.omnesis.android.wearprotocol.RecordingReceipt(ref), "/omnesis/somewhere-else")
        assertTrue(core.store.entries().isEmpty())
        val reply = fromPhone(CaptureAnswer.of(AskOutcome.Answered("Done."), ref), "/omnesis/somewhere-else", isRequest = true)
        assertEquals(DisplayedReceipt(true, ref), reply)
    }

    @Test
    fun the_log_never_carries_what_was_asked_noted_or_answered() = watch {
        link.respond = answering(AskOutcome.Answered("The spare key is with Priya."))
        core.ask.submit("Who has the spare key?")
        settle()
        link.respond = { _, _ -> LinkReply.Failed(13) }
        core.note.submit("Collect the spare key on Tuesday")
        settle()
        assertTrue(log.lines.isNotEmpty())
        for (line in log.lines) {
            assertFalse(line, "spare key" in line)
        }
    }
}
