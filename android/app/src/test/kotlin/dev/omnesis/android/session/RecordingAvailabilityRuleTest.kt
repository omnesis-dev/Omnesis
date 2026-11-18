// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import dev.omnesis.android.feature.recording.ui.RecordingAvailability.Availability
import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.DictationStatusDto
import dev.omnesis.android.transport.dto.StatusSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/** What the status says about recordings, and which pairing a remembered answer belongs to. */
class RecordingAvailabilityRuleTest {

    private fun status(experimental: Boolean, recordings: Boolean, dictation: DictationStatusDto? = null): StatusSnapshot {
        val capabilities = if (recordings) """{"recordings":{"min":1,"max":1}}""" else "{}"
        return OmnesisJson.decodeFromString<StatusSnapshot>(
            """{"experimental":$experimental,"capabilities":$capabilities}""",
        ).copy(dictation = dictation)
    }

    @Test
    fun recordings_need_experimental_mode_and_the_capability() {
        assertEquals(Availability.UNAVAILABLE, recordingAvailability(status(experimental = false, recordings = true)))
        assertEquals(Availability.UNAVAILABLE, recordingAvailability(status(experimental = true, recordings = false)))
        assertEquals(Availability.AVAILABLE, recordingAvailability(status(experimental = true, recordings = true)))
    }

    @Test
    fun transcription_switched_off_is_told_apart() {
        val status = status(experimental = true, recordings = true, dictation = DictationStatusDto(enabled = false))

        assertEquals(Availability.TRANSCRIPTION_OFF, recordingAvailability(status))
    }

    @Test
    fun a_new_pairing_to_the_same_gateway_is_another_pairing() {
        val first = Pairing(url = "https://gateway.example", token = "t1", pairingGeneration = "gen-1", deviceId = "device", gatewayName = null)
        val second = first.copy(token = "t2", pairingGeneration = "gen-2")

        assertNotEquals(first.recordingKey(), second.recordingKey())
        // A rotated token keeps the pairing.
        assertEquals(first.recordingKey(), first.copy(token = "t3").recordingKey())
    }

    @Test
    fun an_older_pairing_without_a_generation_is_keyed_by_gateway_and_device() {
        val pairing = Pairing(url = "https://gateway.example", token = "t", deviceId = "device", gatewayName = null)

        assertEquals(pairing.recordingKey(), pairing.copy(token = "other").recordingKey())
        assertNotEquals(pairing.recordingKey(), pairing.copy(url = "https://other.example").recordingKey())
    }
}
