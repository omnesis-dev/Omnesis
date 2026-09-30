// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import dev.omnesis.android.transport.dto.DictationStatusDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** When Settings shows the Voice section, and what its switch and notes say. */
class VoiceSettingsStateTest {

    private val off = DictationStatusDto(visible = true, maxAudioBytes = 26_214_400)

    @Test
    fun hidden_unless_the_gateway_is_experimental_and_offers_the_setting() {
        assertNull(voiceSettingsState(experimental = false, dictation = off, write = VoiceWrite()))
        assertNull(voiceSettingsState(experimental = true, dictation = null, write = VoiceWrite()))
        assertNull(voiceSettingsState(experimental = true, dictation = off.copy(visible = false), write = VoiceWrite()))
    }

    @Test
    fun the_switch_follows_the_gateway_setting() {
        assertEquals(VoiceSettingsState(transcribeOnGateway = false), voiceSettingsState(true, off, VoiceWrite()))
        val active = off.copy(enabled = true, modelAssigned = true, active = true)
        assertEquals(VoiceSettingsState(transcribeOnGateway = true), voiceSettingsState(true, active, VoiceWrite()))
    }

    @Test
    fun a_write_in_flight_shows_its_value_and_waits() {
        assertEquals(
            VoiceSettingsState(transcribeOnGateway = true, saving = true),
            voiceSettingsState(true, off, VoiceWrite(pending = true)),
        )
    }

    @Test
    fun switched_on_without_a_runnable_transcriber_says_why_as_a_sentence() {
        val blocked = off.copy(enabled = true, reason = "No transcriber model is assigned")
        assertEquals(
            "No transcriber model is assigned.",
            voiceSettingsState(true, blocked, VoiceWrite())?.blockedReason,
        )
        assertEquals(
            "No transcriber model can run.",
            voiceSettingsState(true, off.copy(enabled = true), VoiceWrite())?.blockedReason,
        )
        // Switched off, nothing is in the way of anything.
        assertNull(voiceSettingsState(true, off.copy(reason = "No transcriber model is assigned."), VoiceWrite())?.blockedReason)
    }

    @Test
    fun the_blocked_reason_hides_while_a_write_is_in_flight() {
        val blocked = off.copy(enabled = true, reason = "No transcriber model is assigned.")
        assertNull(voiceSettingsState(true, blocked, VoiceWrite(pending = false))?.blockedReason)
    }

    @Test
    fun a_saved_write_whose_status_could_not_be_reread_keeps_its_value_until_new_status_arrives() {
        val saved = voiceSettingsState(true, off, VoiceWrite(saved = true, savedOver = off))!!
        assertEquals(true, saved.transcribeOnGateway)
        assertEquals(false, saved.saving)
        assertEquals("Saved. Your gateway's status will update when it can be read.", saved.notice)

        val fresh = off.copy(enabled = true, modelAssigned = true, active = true)
        val reread = voiceSettingsState(true, fresh, VoiceWrite(saved = true, savedOver = off))!!
        assertEquals(VoiceSettingsState(transcribeOnGateway = true), reread)
    }

    @Test
    fun an_unpaired_app_cannot_change_the_setting() {
        assertEquals(false, voiceSettingsState(true, off, VoiceWrite(), paired = false)?.canChange)
    }

    @Test
    fun a_failed_write_is_reported_beside_the_gateway_value() {
        assertEquals(
            VoiceSettingsState(transcribeOnGateway = false, error = "Couldn't reach your gateway."),
            voiceSettingsState(true, off, VoiceWrite(error = "Couldn't reach your gateway.")),
        )
    }
}
