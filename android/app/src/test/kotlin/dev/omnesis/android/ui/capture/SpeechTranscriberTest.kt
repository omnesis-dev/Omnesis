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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
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
    private fun vocabulary(enabled: Boolean = true) = SpeechVocabulary().also { vocabulary ->
        runBlocking {
            vocabulary.cache.warm(enabled, Locale.getDefault().toLanguageTag(), this) { _, _ ->
                TranscriptionVocabularySnapshot(true, listOf(VocabularyEntry("Veltrio", 2.0)))
            }
        }
    }
    private fun setup(
        enabled: Boolean = true,
        vocabulary: SpeechVocabulary = vocabulary(enabled),
        support: OnDeviceSpeechSupport = OnDeviceSpeechSupport(),
        factory: Factory = Factory(),
    ): Pair<SpeechTranscriber, Factory> =
        SpeechTranscriber(ApplicationProvider.getApplicationContext<Context>(), vocabulary, support)
            .also { it.factory = factory } to factory

    /** Runs up to the first suspension, as a view model's scope does on the main thread. */
    private fun prepare(transcriber: SpeechTranscriber): Job =
        CoroutineScope(Dispatchers.Unconfined).launch { transcriber.prepare() }
    private val locale: String get() = Locale.getDefault().toLanguageTag()
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

    @Test fun preparingAheadHintsTheFirstSession() {
        val (transcriber, factory) = setup()
        val prepared = prepare(transcriber)
        assertFalse(prepared.isCompleted)
        factory.locals.single().callback!!.invoke(listOf(locale))
        assertTrue(prepared.isCompleted)
        assertTrue(factory.locals.single().destroyed)

        transcriber.start(listener)
        assertEquals(listOf("Veltrio"), factory.locals.last().intent!!.getStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        assertTrue(factory.defaults.isEmpty())
        transcriber.cancel()
    }

    @Test fun preparingWithoutVocabularyAsksNoRecognizer() {
        val (transcriber, factory) = setup(false)
        assertTrue(prepare(transcriber).isCompleted)
        assertTrue(factory.locals.isEmpty())
    }

    @Test @Config(sdk = [32]) fun preparingOnOlderAndroidAsksNoRecognizer() {
        val (transcriber, factory) = setup()
        assertTrue(prepare(transcriber).isCompleted)
        assertTrue(factory.locals.isEmpty())
    }

    @Test fun preparingForAnUninstalledLanguageLeavesTheFirstSessionOnTheDefaultRecognizer() {
        val (transcriber, factory) = setup()
        val prepared = prepare(transcriber)
        factory.locals.single().callback!!.invoke(listOf("zz-ZZ"))
        assertTrue(prepared.isCompleted)

        transcriber.start(listener)
        assertFalse(factory.defaults.single().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        transcriber.cancel()
    }

    @Test fun aCheckOutlivesTheSessionThatStartsWhileItIsPending() {
        val (transcriber, factory) = setup()
        val prepared = prepare(transcriber)
        // The microphone starts before the recognizer has answered: unhinted, on the default.
        transcriber.start(listener)
        assertFalse(factory.defaults.single().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        transcriber.cancel()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, factory.locals.size)

        factory.locals.single().callback!!.invoke(listOf(locale))
        assertTrue(prepared.isCompleted)
        transcriber.start(listener)
        assertEquals(listOf("Veltrio"), factory.locals.last().intent!!.getStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        transcriber.cancel()
    }

    @Test fun anUnansweredCheckReleasesItsWaiterAndItsRecognizer() {
        val (transcriber, factory) = setup()
        val prepared = prepare(transcriber)
        shadowOf(Looper.getMainLooper()).idleFor(11, java.util.concurrent.TimeUnit.SECONDS)
        assertTrue(prepared.isCompleted)
        assertTrue(factory.locals.single().destroyed)

        // An answer that arrives after the recognizer was released confirms nothing.
        factory.locals.single().callback!!.invoke(listOf(locale))
        transcriber.start(listener)
        assertFalse(factory.defaults.single().intent!!.hasExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        transcriber.cancel()
    }

    @Test fun aConfirmationHoldsForEveryTranscriberSharingTheSupport() {
        val vocabulary = vocabulary()
        val support = OnDeviceSpeechSupport()
        val factory = Factory()
        val (first, _) = setup(vocabulary = vocabulary, support = support, factory = factory)
        confirm(first, factory)
        first.cancel()

        val (second, _) = setup(vocabulary = vocabulary, support = support, factory = factory)
        second.start(listener)
        assertEquals(listOf("Veltrio"), factory.locals.last().intent!!.getStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS))
        assertEquals(1, factory.defaults.size)
        second.cancel()
    }

    @Test fun waitersOnOneCheckAreAllReleasedByItsAnswer() {
        val vocabulary = vocabulary()
        val support = OnDeviceSpeechSupport()
        val factory = Factory()
        val (first, _) = setup(vocabulary = vocabulary, support = support, factory = factory)
        val (second, _) = setup(vocabulary = vocabulary, support = support, factory = factory)
        val a = prepare(first)
        val b = prepare(second)
        assertEquals(1, factory.locals.size)
        factory.locals.single().callback!!.invoke(listOf(locale))
        assertTrue(a.isCompleted && b.isCompleted)
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
