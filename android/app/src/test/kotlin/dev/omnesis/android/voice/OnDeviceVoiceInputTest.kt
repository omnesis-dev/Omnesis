// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.ui.capture.SpeechTranscriber
import dev.omnesis.android.ui.capture.SpeechTranscriber.EndReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * How [OnDeviceVoiceInput] chains the recognizer's one-utterance sessions into one
 * dictation. The manual (Tell Omnesis) chaining is also covered end to end by
 * `CaptureViewModelTest`; this pins the hands-free rules and the stale-session guard.
 */
@RunWith(RobolectricTestRunner::class)
class OnDeviceVoiceInputTest {

    private class FakeTranscriber(context: Context) : SpeechTranscriber(context) {
        val sessions = mutableListOf<Listener>()
        var cancelCount = 0
        override fun isAvailable() = true
        override fun start(listener: Listener) {
            sessions += listener
        }
        override fun stop() = Unit
        override fun cancel() {
            cancelCount++
        }
    }

    private class Collector : VoiceInput.Listener {
        val partials = mutableListOf<String>()
        val texts = mutableListOf<String>()
        val ends = mutableListOf<VoiceInputEnd>()
        override fun onPartial(text: String) {
            partials += text
        }
        override fun onText(text: String) {
            texts += text
        }
        override fun onEnded(end: VoiceInputEnd) {
            ends += end
        }
    }

    private val transcriber = FakeTranscriber(ApplicationProvider.getApplicationContext())
    private val input = OnDeviceVoiceInput(transcriber)
    private val out = Collector()

    @Test
    fun hands_free_restarts_through_silence_and_ends_after_the_first_heard_utterance() {
        input.start(Endpointing.SPEECH_END, out)
        transcriber.sessions.last().onEnded(EndReason.NORMAL)
        transcriber.sessions.last().onEnded(EndReason.NORMAL)
        assertEquals(3, transcriber.sessions.size)
        assertTrue(out.ends.isEmpty())

        transcriber.sessions.last().onPartial("what's on")
        transcriber.sessions.last().onFinal("what's on my calendar")
        transcriber.sessions.last().onEnded(EndReason.NORMAL)

        assertEquals(listOf("what's on my calendar"), out.texts)
        assertEquals(listOf<VoiceInputEnd>(VoiceInputEnd.Finished), out.ends)
        assertEquals(3, transcriber.sessions.size)
    }

    @Test
    fun hands_free_reports_a_fault_at_once_keeping_the_heard_partial() {
        input.start(Endpointing.SPEECH_END, out)
        transcriber.sessions.last().onPartial("book a table")
        transcriber.sessions.last().onEnded(EndReason.FAULT)
        assertEquals(listOf("book a table"), out.texts)
        assertEquals(listOf<VoiceInputEnd>(VoiceInputEnd.Fault), out.ends)
        assertEquals(1, transcriber.sessions.size)
    }

    @Test
    fun manual_commits_an_unfinished_partial_before_restarting() {
        input.start(Endpointing.MANUAL, out)
        transcriber.sessions.last().onPartial("renew the passport")
        transcriber.sessions.last().onEnded(EndReason.NORMAL)
        assertEquals(listOf("renew the passport"), out.texts)
        assertEquals(2, transcriber.sessions.size)
        assertTrue(out.ends.isEmpty())
    }

    @Test
    fun callbacks_from_a_cancelled_or_replaced_session_are_ignored() {
        input.start(Endpointing.MANUAL, out)
        val first = transcriber.sessions.last()
        first.onEnded(EndReason.NORMAL)
        first.onPartial("stale words")
        first.onEnded(EndReason.DENIED)
        assertTrue(out.partials.isEmpty())
        assertTrue(out.ends.isEmpty())

        input.cancel()
        transcriber.sessions.last().onFinal("after cancel")
        transcriber.sessions.last().onEnded(EndReason.NORMAL)
        assertTrue(out.texts.isEmpty())
        assertTrue(out.ends.isEmpty())
        assertEquals(1, transcriber.cancelCount)
    }

    @Test
    fun every_end_releases_the_recognizer() {
        input.start(Endpointing.SPEECH_END, out)
        transcriber.sessions.last().onFinal("call the vet")
        transcriber.sessions.last().onEnded(EndReason.NORMAL)
        assertEquals(1, transcriber.cancelCount)

        val denied = OnDeviceVoiceInput(transcriber)
        denied.start(Endpointing.MANUAL, Collector())
        transcriber.sessions.last().onEnded(EndReason.DENIED)
        assertEquals(2, transcriber.cancelCount)

        val stopped = OnDeviceVoiceInput(transcriber)
        stopped.start(Endpointing.MANUAL, Collector())
        stopped.stop()
        transcriber.sessions.last().onEnded(EndReason.NORMAL)
        assertEquals(3, transcriber.cancelCount)
    }

    @Test
    fun terminal_recognizer_reasons_map_to_their_ends() {
        val cases = mapOf(
            EndReason.DENIED to VoiceInputEnd.Denied,
            EndReason.LANGUAGE_NOT_DOWNLOADED to VoiceInputEnd.LanguageNotDownloaded,
            EndReason.LANGUAGE_NOT_SUPPORTED to VoiceInputEnd.LanguageNotSupported,
        )
        cases.forEach { (reason, expected) ->
            val collector = Collector()
            val voice = OnDeviceVoiceInput(transcriber)
            voice.start(Endpointing.MANUAL, collector)
            transcriber.sessions.last().onEnded(reason)
            assertEquals(listOf(expected), collector.ends)
        }
    }
}
