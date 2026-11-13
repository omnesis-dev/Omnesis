// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.loopback

import dev.omnesis.android.wear.RelayNotice
import dev.omnesis.android.wear.core.NoteState
import dev.omnesis.android.wear.core.VoiceNoteState
import dev.omnesis.android.wear.core.WatchEffect
import dev.omnesis.android.wearprotocol.CaptureDismissal
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.NoteCaptureTime
import dev.omnesis.android.wearprotocol.NoteOutcome
import dev.omnesis.android.wearprotocol.OutboxPolicy
import dev.omnesis.android.wearprotocol.WearDataLayer
import java.time.ZoneId
import kotlin.time.Duration.Companion.seconds
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A note from the watch's note screen: typed as text, or recorded for the gateway to transcribe. */
class NoteLoopbackTest {
    private val text = "Buy oat milk"

    private fun Loopback.acks(): List<NoteAck> = layer.sentToWatch.map { it.second }.filterIsInstance<NoteAck>()

    @Test
    fun a_note_sent_live_is_saved_once_in_the_watchs_time_zone_and_released() = loopback {
        val capturedAt = now

        typeNote("  $text ")
        settle()
        // Sent means safely in the outbox, before the phone has said anything.
        assertEquals(NoteState.Sent(text), watch.core.note.state.value)
        assertEquals(VoiceNoteState.Sent(recorded = false), watch.core.voiceNote.state.value)

        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)

        val saved = notes.saved.single()
        assertEquals(text, saved.text)
        assertEquals(ref(1), saved.ref)
        assertEquals(NoteCaptureTime.at(capturedAt, ZoneId.of("Europe/London")), saved.captureTime)
        // Tap, type, send reads as one gesture: the app leaves by itself.
        assertEquals(WatchEffect.Leave, watch.effects.last())
        assertTrue(notifier.posted.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun a_note_the_phone_could_only_queue_is_released_just_the_same() = loopback {
        notes.outcome = NoteOutcome.QUEUED_ON_PHONE

        typeNote(text)
        pass()

        assertEquals(1, notes.saved.size)
        assertTrue(notifier.posted.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun a_note_the_gateway_refuses_is_released_and_reported_on_the_phone() = loopback {
        notes.outcome = NoteOutcome.REJECTED

        typeNote(text)
        pass()

        // The watch said it was sent and has nothing more to show, so the phone says what became of it.
        assertEquals(listOf(RelayNotice.textNoteFailed), notifier.posted)
        assertNothingLeft()
    }

    @Test
    fun a_note_written_out_of_reach_waits_as_a_dataitem_and_is_saved_once_when_the_phone_returns() = loopback {
        layer.disconnect()
        pass(1.seconds)

        typeNote(text)
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)

        // Something durable carries it, so the watch confirms and leaves; the note stays in the outbox.
        assertEquals(WatchEffect.Leave, watch.effects.last())
        assertEquals(listOf(ref(1)), outbox())
        assertEquals(setOf(WearDataLayer.queuedPath(ref(1))), layer.leftovers())
        assertTrue(notes.saved.isEmpty())

        layer.connect()
        pass()

        assertEquals(text, notes.saved.single().text)
        // A queued note has no request to reply to: its acknowledgement is a message of its own.
        // The phone meets the item more than once (its arrival, and the scan a waking relay
        // makes); every later meeting only says the note already arrived.
        assertEquals(WearDataLayer.NOTE_ACK_PATH to NoteAck.of(NoteOutcome.SAVED, ref(1)), layer.sentToWatch.first())
        assertTrue(acks().drop(1).all { it == NoteAck.of(NoteOutcome.REACHED_PHONE, ref(1)) })
        assertNothingLeft()
    }

    @Test
    fun a_queued_note_whose_acknowledgement_is_lost_is_released_by_the_next_hand_over_without_a_second_save() =
        loopback {
            layer.disconnect()
            pass(1.seconds)
            typeNote(text)
            pass()

            layer.losesMessagesToWatch = true
            layer.connect()
            pass()
            assertEquals(1, notes.saved.size)
            // The phone is done with the note, but the watch never heard.
            assertEquals(listOf(ref(1)), outbox())

            layer.losesMessagesToWatch = false
            watch.core.launched()
            pass()

            // The live copy is answered "already here" in its reply, and that releases the note.
            assertEquals(1, notes.saved.size)
            assertNothingLeft()
        }

    @Test
    fun a_live_note_whose_send_fails_falls_back_to_the_queued_copy_and_is_saved_once() = loopback {
        // The phone takes the note and saves it, but its reply never arrives.
        layer.losesReplies = true
        layer.requestTimeout = 5.seconds

        typeNote(text)
        pass(10.seconds)

        assertEquals(1, notes.saved.size)
        // The queued copy the watch fell back to only releases it.
        assertTrue(acks().isNotEmpty() && acks().all { it == NoteAck.of(NoteOutcome.REACHED_PHONE, ref(1)) })
        assertNothingLeft()
    }

    @Test
    fun a_voice_note_from_the_note_screen_is_uploaded_with_its_audio_language_and_time_zone() = loopback {
        publishGate(dictationMaxAudioBytes = 4_000_000)
        backend.gatewayDictation = true
        val capturedAt = now

        watch.core.dictateNote()
        settle()
        assertTrue(watch.core.voiceNote.isRecording)
        watch.core.voiceNote.send()
        pass(CaptureDismissal.CONFIRMATION_DELAY + 1.seconds)

        val saved = notes.saved.single()
        assertEquals("", saved.text)
        assertArrayEquals(byteArrayOf(1, 2, 3), saved.audio)
        assertEquals("en-GB", saved.locale)
        assertEquals(NoteCaptureTime.at(capturedAt, ZoneId.of("Europe/London")), saved.captureTime)
        assertEquals(ref(1), saved.ref)
        assertTrue("the gateway transcribes it; the phone does not", transcriber.heard.isEmpty())
        assertEquals(WatchEffect.Leave, watch.effects.last())
        assertNothingLeft()
    }

    @Test
    fun a_voice_note_recorded_out_of_reach_is_delivered_once_when_the_phone_returns() = loopback {
        publishGate(dictationMaxAudioBytes = 4_000_000)
        backend.gatewayDictation = true
        layer.disconnect()
        pass(1.seconds)

        watch.core.dictateNote()
        settle()
        watch.core.voiceNote.send()
        pass()
        assertEquals(listOf(ref(1)), outbox())

        layer.connect()
        pass()
        // The Data Layer hands the phone the recording a second time.
        phone.relay.onItem(layer.deliveredToPhone.last())
        pass()

        assertEquals(1, notes.saved.size)
        assertNothingLeft()
    }

    @Test
    fun a_note_no_phone_took_for_a_week_is_dropped_on_the_watch_and_the_person_is_told_there() = loopback {
        layer.disconnect()
        pass(1.seconds)
        typeNote(text)
        pass(5.seconds)

        sleepThrough(OutboxPolicy.RETENTION + 1.seconds)
        watch.core.launched()
        pass()

        assertEquals(VoiceNoteState.Dropped(1), watch.core.voiceNote.state.value)
        watch.core.voiceNote.dismiss()
        assertEquals(VoiceNoteState.Idle, watch.core.voiceNote.state.value)
        assertFalse("told once", watch.core.store.droppedCount > 0)

        layer.connect()
        pass()
        assertTrue("the phone never sees a note the watch gave up on", notes.saved.isEmpty())
        assertNothingLeft()
    }
}
