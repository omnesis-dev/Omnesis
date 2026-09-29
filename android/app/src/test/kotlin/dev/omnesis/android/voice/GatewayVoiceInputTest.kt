// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.DictationOutcome
import java.io.File
import java.io.IOException
import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * [GatewayVoiceInput] against a scripted microphone and transcriber: what reaches the
 * listener, when recording ends by itself, and — since the audio is the person's voice —
 * that the cache file is deleted on every path except a failure worth retrying.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class GatewayVoiceInputTest {

    private class FakeRecorder : AudioRecorder {
        var opens = RecordingStart.STARTED
        var captured = true
        var amplitudes = ArrayDeque<Int>()
        var maxBytes = -1L
        var onLimit: (() -> Unit)? = null
        var stopCount = 0
        var releaseCount = 0

        override fun start(file: File, maxBytes: Long, maxDurationMs: Long, onLimitReached: () -> Unit): RecordingStart {
            if (opens != RecordingStart.STARTED) return opens
            this.maxBytes = maxBytes
            onLimit = onLimitReached
            file.writeText("fake audio")
            return RecordingStart.STARTED
        }

        override fun maxAmplitude(): Int = amplitudes.removeFirstOrNull() ?: 0

        override fun stop(): Boolean {
            stopCount++
            return captured
        }

        override fun release() {
            releaseCount++
        }
    }

    private class RecordingListener : VoiceInput.Listener {
        val texts = mutableListOf<String>()
        val levels = mutableListOf<Pair<Float, Long>>()
        var transcribing = 0
        val ends = mutableListOf<VoiceInputEnd>()
        override fun onText(text: String) {
            texts += text
        }
        override fun onRecording(level: Float, elapsedMs: Long) {
            levels += level to elapsedMs
        }
        override fun onTranscribing() {
            transcribing++
        }
        override fun onEnded(end: VoiceInputEnd) {
            ends += end
        }
    }

    private lateinit var dir: File
    private val scope = TestScope(StandardTestDispatcher())
    private val recorder = FakeRecorder()
    private val listener = RecordingListener()
    private val outcomes = ArrayDeque<CompletableDeferred<DictationOutcome>>()
    private val uploaded = mutableListOf<File>()
    private var refusals = 0

    @Before fun setUp() {
        dir = Files.createTempDirectory("dictation-test").toFile()
    }

    @After fun tearDown() {
        dir.deleteRecursively()
    }

    private fun input(maxAudioBytes: Long = 25L * 1024 * 1024) = GatewayVoiceInput(
        recorder = recorder,
        newRecordingFile = { File(dir, "rec-${uploaded.size}-${System.nanoTime()}.m4a") },
        transcribe = { file ->
            uploaded += file
            outcomes.removeFirst().await()
        },
        scope = scope,
        maxAudioBytes = maxAudioBytes,
        refreshStatus = { refusals++ },
        clock = { scope.testScheduler.currentTime },
    )

    private fun reply(outcome: DictationOutcome) = CompletableDeferred(outcome).also(outcomes::addLast)

    private fun recordings() = dir.listFiles().orEmpty().toList()

    @Test
    fun manual_recording_reports_levels_then_delivers_the_transcript_and_deletes_the_audio() {
        val voice = input()
        recorder.amplitudes.addAll(listOf(8_000, 12_000))
        voice.start(Endpointing.MANUAL, listener)
        assertEquals(0f to 0L, listener.levels.single())
        scope.advanceTimeBy(250)
        assertEquals(3, listener.levels.size)
        assertEquals(200L, listener.levels.last().second)
        assertTrue(listener.levels.last().first > 0.5f)

        reply(DictationOutcome.Transcribed("  Pick up basil and lemons  ", "en", 2.5))
        voice.stop()
        assertEquals(1, listener.transcribing)
        scope.runCurrent()

        assertEquals(listOf("Pick up basil and lemons"), listener.texts)
        assertEquals(listOf<VoiceInputEnd>(VoiceInputEnd.Finished), listener.ends)
        assertEquals(1, recorder.stopCount)
        assertTrue(recordings().isEmpty())
        // Sampling stopped with the recording.
        val levels = listener.levels.size
        scope.advanceTimeBy(1_000)
        assertEquals(levels, listener.levels.size)
    }

    @Test
    fun an_empty_transcript_finishes_without_text() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        reply(DictationOutcome.Transcribed("   ", null, null))
        voice.stop()
        scope.runCurrent()
        assertTrue(listener.texts.isEmpty())
        assertEquals(listOf<VoiceInputEnd>(VoiceInputEnd.Finished), listener.ends)
    }

    @Test
    fun a_retryable_failure_keeps_the_recording_and_retry_resends_the_same_file() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        reply(DictationOutcome.Unreachable(GatewayException.Network(IOException("offline"))))
        voice.stop()
        scope.runCurrent()

        val failure = (listener.ends.single() as VoiceInputEnd.Failed).failure
        assertTrue(failure.retryable)
        assertEquals("Couldn't reach your gateway.", failure.message)
        assertEquals(1, recordings().size)

        reply(DictationOutcome.Transcribed("Call the florist", null, null))
        voice.retry()
        assertEquals(2, listener.transcribing)
        scope.runCurrent()

        assertEquals(uploaded[0], uploaded[1])
        assertEquals(listOf("Call the florist"), listener.texts)
        assertEquals(VoiceInputEnd.Finished, listener.ends.last())
        assertTrue(recordings().isEmpty())
    }

    @Test
    fun cancelling_a_failed_dictation_deletes_the_kept_recording() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        reply(DictationOutcome.TranscriberUnavailable("model loading failed"))
        voice.stop()
        scope.runCurrent()
        assertEquals(1, recordings().size)

        voice.cancel()
        assertTrue(recordings().isEmpty())
        voice.retry()
        assertEquals(1, uploaded.size)
    }

    @Test
    fun a_switched_off_gateway_deletes_the_recording_and_asks_for_fresh_status() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        reply(DictationOutcome.Disabled)
        voice.stop()
        scope.runCurrent()

        val failure = (listener.ends.single() as VoiceInputEnd.Failed).failure
        assertFalse(failure.retryable)
        assertEquals(1, refusals)
        assertTrue(recordings().isEmpty())
    }

    @Test
    fun too_large_is_final_and_deletes_the_recording() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        reply(DictationOutcome.TooLarge)
        voice.stop()
        scope.runCurrent()
        assertFalse((listener.ends.single() as VoiceInputEnd.Failed).failure.retryable)
        assertEquals(0, refusals)
        assertTrue(recordings().isEmpty())
    }

    @Test
    fun cancel_during_transcription_drops_the_result_and_the_audio() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        val pending = CompletableDeferred<DictationOutcome>().also(outcomes::addLast)
        voice.stop()
        scope.runCurrent()
        voice.cancel()
        pending.complete(DictationOutcome.Transcribed("never shown", null, null))
        scope.runCurrent()
        assertTrue(listener.texts.isEmpty())
        assertTrue(listener.ends.isEmpty())
        assertTrue(recordings().isEmpty())
    }

    @Test
    fun cancel_while_recording_releases_the_microphone_without_uploading() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        voice.cancel()
        scope.advanceTimeBy(1_000)
        assertEquals(1, recorder.releaseCount)
        assertEquals(0, recorder.stopCount)
        assertTrue(uploaded.isEmpty())
        assertTrue(recordings().isEmpty())
        assertEquals(1, listener.levels.size)
    }

    @Test
    fun hands_free_recording_ends_itself_after_speech_then_silence() {
        val voice = input()
        recorder.amplitudes.addAll(List(8) { 9_000 } + List(40) { 100 })
        reply(DictationOutcome.Transcribed("Remind me to water the ferns", null, null))
        voice.start(Endpointing.SPEECH_END, listener)
        scope.advanceTimeBy(5_000)
        scope.runCurrent()
        assertEquals(1, recorder.stopCount)
        assertEquals(listOf("Remind me to water the ferns"), listener.texts)
        assertEquals(listOf<VoiceInputEnd>(VoiceInputEnd.Finished), listener.ends)
    }

    @Test
    fun hands_free_recording_that_hears_nobody_ends_as_no_speech_without_uploading() {
        val voice = input()
        voice.start(Endpointing.SPEECH_END, listener)
        scope.advanceTimeBy(9_000)
        assertEquals(listOf<VoiceInputEnd>(VoiceInputEnd.NoSpeech), listener.ends)
        assertTrue(uploaded.isEmpty())
        assertTrue(recordings().isEmpty())
    }

    @Test
    fun a_manual_recording_never_ends_on_silence() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        scope.advanceTimeBy(30_000)
        assertTrue(listener.ends.isEmpty())
        voice.cancel()
    }

    @Test
    fun reaching_the_size_cap_sends_what_was_recorded() {
        val voice = input(maxAudioBytes = 1_000_000)
        voice.start(Endpointing.MANUAL, listener)
        // The index MPEG-4 writes at stop needs room under the gateway's limit.
        assertTrue(recorder.maxBytes in 500_000 until 1_000_000)
        reply(DictationOutcome.Transcribed("Long note", null, null))
        recorder.onLimit!!.invoke()
        scope.runCurrent()
        assertEquals(listOf("Long note"), listener.texts)
    }

    @Test
    fun stopping_before_anything_was_captured_finishes_empty_without_uploading() {
        recorder.captured = false
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        voice.stop()
        assertEquals(listOf<VoiceInputEnd>(VoiceInputEnd.Finished), listener.ends)
        assertTrue(uploaded.isEmpty())
        assertTrue(recordings().isEmpty())
    }

    @Test
    fun a_microphone_that_will_not_open_fails_without_retry() {
        recorder.opens = RecordingStart.FAILED
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        val end = listener.ends.single() as VoiceInputEnd.Failed
        assertFalse(end.failure.retryable)
        assertTrue(listener.levels.isEmpty())
        assertTrue(recordings().isEmpty())
    }

    @Test
    fun a_denied_microphone_ends_as_denied() {
        recorder.opens = RecordingStart.DENIED
        input().start(Endpointing.MANUAL, listener)
        assertEquals(listOf<VoiceInputEnd>(VoiceInputEnd.Denied), listener.ends)
        assertTrue(recordings().isEmpty())
    }

    @Test
    fun an_unavailable_transcriber_keeps_the_recording_and_rereads_the_status() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        reply(DictationOutcome.TranscriberUnavailable("No transcriber model can run."))
        voice.stop()
        scope.runCurrent()
        assertTrue((listener.ends.single() as VoiceInputEnd.Failed).failure.retryable)
        assertEquals(1, refusals)
        assertEquals(1, recordings().size)
    }

    @Test
    fun a_rejected_pairing_is_final_and_deletes_the_recording() {
        val voice = input()
        voice.start(Endpointing.MANUAL, listener)
        reply(DictationOutcome.Failed(GatewayException.Unauthorized()))
        voice.stop()
        scope.runCurrent()
        assertFalse((listener.ends.single() as VoiceInputEnd.Failed).failure.retryable)
        assertTrue(recordings().isEmpty())
        voice.retry()
        assertEquals(1, uploaded.size)
    }

    @Test
    fun each_outcome_maps_to_its_failure_words_and_retry_policy() {
        val retryable = listOf(
            DictationOutcome.Unreachable(GatewayException.Network(IOException("x"))),
            DictationOutcome.TranscriberUnavailable(null),
            DictationOutcome.Failed(GatewayException.ServerError(502, "bad gateway")),
            DictationOutcome.Failed(GatewayException.InvalidResponse("stream closed")),
        )
        val final = listOf(
            DictationOutcome.Disabled,
            DictationOutcome.Unsupported,
            DictationOutcome.TooLarge,
            DictationOutcome.Failed(GatewayException.Unauthorized()),
            DictationOutcome.Failed(GatewayException.Forbidden()),
            DictationOutcome.Failed(GatewayException.Decoding("bad json")),
            DictationOutcome.Failed(GatewayException.ServerError(400, "bad request")),
        )
        retryable.forEach { assertTrue(GatewayVoiceInput.failureFor(it).retryable) }
        final.forEach { assertFalse(GatewayVoiceInput.failureFor(it).retryable) }
        assertNull((retryable + final).map { GatewayVoiceInput.failureFor(it).message }.firstOrNull { it.isBlank() })
    }
}
