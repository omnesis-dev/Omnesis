// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.loopback

import dev.omnesis.android.wear.core.CapturePhase
import dev.omnesis.android.wear.core.TextInputPurpose
import dev.omnesis.android.wear.core.VoiceNoteState
import dev.omnesis.android.wear.core.WatchEffect
import dev.omnesis.android.wearprotocol.CaptureButtons
import dev.omnesis.android.wearprotocol.DictationGate
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs [body] on a fresh [Loopback], and removes what it wrote. */
internal fun loopback(body: Loopback.(TestScope) -> Unit) = runTest {
    val loop = Loopback(this)
    try {
        loop.body(this)
    } finally {
        loop.cleanUp()
    }
}

/** The gate the phone publishes is what decides the buttons the watch's recorder offers. */
class GateLoopbackTest {
    private fun Loopback.openRecorder(): CaptureButtons {
        watch.core.capture.start()
        settle()
        return recorder.buttons.also { watch.core.capture.cancel() }
    }

    @Test
    fun a_gateway_that_decides_for_itself_gives_the_watch_one_send_button() = loopback {
        publishGate(decisionGate = true)

        watch.core.capture.start()
        settle()
        assertEquals(CaptureButtons.SEND, recorder.buttons)
        assertEquals(CapturePhase.Recording, recorder.phase)
        watch.core.capture.cancel()
        assertNothingLeft()
    }

    @Test
    fun a_gateway_that_does_not_decide_leaves_the_choice_to_the_person() = loopback {
        publishGate(decisionGate = false)

        assertEquals(CaptureButtons.ASK_AND_TELL, openRecorder())
        assertNothingLeft()
    }

    @Test
    fun a_gate_follows_the_gateway_as_its_status_changes() = loopback {
        publishGate(decisionGate = true)
        assertEquals(CaptureButtons.SEND, openRecorder())

        publishGate(decisionGate = false)
        assertEquals(CaptureButtons.ASK_AND_TELL, openRecorder())
    }

    @Test
    fun an_unpaired_phone_makes_the_watch_say_to_open_the_phone_app() = loopback {
        publishGate(paired = false)

        watch.core.capture.start()
        settle()
        // The screen for this phase is "Couldn't record" over "Open the phone app. …".
        assertEquals(CapturePhase.Failed, recorder.phase)
        assertEquals(CaptureButtons.UNSUPPORTED, recorder.buttons)
        assertTrue("no microphone was opened", watch.recorder.sessions.isEmpty())
        assertNothingLeft()
    }

    @Test
    fun a_phone_that_has_not_read_its_gateway_yet_publishes_nothing_and_the_watch_cannot_record() = loopback {
        // Paired, but no status has been read: the phone does not speak from ignorance.
        pass(1.seconds)
        assertNull(layer.gateOnWatch())

        watch.core.capture.start()
        settle()
        assertEquals(CapturePhase.Failed, recorder.phase)
    }

    @Test
    fun a_gate_the_phone_stopped_refreshing_for_a_week_no_longer_offers_send_or_voice_notes() = loopback {
        publishGate(decisionGate = true, dictationMaxAudioBytes = 4_000_000)
        assertEquals(CaptureButtons.SEND, openRecorder())

        sleepThrough(DictationGate.STALE_AFTER)

        // The recorder still works, since the phone app is there, but the person chooses.
        assertEquals(CaptureButtons.ASK_AND_TELL, openRecorder())
        // And the note screen dictates text rather than record for a gateway it can no longer vouch for.
        watch.core.dictateNote()
        settle()
        assertEquals(VoiceNoteState.Idle, watch.core.voiceNote.state.value)
        assertEquals(WatchEffect.RequestTextInput(TextInputPurpose.NOTE), watch.effects.last())
    }

    @Test
    fun a_phone_that_keeps_refreshing_keeps_the_gate_fresh_on_the_watch() = loopback {
        publishGate(decisionGate = true)
        val first = layer.gateOnWatch()

        // Each day's refresh publishes the unchanged gate again with a new time.
        repeat(8) {
            pass(25.hours)
            publishGate(decisionGate = true)
        }

        assertTrue(layer.gateOnWatch()!!.updatedAt > first!!.updatedAt)
        assertEquals(CaptureButtons.SEND, openRecorder())
    }

    @Test
    fun a_gate_published_out_of_reach_arrives_when_the_watch_connects() = loopback {
        layer.disconnect()
        publishGate(decisionGate = true)
        assertNull("nothing crosses while out of reach", layer.gateOnWatch())

        layer.connect()
        pass(1.seconds)

        assertEquals(CaptureButtons.SEND, openRecorder())
    }
}
