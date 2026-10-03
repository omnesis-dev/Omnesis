// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import java.util.Locale
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.annotation.RequiresApi
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject

/**
 * Thin wrapper over the platform [SpeechRecognizer] for quick-capture dictation.
 * Free-form model, partial results on, offline preferred. The installed speech
 * recognition service decides whether that preference can be honored. All calls
 * must come from the main thread — the platform recognizer requires it. Open so
 * ViewModel tests can substitute a scripted fake for the platform recognizer.
 */
open class SpeechTranscriber @Inject constructor(
    @ApplicationContext private val context: Context,
    private val vocabulary: dev.omnesis.android.voice.SpeechVocabulary = dev.omnesis.android.voice.SpeechVocabulary(),
) {

    interface Listener {
        /** In-flight hypothesis for the current utterance (replaces the previous partial). */
        fun onPartial(text: String)

        /** Final text for the finished utterance. */
        fun onFinal(text: String)

        /** Recognition session ended (final result, timeout, or error) — mic is no longer hot. */
        fun onEnded(reason: EndReason)
    }

    /**
     * Why a session ended, which decides whether the caller may start another.
     * The language and permission reasons cannot clear on their own, so the
     * caller must stop and say what is wrong — restarting through them would
     * hold the mic hot forever while nothing is ever transcribed.
     */
    enum class EndReason {
        /** Final result, or ordinary silence — starting another session is fine. */
        NORMAL,

        /**
         * A recoverable recognizer fault (busy, client, server, audio). Worth
         * retrying, but these end the session on arrival rather than after
         * listening, so an unbounded retry spins the mic instead of waiting.
         */
        FAULT,

        /** RECORD_AUDIO is not granted. */
        DENIED,

        /**
         * The recognizer supports this locale but its language model is not
         * available on the device. Installing the language pack fixes it.
         */
        LANGUAGE_NOT_DOWNLOADED,

        /** The recognizer has no support for this locale at all. */
        LANGUAGE_NOT_SUPPORTED,
    }

    private var recognizer: RecognizerBackend? = null
    internal var factory: RecognizerFactory = PlatformRecognizerFactory(context)
    private var purpose = "dictation"
    private val supportedLocales = mutableMapOf<String, Long>()
    private val checkedLocales = mutableMapOf<String, Long>()
    private val supportProbes = mutableMapOf<RecognizerBackend, String>()
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    /** Context for this capture, independent of whether gateway voice-note storage is enabled. */
    fun setPurpose(value: String) {
        require(value == "dictation" || value == "agent")
        purpose = value
    }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun preflight(locale: String) {
        val now = android.os.SystemClock.elapsedRealtime()
        if (checkedLocales[locale]?.let { now - it < 300_000 } == true) return
        checkedLocales.clear()
        checkedLocales[locale] = now
        supportedLocales.keys.retainAll(setOf(locale))
        val probe = runCatching { factory.onDevice() }.getOrNull() ?: return
        supportProbes[probe] = locale
        val release = Runnable { if (supportProbes.remove(probe) != null) probe.destroy() }
        handler.postDelayed(release, 10_000)
        try {
            probe.support(speechIntent(emptyList(), null, locale)) { installed ->
                if (probe in supportProbes && installed?.any { it.equals(locale, ignoreCase = true) } == true) {
                    supportedLocales[locale] = android.os.SystemClock.elapsedRealtime()
                }
                handler.removeCallbacks(release)
                release.run()
            }
        } catch (_: Exception) { handler.removeCallbacks(release); release.run() }
    }

    /** The pipe the current session reads from, when the app is recording the microphone itself. */
    private var audioInput: RecognizerAudioInput? = null

    open fun isAvailable(): Boolean = factory.available()

    /** Starts one recognition session. The caller restarts on [Listener.onEnded] to keep listening. */
    open fun start(listener: Listener) = begin(listener, audio = null)

    /**
     * Starts one recognition session that reads [audio] instead of opening the microphone
     * (`EXTRA_AUDIO_SOURCE`, Android 13+) — for when the app records the microphone and
     * shares it. A recognizer that does not take the extra either fails the session or
     * opens the microphone anyway; callers watch for both.
     */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    open fun startWithAudio(listener: Listener, audio: RecognizerAudioInput) = begin(listener, audio)

    private fun begin(listener: Listener, audio: RecognizerAudioInput?) {
        cancel()
        audioInput = audio
        val locale = Locale.getDefault().toLanguageTag()
        val hints = vocabulary.cache.phrases(purpose, locale)
        val onDeviceAvailable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            hints.isNotEmpty() && factory.onDeviceAvailable()
        val local = if (onDeviceAvailable && supportedLocales[locale]?.let { android.os.SystemClock.elapsedRealtime() - it < 300_000 } == true) {
            runCatching { factory.onDevice() }.getOrNull()
        } else null
        val r = local ?: factory.default()
        recognizer = r
        r.listener(object : RecognitionListener {
            override fun onPartialResults(partialResults: Bundle?) {
                firstResult(partialResults)?.let(listener::onPartial)
            }

            override fun onResults(results: Bundle?) {
                firstResult(results)?.let(listener::onFinal)
                listener.onEnded(EndReason.NORMAL)
            }

            override fun onError(error: Int) {
                // NO_MATCH / SPEECH_TIMEOUT are ordinary silence, not failures; the
                // terminal cases are surfaced so the UI can explain the fix and
                // fall back to keyboard-only.
                if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    Log.i(TAG, "Speech recognition ended with error $error")
                }
                if (local != null && (error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE || error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED)) {
                    supportedLocales.remove(locale)
                    // The caller's existing bounded retry starts the default provider unhinted.
                    // Do not replay consumed audio or reopen the microphone here.
                    listener.onEnded(EndReason.FAULT)
                } else listener.onEnded(endReasonFor(error))
            }

            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
        r.start(speechIntent(if (local != null) hints else emptyList(), audio, if (local != null) locale else null))
        // Support discovery does no microphone work and never holds up microphone startup.
        if (onDeviceAvailable && local == null) handler.post { if (recognizer === r) preflight(locale) }
    }

    /** Biasing strings are supplied only by the verified on-device branch above. */
    internal fun speechIntent(hints: List<String>, audio: RecognizerAudioInput?, locale: String? = null): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            if (locale != null) putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (hints.isNotEmpty()) putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, ArrayList(hints))
                if (audio != null) {
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, audio.pipe)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                    putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, audio.sampleRateHz)
                }
            }
        }

    /** Stops capturing audio; any already-heard speech still delivers a final result. */
    open fun stop() {
        recognizer?.stop()
    }

    /** Abandons the session without waiting for results and releases the recognizer. */
    open fun cancel() {
        supportProbes.forEach { (probe, locale) ->
            checkedLocales.remove(locale)
            probe.destroy()
        }
        supportProbes.clear()
        handler.removeCallbacksAndMessages(null)
        recognizer?.let {
            it.cancel()
            it.destroy()
        }
        recognizer = null
        audioInput?.close()
        audioInput = null
    }

    /**
     * Classifies a platform error code. The language codes are reported by the
     * recognizer implementation, which ships in an updatable app and so emits
     * them on platform versions older than the SDK constants themselves.
     */
    private fun endReasonFor(error: Int): EndReason = when (error) {
        // Nobody spoke. The recognizer listened first, so this cannot spin.
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> EndReason.NORMAL
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> EndReason.DENIED
        SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> EndReason.LANGUAGE_NOT_DOWNLOADED
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> EndReason.LANGUAGE_NOT_SUPPORTED
        else -> EndReason.FAULT
    }

    private fun firstResult(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }

    private companion object {
        const val TAG = "Omnesis:capture"
    }
}

/**
 * The read end of a pipe carrying 16-bit mono PCM at [sampleRateHz], handed to one
 * recognition session in place of the microphone. The session's transcriber closes it.
 */
class RecognizerAudioInput(val pipe: ParcelFileDescriptor, val sampleRateHz: Int) {
    fun close() {
        runCatching { pipe.close() }
    }
}
