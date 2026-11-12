// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.hours
import kotlin.time.Duration.Companion.seconds

class DictationGateTest {
    private val now = 1_790_000_000_000L
    private val week = 7.days.inWholeMilliseconds
    private val day = 24.hours.inWholeMilliseconds

    private fun gate(
        active: Boolean = true,
        maxAudioBytes: Long = 26_214_400,
        updatedAt: Long = now,
        decisionGate: Boolean = false,
        captureSupported: Boolean = false,
    ) = DictationGate(active, maxAudioBytes, updatedAt, decisionGate, captureSupported)

    // Format and recording limit.

    @Test
    fun the_format_is_speech_rate_mono_aac() {
        assertEquals(16_000, RecordingFormat.SAMPLE_RATE_HZ)
        assertEquals(24_000, RecordingFormat.BIT_RATE)
        assertEquals(1, RecordingFormat.CHANNELS)
        assertEquals("audio/mp4", RecordingFormat.CONTENT_TYPE)
        assertEquals("m4a", RecordingFormat.FILE_EXTENSION)
        assertEquals(120.seconds, RecordingFormat.MAX_DURATION)
    }

    @Test
    fun a_generous_byte_limit_records_up_to_the_cap() {
        assertEquals(120.seconds, RecordingFormat.recordingLimit(26_214_400))
        // Exactly the cap: 120 s at 3000 bytes a second, over nine tenths.
        assertEquals(120.seconds, RecordingFormat.recordingLimit(400_000))
    }

    @Test
    fun a_small_byte_limit_shortens_the_recording() {
        // Nine tenths of 90 000 bytes at 24 kbps is 27 seconds.
        assertEquals(27.seconds, RecordingFormat.recordingLimit(90_000))
    }

    @Test
    fun a_byte_limit_with_no_room_allows_no_recording() {
        assertNull(RecordingFormat.recordingLimit(0))
        assertNull(RecordingFormat.recordingLimit(-1))
        assertNull(RecordingFormat.recordingLimit(3_000))
        assertEquals(1.seconds, RecordingFormat.recordingLimit(3_334)?.inWholeSeconds?.seconds)
    }

    @Test
    fun the_note_screen_records_only_for_an_active_fresh_gate() {
        assertEquals(120.seconds, gate().recordingLimit(now))
        assertNull(gate(active = false).recordingLimit(now))
        assertNull(gate(maxAudioBytes = 0).recordingLimit(now))
        assertNull(gate(updatedAt = now - week).recordingLimit(now))
    }

    @Test
    fun the_unified_recorder_falls_back_to_the_format_cap() {
        assertEquals(27.seconds, captureRecordingLimit(gate(maxAudioBytes = 90_000), now))
        assertEquals(120.seconds, captureRecordingLimit(gate(active = false, maxAudioBytes = 90_000), now))
        assertEquals(120.seconds, captureRecordingLimit(null, now))
    }

    // Staleness.

    @Test
    fun a_gate_goes_stale_at_seven_days() {
        assertEquals(7.days, DictationGate.STALE_AFTER)
        assertTrue(gate(updatedAt = now).isFresh(now))
        assertTrue(gate(updatedAt = now - week + 1).isFresh(now))
        assertFalse(gate(updatedAt = now - week).isFresh(now))
        assertFalse(gate(updatedAt = now - week - 1).isFresh(now))
    }

    @Test
    fun a_gate_stamped_in_the_future_is_fresh() {
        assertTrue(gate(updatedAt = now + day).isFresh(now))
    }

    // Capture buttons.

    @Test
    fun the_recorder_is_unsupported_without_a_gate_that_says_otherwise() {
        for (followUp in listOf(false, true)) {
            assertEquals(CaptureButtons.UNSUPPORTED, captureButtons(null, now, followUp))
            assertEquals(CaptureButtons.UNSUPPORTED, captureButtons(gate(decisionGate = true), now, followUp))
        }
    }

