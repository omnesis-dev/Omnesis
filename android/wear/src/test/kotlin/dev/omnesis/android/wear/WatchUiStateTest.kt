// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wear.core.AskState
import dev.omnesis.android.wear.core.CapturePhase
import dev.omnesis.android.wear.core.CaptureState
import dev.omnesis.android.wear.core.NoteState
import dev.omnesis.android.wear.core.VoiceNoteState
import dev.omnesis.android.wear.core.WatchScreen
import dev.omnesis.android.wear.ui.WatchUiState
import dev.omnesis.android.wear.ui.clock
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.CaptureRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/** What the screen derives from the state it is given. */
class WatchUiStateTest {
    private fun recorder(phase: CapturePhase) = WatchUiState(capture = CaptureState(phase))

    private val answered = AskState.Answered("Half past four.", AskOutcome.Kind.ANSWER, "")

    @Test
    fun the_ask_screen_is_uncovered_whatever_it_shows() {
        assertFalse(WatchUiState().coversAsk)
        assertFalse(WatchUiState(ask = AskState.Asking("When is high tide?", "q")).coversAsk)
        assertFalse(WatchUiState(ask = answered).coversAsk)
        // A note left on the note screen does not cover the ask screen once that is showing again.
        assertFalse(WatchUiState(note = NoteState.Sent("Buy stamps")).coversAsk)
    }

    @Test
    fun the_recorder_the_note_recorder_and_the_note_screen_cover_the_ask_screen() {
        val phases = listOf(
            CapturePhase.Preparing,
            CapturePhase.Recording,
            CapturePhase.Ready,
            CapturePhase.Saving,
            CapturePhase.Sent(CaptureRoute.NOTE),
            CapturePhase.Failed,
        )
        for (phase in phases) assertTrue("$phase", recorder(phase).coversAsk)
        assertTrue(WatchUiState(voiceNote = VoiceNoteState.Recording(0, 120.seconds)).coversAsk)
        assertTrue(WatchUiState(voiceNote = VoiceNoteState.Dropped(1)).coversAsk)
        assertTrue(WatchUiState(screen = WatchScreen.NOTE).coversAsk)
    }

    @Test
    fun the_display_stays_awake_while_the_microphone_is_open_or_a_typed_question_is_out() {
        assertTrue(recorder(CapturePhase.Preparing).keepsScreenOn)
        assertTrue(recorder(CapturePhase.Recording).keepsScreenOn)
        assertTrue(WatchUiState(voiceNote = VoiceNoteState.Recording(0, 120.seconds)).keepsScreenOn)
        assertTrue(WatchUiState(ask = AskState.Asking("When is high tide?", "q")).keepsScreenOn)
    }

    @Test
    fun the_display_is_not_held_awake_for_a_wait_with_no_end() {
        assertFalse(WatchUiState().keepsScreenOn)
        assertFalse(WatchUiState(ask = answered).keepsScreenOn)
        assertFalse(recorder(CapturePhase.Ready).keepsScreenOn)
        for (route in CaptureRoute.entries) assertFalse("$route", recorder(CapturePhase.Sent(route)).keepsScreenOn)
        assertFalse(WatchUiState(voiceNote = VoiceNoteState.Sent(recorded = true)).keepsScreenOn)
    }

    @Test
    fun a_duration_reads_as_minutes_and_seconds() {
        assertEquals("0:00", clock(0.seconds))
        assertEquals("0:12", clock(12.seconds))
        assertEquals("0:12", clock(12_900.milliseconds))
        assertEquals("2:00", clock(120.seconds))
        assertEquals("0:00", clock((-3).seconds))
    }
}
