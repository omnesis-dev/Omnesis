// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import dev.omnesis.android.transport.client.VocabularyEntry
import dev.omnesis.android.transport.client.TranscriptionVocabularySnapshot
import dev.omnesis.android.ui.capture.RecognizerBackend
import dev.omnesis.android.ui.capture.RecognizerFactory
import dev.omnesis.android.voice.SpeechVocabulary
import java.io.File
import java.io.OutputStream
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** On-device transcription of a recording file, with the recognizer and the decoder scripted. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OnDeviceFileTranscriberTest {
    private val recording = File("recording.m4a")
    private val recognizers = ScriptedRecognizers()
    private val decoder = ScriptedDecoder()
    private val vocabulary = SpeechVocabulary()
    private var microphone = true

    private fun TestScope.transcriber(sdk: Int = Build.VERSION_CODES.UPSIDE_DOWN_CAKE) = OnDeviceFileTranscriber(
        vocabulary = vocabulary,
        decoder = decoder,
        recognizers = recognizers,
        microphoneGranted = { microphone },
        sdk = sdk,
        timeout = 90.seconds,
        main = UnconfinedTestDispatcher(testScheduler),
    )

    private fun results(text: String) = Bundle().apply {
        putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf(text))
    }

    @Test
    fun a_recording_is_read_as_the_audio_source_and_its_segments_joined() = runTest {
        recognizers.onStart = { listener ->
            listener.onSegmentResults(results("When is the budget review"))
            listener.onSegmentResults(results("and who is presenting"))
            listener.onEndOfSegmentedSession()
        }

        val transcript = transcriber().transcribe(recording, "en_GB")

        assertEquals("When is the budget review and who is presenting", transcript)
        val intent = recognizers.started.single()
        assertEquals("en-GB", intent.getStringExtra(RecognizerIntent.EXTRA_LANGUAGE))
        assertTrue(intent.hasExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE))
        assertEquals(16_000, intent.getIntExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 0))
        assertEquals(1, intent.getIntExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 0))
        assertEquals(RecognizerIntent.EXTRA_AUDIO_SOURCE, intent.getStringExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION))
        assertTrue(intent.getBooleanExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false))
        assertTrue("the recognizer is released", recognizers.backend.destroyed)
        assertTrue("the recording is closed", decoder.closed)
    }

    @Test
    fun a_recognizer_that_does_not_segment_ends_with_one_final_result() = runTest {
        recognizers.onStart = { it.onResults(results("Remember the blue folder")) }
        assertEquals("Remember the blue folder", transcriber().transcribe(recording, null))
    }

    @Test
    fun what_was_heard_before_an_error_is_kept_and_an_error_with_nothing_heard_is_no_transcript() = runTest {
        recognizers.onStart = { listener ->
            listener.onSegmentResults(results("Remember the blue folder"))
            listener.onError(SpeechRecognizer.ERROR_SPEECH_TIMEOUT)
        }
        assertEquals("Remember the blue folder", transcriber().transcribe(recording, "en-GB"))

        recognizers.onStart = { it.onError(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) }
        assertNull(transcriber().transcribe(recording, "en-GB"))
    }

    @Test
    fun vocabulary_hints_are_passed_only_once_the_language_is_confirmed_installed() = runTest {
        vocabulary.cache.warm(active = true, locale = "en-GB", scope = this) { _, _ ->
            TranscriptionVocabularySnapshot(
                enabled = true,
                entries = listOf(VocabularyEntry("Riverside Estate", 1.0)),
                refreshAfterSeconds = 600,
                expiresAfterSeconds = 3600,
            )
        }
        testScheduler.advanceUntilIdle()
        recognizers.onStart = { it.onResults(results("Meet at Riverside Estate")) }

        recognizers.installed = listOf("fr-FR")
        transcriber().transcribe(recording, "en-GB")
        assertFalse(recognizers.started.last().hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))

        recognizers.installed = listOf("en-GB")
        transcriber().transcribe(recording, "en-GB")
        assertEquals(
            arrayListOf("Riverside Estate"),
            recognizers.started.last().getStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS),
        )

        // A recognizer that never answers the support question is not trusted with hints.
        recognizers.installed = null
        transcriber().transcribe(recording, "en-GB")
        assertFalse(recognizers.started.last().hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
    }

    @Test
    fun a_recognizer_that_never_finishes_is_abandoned_after_the_timeout() = runTest {
        recognizers.onStart = {}
        assertNull(transcriber().transcribe(recording, "en-GB"))
        assertEquals(90_000, currentTime)
        assertTrue(recognizers.backend.destroyed)
    }

    @Test
    fun a_phone_that_cannot_transcribe_a_file_says_why_and_starts_nothing() = runTest {
        assertEquals(OnDeviceFileTranscriber.Availability.READY, transcriber().availability())

        val old = transcriber(sdk = Build.VERSION_CODES.S_V2)
        assertEquals(OnDeviceFileTranscriber.Availability.UNSUPPORTED, old.availability())
        assertNull(old.transcribe(recording, "en-GB"))

        recognizers.onDevice = false
        assertEquals(OnDeviceFileTranscriber.Availability.UNSUPPORTED, transcriber().availability())
        recognizers.onDevice = true

        microphone = false
        assertEquals(OnDeviceFileTranscriber.Availability.NEEDS_MICROPHONE, transcriber().availability())
        assertNull(transcriber().transcribe(recording, "en-GB"))
        assertTrue(recognizers.started.isEmpty())
    }

    @Test
    fun a_file_that_holds_no_decodable_audio_is_not_transcribed() = runTest {
        decoder.readable = false
        assertNull(transcriber().transcribe(recording, "en-GB"))
        assertTrue(recognizers.started.isEmpty())
    }

    @Test
    fun the_watch_locale_becomes_a_language_tag() {
        assertEquals("en-GB", OnDeviceFileTranscriber.languageTag("en_GB"))
        assertEquals("pt-BR", OnDeviceFileTranscriber.languageTag("pt-BR"))
        assertEquals(java.util.Locale.getDefault().toLanguageTag(), OnDeviceFileTranscriber.languageTag(null))
        assertEquals(java.util.Locale.getDefault().toLanguageTag(), OnDeviceFileTranscriber.languageTag("  "))
    }

    private class ScriptedDecoder : AudioDecoder {
        var readable = true
        var closed = false

        override fun open(file: File): DecodedAudio? = if (!readable) null else object : DecodedAudio {
            override val sampleRateHz = 16_000
            override val channels = 1
            override fun writeTo(out: OutputStream) = out.write(ByteArray(320))
            override fun close() {
                closed = true
            }
        }
    }

    private class ScriptedRecognizers : RecognizerFactory {
        var onDevice = true
        var installed: List<String>? = listOf("en-GB")
        var onStart: (RecognitionListener) -> Unit = {}
        val started = mutableListOf<Intent>()
        var backend = Backend()

        override fun available() = true
        override fun onDeviceAvailable() = onDevice
        override fun default(): RecognizerBackend = error("a recording is never sent to the default recognizer")
        override fun onDevice(): RecognizerBackend = Backend().also { backend = it }

        inner class Backend : RecognizerBackend {
            private var listener: RecognitionListener? = null
            var destroyed = false

            override fun listener(listener: RecognitionListener) {
                this.listener = listener
            }
            override fun start(intent: Intent) {
                started += intent
                onStart(requireNotNull(listener))
            }
            override fun support(intent: Intent, result: (List<String>?) -> Unit) {
                // A recognizer that never answers leaves the question open.
                if (installed != null) result(installed)
            }
            override fun stop() = Unit
            override fun cancel() = Unit
            override fun destroy() {
                destroyed = true
            }
        }
    }
}
