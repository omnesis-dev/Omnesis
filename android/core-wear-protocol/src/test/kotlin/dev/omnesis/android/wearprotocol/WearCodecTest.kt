// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearCodecTest {
    private val captureTime = NoteCaptureTime(1_790_000_000_123, "Europe/Paris", 7200)

    private fun decode(json: String): WearMessage? = WearCodec.decode(json.encodeToByteArray())

    private fun json(message: WearMessage): String = WearCodec.encode(message).decodeToString()

    @Test
    fun every_message_round_trips() {
        val note = TextNote.of("Pick up the bike on Saturday", captureTime, ref = "note-1")
        val messages = listOf(
            AskRequest("When is the ferry on Friday?", ref = "ask-1"),
            AskRequest("And the return?", ref = "ask-2", conversationId = "conversation-7"),
            AskProgress("Searching…", detail = "12 found", ref = "ask-1"),
            AskProgress("Thinking…"),
            AskResult.of(AskOutcome.Answered("Friday at 09:40."), "ask-1", "conversation-7", "message-3"),
            AskResult.of(AskOutcome.StillWorking, ref = null),
            note,
            NoteAck.of(NoteOutcome.SAVED, "note-1"),
            VoiceRecording("rec-1", captureTime, "en-GB", CaptureRoute.ASK, "conversation-7").toMetadata(),
            VoiceRecording("rec-2", captureTime, locale = null).toMetadata(),
            RecordingReceipt("rec-1"),
            VoiceNudge,
            CaptureRouteUpdate("rec-1", CaptureRoute.NOTE),
            CaptureAnswer.of(AskOutcome.Failed("The model is unavailable."), "rec-1"),
            DisplayedReceipt(displayed = true, ref = "rec-1"),
            DictationGate(active = true, maxAudioBytes = 26_214_400, updatedAt = 1_790_000_000_000, decisionGate = true),
            QueuedRelay(note, queuedAt = 1_790_000_000_500, relayAttempts = 4, relayLastError = 7),
            QueuedRelay(AskRequest("Did I book the ferry?", ref = "ask-3"), queuedAt = 1_790_000_000_500),
        )
        for (message in messages) {
            assertEquals(message, WearCodec.decode(WearCodec.encode(message)))
        }
    }

    @Test
    fun each_kind_has_its_stable_discriminator() {
        val kinds = mapOf(
            AskRequest("q", "r") to "ask",
            AskProgress("Working…") to "progress",
            AskResult("answered") to "result",
            TextNote.of("n", captureTime, "r") to "note",
            NoteAck("saved") to "noteAck",
            VoiceRecording("r", captureTime, null).toMetadata() to "recording",
            RecordingReceipt("r") to "recordingReceived",
            VoiceNudge to "voiceNudge",
            CaptureRouteUpdate("r", CaptureRoute.ASK) to "captureRoute",
            CaptureAnswer("r", "answered") to "captureAnswer",
            DisplayedReceipt(false) to "displayed",
            DictationGate(false, 0, 0) to "dictationGate",
            QueuedRelay(VoiceNudge, 0) to "queued",
        )
        for ((message, kind) in kinds) {
            assertTrue("$kind in ${json(message)}", json(message).startsWith("""{"kind":"$kind""""))
        }
    }

    @Test
    fun field_names_follow_the_ios_relay() {
        assertEquals("""{"kind":"ask","question":"Why?","ref":"a"}""", json(AskRequest("Why?", "a")))
        assertEquals(
            """{"kind":"progress","activity":"Reading…","detail":"3 read","ref":"a"}""",
            json(AskProgress("Reading…", "3 read", "a")),
        )
        assertEquals(
            """{"kind":"result","outcome":"answered","text":"Yes.","ref":"a"}""",
            json(AskResult.of(AskOutcome.Answered("Yes."), "a")),
        )
        assertEquals(
            """{"kind":"note","ref":"n","text":"Call the studio","capturedAt":"2026-09-21T14:13:20.123Z",""" +
                """"capturedTimeZoneId":"Europe/Paris","capturedUtcOffsetSeconds":7200}""",
            json(TextNote.of("Call the studio", captureTime, "n")),
        )
        assertEquals(
            """{"kind":"recording","voiceKind":"capture","ref":"r","capturedAt":"2026-09-21T14:13:20.123Z",""" +
                """"capturedTimeZoneId":"Europe/Paris","capturedUtcOffsetSeconds":7200,"captureRoute":"automatic",""" +
                """"locale":"fr-FR"}""",
            json(VoiceRecording("r", captureTime, "fr-FR", CaptureRoute.AUTOMATIC).toMetadata()),
        )
        assertEquals("""{"kind":"voiceNudge"}""", json(VoiceNudge))
        assertEquals("""{"kind":"displayed","displayed":true}""", json(DisplayedReceipt(true)))
    }

    @Test
    fun an_unknown_kind_is_ignored() {
        assertNull(decode("""{"kind":"hologram","ref":"a"}"""))
        assertNull(decode("""{"ref":"a","question":"No kind at all"}"""))
    }

    @Test
    fun unknown_fields_are_ignored() {
        assertEquals(
            AskRequest("Why?", "a"),
            decode("""{"kind":"ask","question":"Why?","ref":"a","mood":"curious","nested":{"x":[1,2]}}"""),
        )
    }

    @Test
    fun malformed_payloads_are_ignored() {
        assertNull(WearCodec.decode(ByteArray(0)))
        assertNull(decode("not json"))
        assertNull(decode("[1,2,3]"))
        assertNull(decode(""""ask""""))
        assertNull(decode("""{"kind":"ask","question":"No ref"}"""))
        assertNull(decode("""{"kind":"ask","question":7,"ref":"a"}"""))
        assertNull(decode("""{"kind":"captureRoute","ref":"r","route":"sideways"}"""))
        assertNull(decode("""{"kind":"queued","queuedAt":5,"message":{"kind":"hologram"}}"""))
        assertNull(decode("""{"kind":"queued","message":{"kind":"voiceNudge"}}"""))
    }

    @Test
    fun optional_fields_default_when_an_older_peer_omits_them() {
        assertEquals(
            DictationGate(active = true, maxAudioBytes = 90_000, updatedAt = 5),
            decode("""{"kind":"dictationGate","active":true,"maxAudioBytes":90000,"updatedAt":5}"""),
        )
        assertEquals(AskResult("stillWorking"), decode("""{"kind":"result","outcome":"stillWorking"}"""))
        assertEquals(NoteAck("saved"), decode("""{"kind":"noteAck","outcome":"saved"}"""))
    }

    @Test
    fun an_outbox_entry_round_trips_through_its_on_disk_form() {
        val entries = listOf(
            OutboxEntry(TextNote.of("Renew the library card", captureTime, "n"), queuedAt = 10),
            OutboxEntry(
                VoiceRecording("r", captureTime, "en-GB", CaptureRoute.NOTE).toMetadata(),
                queuedAt = 20,
                failures = 2,
                lastFailureAt = 30,
            ),
        )
        for (entry in entries) {
            assertEquals(entry, WearCodec.decodeOutboxEntry(WearCodec.encodeOutboxEntry(entry)))
        }
        assertNull(WearCodec.decodeOutboxEntry("{}".encodeToByteArray()))
        assertNull(
            WearCodec.decodeOutboxEntry("""{"content":{"kind":"voiceNudge"},"queuedAt":1}""".encodeToByteArray()),
        )
    }
}
