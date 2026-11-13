// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WearMessageTest {
    private val captureTime = NoteCaptureTime(1_790_000_000_000, "America/Chicago", -18_000)

    // Ask.

    @Test
    fun a_question_is_trimmed_and_a_blank_one_is_nothing() {
        assertEquals("When is the ferry?", AskRequest("  When is the ferry?\n", "a").trimmedQuestion)
        assertNull(AskRequest("   \n", "a").trimmedQuestion)
    }

    @Test
    fun a_follow_up_names_a_usable_conversation() {
        assertEquals("conversation-7", AskRequest("q", "a", "conversation-7").resumedConversationId)
        assertNull(AskRequest("q", "a").resumedConversationId)
        assertNull(AskRequest("q", "a", "").resumedConversationId)
        assertNull(AskRequest("q", "a", "c".repeat(201)).resumedConversationId)
    }

    @Test
    fun progress_carries_the_snapshot() {
        val snapshot = AskActivitySnapshot("Searching…", "12 found")
        assertEquals(snapshot, AskProgress.of(snapshot, "a").snapshot)
        assertEquals("a", AskProgress.of(snapshot, "a").ref)
        assertNull(AskProgress.of(AskActivitySnapshot("Thinking…", ""), null).detail)
    }

    @Test
    fun an_over_long_detail_costs_only_the_detail() {
        assertEquals(AskActivitySnapshot("Reading…"), AskProgress("Reading…", "9".repeat(21)).snapshot)
        assertEquals(AskActivitySnapshot("Reading…"), AskProgress("Reading…", "").snapshot)
        assertEquals("9".repeat(20), AskProgress("Reading…", "9".repeat(20)).snapshot?.detail)
    }

    @Test
    fun an_unusable_label_is_no_snapshot() {
        assertNull(AskProgress("").snapshot)
        assertNull(AskProgress("x".repeat(41)).snapshot)
        assertEquals("x".repeat(40), AskProgress("x".repeat(40)).snapshot?.label)
    }

    @Test
    fun every_outcome_round_trips_through_a_result() {
        val outcomes = listOf(
            AskOutcome.Answered("The quote was 4,200."),
            AskOutcome.EmptyAnswer,
            AskOutcome.Failed("The model provider is unavailable."),
            AskOutcome.Failed(null),
            AskOutcome.StillWorking,
            AskOutcome.PreviousTurnRunning,
            AskOutcome.NotPaired,
            AskOutcome.ExperimentalOff,
            AskOutcome.Unauthorized,
            AskOutcome.Unreachable,
            AskOutcome.SendFailed,
            AskOutcome.PhoneUnreachable,
            AskOutcome.WatchLinkInactive,
            AskOutcome.RelayFailed,
            AskOutcome.AnswerOnPhone,
            AskOutcome.QueuedForPhone,
        )
        assertEquals(15, outcomes.map { it.tag }.toSet().size)
        for (outcome in outcomes) {
            assertEquals(outcome, AskResult.of(outcome, "a").toOutcome())
            assertEquals(outcome, CaptureAnswer.of(outcome, "r").toOutcome())
        }
    }

    @Test
    fun a_result_keeps_its_correlation_and_conversation() {
        val result = AskResult.of(AskOutcome.Answered("Yes."), "a", "conversation-7", "message-3")
        assertEquals("a", result.ref)
        assertEquals("conversation-7", result.conversationId)
        assertEquals("message-3", result.messageId)
        assertEquals("Yes.", result.text)
    }

    @Test
    fun an_unknown_outcome_reads_as_a_relay_failure() {
        assertEquals(AskOutcome.RelayFailed, AskResult("teleported", "somewhere").toOutcome())
        assertEquals(AskOutcome.RelayFailed, CaptureAnswer("r", "").toOutcome())
    }

    @Test
    fun an_answer_without_text_is_empty_and_a_failure_without_reason_has_none() {
        assertEquals(AskOutcome.Answered(""), AskResult("answered").toOutcome())
        assertEquals(AskOutcome.Failed(null), AskResult("failed").toOutcome())
        assertNull(AskResult.of(AskOutcome.Failed(""), "a").text)
        assertNull(AskResult.of(AskOutcome.StillWorking, "a").text)
    }

    @Test
    fun outcomes_present_as_answer_status_or_failure() {
        assertEquals(AskOutcome.Kind.ANSWER, AskOutcome.Answered("x").kind)
        for (status in listOf(
            AskOutcome.StillWorking,
            AskOutcome.PreviousTurnRunning,
            AskOutcome.AnswerOnPhone,
            AskOutcome.QueuedForPhone,
        )) {
            assertEquals(AskOutcome.Kind.STATUS, status.kind)
        }
        for (failure in listOf(
            AskOutcome.EmptyAnswer,
            AskOutcome.Failed("x"),
            AskOutcome.NotPaired,
            AskOutcome.ExperimentalOff,
            AskOutcome.Unauthorized,
            AskOutcome.Unreachable,
            AskOutcome.SendFailed,
            AskOutcome.PhoneUnreachable,
            AskOutcome.WatchLinkInactive,
            AskOutcome.RelayFailed,
        )) {
            assertEquals(AskOutcome.Kind.FAILURE, failure.kind)
        }
    }

    // Notes.

    @Test
    fun a_note_carries_its_text_ref_and_capture_time() {
        val note = TextNote.of("Book the marathon entry", captureTime, "n-1")
        assertEquals("n-1", note.ref)
        assertEquals("Book the marathon entry", note.trimmedText)
        assertEquals(captureTime, note.captureTime)
        assertEquals("2026-09-21T14:13:20.000Z", note.capturedAt)
    }

    @Test
    fun note_text_is_trimmed_and_a_blank_note_is_nothing() {
        assertEquals("Water the plants", note(text = "\n Water the plants  ").trimmedText)
        assertNull(note(text = " \n\t").trimmedText)
    }

    @Test
    fun a_note_without_a_real_capture_time_has_none() {
        assertNull(note(capturedAt = "yesterday").captureTime)
        assertNull(note(zone = "").captureTime)
        assertNull(note(offset = 64_801).captureTime)
        assertNull(note(offset = -64_801).captureTime)
        assertEquals(64_800, note(offset = 64_800).captureTime?.utcOffsetSeconds)
        assertEquals(-64_800, note(offset = -64_800).captureTime?.utcOffsetSeconds)
    }

    @Test
    fun note_outcome_tags_are_stable() {
        assertEquals(
            listOf("saved", "queuedOnPhone", "rejected", "captureFailed", "reachedPhone", "relayFailed"),
            NoteOutcome.entries.map { it.tag },
        )
        for (outcome in NoteOutcome.entries) {
            assertEquals(outcome, NoteAck.of(outcome, "n").toOutcome())
        }
        assertNull(NoteAck("laminated").toOutcome())
    }

    // Recordings.

    @Test
    fun recording_metadata_round_trips() {
        val recordings = listOf(
            VoiceRecording("r-1", captureTime, "en-GB"),
            VoiceRecording("r-2", captureTime, null),
            VoiceRecording("r-3", captureTime, "en-US", CaptureRoute.AUTOMATIC),
            VoiceRecording("r-4", captureTime, "en-US", CaptureRoute.NOTE),
            VoiceRecording("r-5", captureTime, "en-US", CaptureRoute.ASK, "conversation-follow-up"),
        )
        for (recording in recordings) {
            assertEquals(recording, recording.toMetadata().toRecording())
        }
    }

    @Test
    fun a_voice_note_and_a_capture_are_told_apart() {
        assertEquals(VoiceKind.NOTE, VoiceRecording("r", captureTime, null).toMetadata().voiceKind)
        assertEquals(
            VoiceKind.CAPTURE,
            VoiceRecording("r", captureTime, null, CaptureRoute.NOTE).toMetadata().voiceKind,
        )
    }

    @Test
    fun only_a_question_can_follow_up_a_conversation() {
        for (route in listOf(CaptureRoute.NOTE, CaptureRoute.AUTOMATIC)) {
            val recording = VoiceRecording("r", captureTime, "en-GB", route, "unrelated-conversation")
            assertNull(recording.toMetadata().toRecording()?.conversationId)
        }
        val tooLong = VoiceRecording("r", captureTime, "en-GB", CaptureRoute.ASK, "c".repeat(201))
        assertNull(tooLong.toMetadata().toRecording()?.conversationId)
    }

    @Test
    fun inconsistent_or_incomplete_metadata_is_rejected() {
        val valid = VoiceRecording("r", captureTime, "en-GB", CaptureRoute.ASK).toMetadata()
        assertNull(valid.copy(ref = "").toRecording())
        assertNull(valid.copy(capturedAt = "").toRecording())
        assertNull(valid.copy(capturedTimeZoneId = "").toRecording())
        assertNull(valid.copy(capturedUtcOffsetSeconds = 100_000).toRecording())
        assertNull(valid.copy(captureRoute = null).toRecording())
        assertNull(valid.copy(voiceKind = VoiceKind.NOTE).toRecording())
    }

    // Capture time.

    @Test
    fun capture_time_snapshots_the_offset_the_zone_observed() {
        val zone = java.time.ZoneId.of("Europe/Paris")
        // 15 January and 15 July 2026 at noon UTC.
        assertEquals(3600, NoteCaptureTime.at(1_768_478_400_000, zone).utcOffsetSeconds)
        assertEquals(7200, NoteCaptureTime.at(1_784_116_800_000, zone).utcOffsetSeconds)
        assertEquals("Europe/Paris", NoteCaptureTime.at(1_768_478_400_000, zone).timeZoneId)
    }

    @Test
    fun instants_parse_with_or_without_fractional_seconds_or_an_offset() {
        assertEquals(1_790_000_000_123, NoteCaptureTime.parseInstant("2026-09-21T14:13:20.123Z"))
        assertEquals(1_790_000_000_000, NoteCaptureTime.parseInstant("2026-09-21T14:13:20Z"))
        assertEquals(1_790_000_000_000, NoteCaptureTime.parseInstant("2026-09-21T16:13:20+02:00"))
        assertNull(NoteCaptureTime.parseInstant("2026-09-21"))
        assertNull(NoteCaptureTime.parseInstant(""))
    }

    private fun note(
        text: String = "A note",
        capturedAt: String = "2026-09-21T14:13:20.000Z",
        zone: String = "America/Chicago",
        offset: Int = -18_000,
    ) = TextNote("n", text, capturedAt, zone, offset)
}
