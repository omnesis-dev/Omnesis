// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import dev.omnesis.android.transport.dto.WatchCaptureStatusDto
import dev.omnesis.android.ui.settings.WatchSettingsState.DecisionGate
import dev.omnesis.android.ui.settings.WatchSettingsState.Transcription
import dev.omnesis.android.wear.OnDeviceFileTranscriber.Availability
import dev.omnesis.android.wear.WatchLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WatchSettingsStateTest {
    private val connected = WatchLocalState(link = WatchLink.Connected("Pixel Watch 3"))
    private val active = WatchCaptureStatusDto(supported = true, enabled = true, active = true)
    private fun state(
        local: WatchLocalState = connected,
        capture: WatchCaptureStatusDto? = active,
        write: WatchGateWrite = WatchGateWrite(),
        paired: Boolean = true,
    ) = watchSettingsState(local, capture, write, paired)

    @Test
    fun the_section_is_hidden_where_the_phone_has_no_data_layer() {
        assertNull(state(local = WatchLocalState(link = null)))
    }

    @Test
    fun the_link_is_shown_as_the_data_layer_reports_it() {
        assertEquals(WatchLink.NoWatch, state(local = WatchLocalState(link = WatchLink.NoWatch))?.link)
        val missing = WatchLink.AppMissing("Pixel Watch 3")
        assertEquals(missing, state(local = WatchLocalState(link = missing))?.link)
        assertEquals(connected.link, state()?.link)
    }

    @Test
    fun the_switch_follows_the_gateway_and_is_absent_where_the_gateway_has_no_such_setting() {
        assertEquals(DecisionGate(enabled = true), state()?.decisionGate)
        assertEquals(DecisionGate(enabled = false), state(capture = active.copy(enabled = false, active = false))?.decisionGate)
        assertNull(state(capture = WatchCaptureStatusDto())?.decisionGate)
        assertNull("the status has not been read", state(capture = null)?.decisionGate)
        assertEquals(DecisionGate(enabled = true, canChange = false), state(paired = false)?.decisionGate)
    }

    @Test
    fun a_gate_switched_on_without_a_decision_model_says_what_the_watch_shows_meanwhile() {
        val pending = active.copy(active = false)
        assertEquals(DecisionGate(enabled = true, needsDecisionModel = true), state(capture = pending)?.decisionGate)
        // While the setting is being rewritten the old status explains nothing.
        assertEquals(
            DecisionGate(enabled = false, saving = true),
            state(capture = pending, write = WatchGateWrite(pending = false))?.decisionGate,
        )
    }

    @Test
    fun a_write_in_flight_shows_its_value_and_a_failed_one_says_so() {
        assertEquals(
            DecisionGate(enabled = false, saving = true),
            state(write = WatchGateWrite(pending = false))?.decisionGate,
        )
        val failed = state(write = WatchGateWrite(failed = true))
        assertEquals(WATCH_SETTING_SAVE_FAILED, failed?.error)
        assertEquals("the switch is back on the gateway's value", DecisionGate(enabled = true), failed?.decisionGate)
        assertNull(state()?.error)
    }

    @Test
    fun a_value_saved_over_an_unreadable_status_holds_until_the_status_changes() {
        val write = WatchGateWrite(saved = false, savedOver = active)
        assertEquals(DecisionGate(enabled = false), state(write = write)?.decisionGate)
        val reread = active.copy(enabled = false, active = false)
        assertEquals(DecisionGate(enabled = false), state(capture = reread, write = write)?.decisionGate)
        val changedElsewhere = active.copy(completionNotifications = true)
        assertEquals(DecisionGate(enabled = true), state(capture = changedElsewhere, write = write)?.decisionGate)
    }

    @Test
    fun the_transcription_control_asks_for_the_microphone_before_offering_a_retry() {
        assertEquals(Transcription.None, state()?.transcription)
        assertEquals(
            Transcription.NeedsMicrophone(),
            state(local = connected.copy(transcription = Availability.NEEDS_MICROPHONE, waitingRecordings = 2))?.transcription,
        )
        assertEquals(
            Transcription.NeedsMicrophone(denied = true),
            state(local = connected.copy(transcription = Availability.NEEDS_MICROPHONE, microphoneDenied = true))?.transcription,
        )
        assertEquals(Transcription.Waiting(2), state(local = connected.copy(waitingRecordings = 2))?.transcription)
        // A phone that can never transcribe a file has no permission worth asking for.
        assertEquals(
            Transcription.None,
            state(local = connected.copy(transcription = Availability.UNSUPPORTED))?.transcription,
        )
        assertEquals(
            Transcription.Waiting(1),
            state(local = connected.copy(transcription = Availability.UNSUPPORTED, waitingRecordings = 1))?.transcription,
        )
    }
}
