// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import android.content.Context
import android.content.Intent
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.voice.SpeechVocabulary
import dev.omnesis.android.transport.client.TranscriptionVocabularySnapshot
import dev.omnesis.android.transport.client.VocabularyEntry
import java.util.Locale
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SpeechTranscriberTest {
    private class Engine : RecognizerBackend {
        var intent: Intent? = null
        var callback: ((List<String>?) -> Unit)? = null
        var speechListener: RecognitionListener? = null
        var destroyed = false
        override fun listener(listener: RecognitionListener) { speechListener = listener }
        override fun start(intent: Intent) { this.intent = intent }
        override fun support(intent: Intent, result: (List<String>?) -> Unit) {
            assertFalse(intent.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
            callback = result
        }
        override fun stop() = Unit
        override fun cancel() = Unit
        override fun destroy() { destroyed = true }
    }
    private class Factory : RecognizerFactory {
        val defaults = mutableListOf<Engine>()
        val locals = mutableListOf<Engine>()
        var failLocal = false
        override fun available() = true
        override fun onDeviceAvailable() = true
        override fun default() = Engine().also { defaults.add(it) }
        override fun onDevice(): Engine {
            if (failLocal) throw UnsupportedOperationException()
            return Engine().also { locals.add(it) }
        }
    }
    private val listener = object : SpeechTranscriber.Listener {
        override fun onPartial(text: String) = Unit
        override fun onFinal(text: String) = Unit
        override fun onEnded(reason: SpeechTranscriber.EndReason) = Unit
    }
    private fun setup(enabled: Boolean = true): Pair<SpeechTranscriber, Factory> {
        val vocabulary = SpeechVocabulary()
        runBlocking {
            vocabulary.cache.warm(enabled, Locale.getDefault().toLanguageTag(), this) { _, _ ->
                TranscriptionVocabularySnapshot(true, listOf(VocabularyEntry("Veltrio", 2.0)))
            }
        }
        val factory = Factory()
        return SpeechTranscriber(ApplicationProvider.getApplicationContext<Context>(), vocabulary).also { it.factory = factory } to factory
    }
    private fun confirm(transcriber: SpeechTranscriber, factory: Factory) {
        transcriber.start(listener)
        assertTrue(factory.locals.isEmpty()) // Provider discovery is posted after microphone start.
        assertFalse(factory.defaults.single().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        shadowOf(Looper.getMainLooper()).idle()
        factory.locals.single().callback!!.invoke(listOf(Locale.getDefault().toLanguageTag()))
    }

    @Test fun verifiedOnDeviceReceivesHintsAndDefaultNeverDoes() {
        val (transcriber, factory) = setup()
        confirm(transcriber, factory)
        transcriber.start(listener)
        assertEquals(listOf("Veltrio"), factory.locals.last().intent!!.getStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        assertEquals(1, factory.defaults.size)
        transcriber.cancel()
    }

    @Test fun offLeavesExistingProviderAndIntentUntouched() {
        val (transcriber, factory) = setup(false)
        transcriber.start(listener)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(factory.locals.isEmpty())
        assertFalse(factory.defaults.single().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        assertFalse(factory.defaults.single().intent!!.hasExtra(RecognizerIntent.EXTRA_LANGUAGE))
        transcriber.cancel()
    }

    @Test @Config(sdk = [32]) fun olderAndroidNeverSendsHints() {
        val (transcriber, factory) = setup()
        transcriber.start(listener)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(factory.locals.isEmpty())
        assertFalse(factory.defaults.single().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        transcriber.cancel()
    }

    @Test fun unsupportedLanguageKeepsDefaultProvider() {
        val (transcriber, factory) = setup()
        transcriber.start(listener)
        shadowOf(Looper.getMainLooper()).idle()
        factory.locals.single().callback!!.invoke(listOf("zz-ZZ"))
        transcriber.start(listener)
        assertEquals(2, factory.defaults.size)
        assertFalse(factory.defaults.last().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        transcriber.cancel()
    }

    @Test fun canceledProbeCannotConfirmAndCanBeRetried() {
        val (transcriber, factory) = setup()
        transcriber.start(listener)
        shadowOf(Looper.getMainLooper()).idle()
        val old = factory.locals.single()
        transcriber.cancel()
        old.callback!!.invoke(listOf(Locale.getDefault().toLanguageTag()))
        transcriber.start(listener)
        assertEquals(2, factory.defaults.size)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(2, factory.locals.size)
        transcriber.cancel()
    }

    @Test fun onDeviceCreationFailureFallsBackUnhinted() {
        val (transcriber, factory) = setup()
        confirm(transcriber, factory)
        factory.failLocal = true
        transcriber.start(listener)
        assertFalse(factory.defaults.last().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        transcriber.cancel()
    }

    @Test fun pipeAudioExtrasSurviveOnDeviceHintAttachment() {
        val (transcriber, factory) = setup()
        confirm(transcriber, factory)
        val pipe = ParcelFileDescriptor.createPipe()
        try {
            transcriber.startWithAudio(listener, RecognizerAudioInput(pipe[0], 16000))
            val intent = factory.locals.last().intent!!
            assertTrue(intent.hasExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE))
            assertEquals(16000, intent.getIntExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 0))
            assertEquals(1, intent.getIntExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 0))
            assertEquals(listOf("Veltrio"), intent.getStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        } finally { transcriber.cancel(); pipe[1].close() }
    }

    @Test fun languagePackRemovalDoesNotReplayOrReopenMicrophone() {
        val (transcriber, factory) = setup()
        confirm(transcriber, factory)
        transcriber.start(listener)
        factory.locals.last().speechListener!!.onError(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE)
        assertEquals(1, factory.defaults.size)
        transcriber.start(listener)
        assertEquals(2, factory.defaults.size)
        assertFalse(factory.defaults.last().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        transcriber.cancel()
    }
    @Test fun installedLanguageConfirmationExpiresWithoutChangingDefaultFallback() {
        val (transcriber, factory) = setup()
        confirm(transcriber, factory)
        shadowOf(Looper.getMainLooper()).idleFor(6, java.util.concurrent.TimeUnit.MINUTES)
        transcriber.start(listener)
        assertEquals(2, factory.defaults.size)
        assertFalse(factory.defaults.last().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        transcriber.cancel()
    }

}
