// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
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

    private var recognizer: SpeechRecognizer? = null

    open fun isAvailable(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    /** Starts one recognition session. The caller restarts on [Listener.onEnded] to keep listening. */
    open fun start(listener: Listener) {
        cancel()
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
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
                listener.onEnded(endReasonFor(error))
            }

            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
        r.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            },
        )
    }

    /** Stops capturing audio; any already-heard speech still delivers a final result. */
    open fun stop() {
        recognizer?.stopListening()
    }

    /** Abandons the session without waiting for results and releases the recognizer. */
    open fun cancel() {
        recognizer?.let {
            it.cancel()
            it.destroy()
        }
        recognizer = null
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