    @Test
    fun capture_buttons_decision_table() {
        data class Row(val decisionGate: Boolean, val fresh: Boolean, val followUp: Boolean, val expected: CaptureButtons)
        val rows = listOf(
            Row(decisionGate = true, fresh = true, followUp = false, expected = CaptureButtons.SEND),
            Row(decisionGate = true, fresh = true, followUp = true, expected = CaptureButtons.ASK_ONLY),
            Row(decisionGate = true, fresh = false, followUp = false, expected = CaptureButtons.ASK_AND_TELL),
            Row(decisionGate = true, fresh = false, followUp = true, expected = CaptureButtons.ASK_ONLY),
            Row(decisionGate = false, fresh = true, followUp = false, expected = CaptureButtons.ASK_AND_TELL),
            Row(decisionGate = false, fresh = true, followUp = true, expected = CaptureButtons.ASK_ONLY),
            Row(decisionGate = false, fresh = false, followUp = false, expected = CaptureButtons.ASK_AND_TELL),
            Row(decisionGate = false, fresh = false, followUp = true, expected = CaptureButtons.ASK_ONLY),
        )
        for (row in rows) {
            val gate = gate(
                updatedAt = if (row.fresh) now - week + 1 else now - week,
                decisionGate = row.decisionGate,
                captureSupported = true,
            )
            assertEquals(row.toString(), row.expected, captureButtons(gate, now, row.followUp))
        }
    }

    @Test
    fun a_stale_gate_still_supports_capture() {
        val stale = gate(active = false, updatedAt = now - 30 * day, captureSupported = true)
        assertEquals(CaptureButtons.ASK_AND_TELL, captureButtons(stale, now, followUp = false))
    }

    // Publishing.

    @Test
    fun an_unknown_status_publishes_nothing() {
        assertNull(GatePublishing.gate(paired = true, statusKnown = false, gatewayMaxAudioBytes = null, now = now))
        assertNull(GatePublishing.gate(paired = true, statusKnown = false, gatewayMaxAudioBytes = 90_000, now = now))
    }

    @Test
    fun a_known_status_gives_the_gate() {
        assertEquals(
            gate(maxAudioBytes = 90_000, decisionGate = true, captureSupported = true),
            GatePublishing.gate(
                paired = true,
                statusKnown = true,
                gatewayMaxAudioBytes = 90_000,
                now = now,
                decisionGate = true,
                captureSupported = true,
            ),
        )
    }

    @Test
    fun a_gateway_that_does_not_transcribe_is_off_but_keeps_capture() {
        assertEquals(
            gate(active = false, maxAudioBytes = 0, captureSupported = true),
            GatePublishing.gate(
                paired = true,
                statusKnown = true,
                gatewayMaxAudioBytes = null,
                now = now,
                captureSupported = true,
            ),
        )
    }

    @Test
    fun unpaired_is_off_without_a_status() {
        assertEquals(
            gate(active = false, maxAudioBytes = 0),
            GatePublishing.gate(
                paired = false,
                statusKnown = false,
                gatewayMaxAudioBytes = 90_000,
                now = now,
                decisionGate = true,
                captureSupported = true,
            ),
        )
    }

    @Test
    fun the_first_gate_and_every_change_are_published() {
        val last = gate()
        assertTrue(GatePublishing.shouldPublish(last, last = null, now = now))
        assertTrue(GatePublishing.shouldPublish(gate(active = false), last, now))
        assertTrue(GatePublishing.shouldPublish(gate(maxAudioBytes = 90_000), last, now))
        assertTrue(GatePublishing.shouldPublish(gate(decisionGate = true), last, now))
        assertTrue(GatePublishing.shouldPublish(gate(captureSupported = true), last, now))
    }

    @Test
    fun an_unchanged_gate_waits_for_the_daily_refresh() {
        val last = gate(updatedAt = now)
        assertEquals(24.hours, GatePublishing.REFRESH_INTERVAL)
        assertFalse(GatePublishing.shouldPublish(gate(updatedAt = now + 1), last, now + 1))
        assertFalse(GatePublishing.shouldPublish(gate(updatedAt = now + day - 1), last, now + day - 1))
        assertTrue(GatePublishing.shouldPublish(gate(updatedAt = now + day), last, now + day))
    }

    // Leaving after a note.

    @Test
    fun the_app_leaves_only_once_the_note_is_carried_and_nothing_else_runs() {
        assertEquals(1.8.seconds, CaptureDismissal.CONFIRMATION_DELAY)
        assertTrue(CaptureDismissal.shouldLeave(showingSent = true, carried = true, otherWorkInFlight = false))
        assertFalse(CaptureDismissal.shouldLeave(showingSent = false, carried = true, otherWorkInFlight = false))
        assertFalse(CaptureDismissal.shouldLeave(showingSent = true, carried = false, otherWorkInFlight = false))
        assertFalse(CaptureDismissal.shouldLeave(showingSent = true, carried = true, otherWorkInFlight = true))
    }
}
