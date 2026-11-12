// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.device

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import dev.omnesis.android.wear.core.SpeechEngine

/**
 * [SpeechEngine] over the system text-to-speech service, which is started on
 * the first utterance. Listener callbacks are posted to the main thread.
 */
class AndroidSpeechEngine(private val context: Context) : SpeechEngine {
    private val main = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var ready = false

    /** The utterance waiting for the service to finish starting. */
    private var waiting: Pair<String, Int>? = null

    override var listener: SpeechEngine.Listener? = null

    override fun speak(text: String, id: Int) {
        if (ready) {
            utter(text, id)
            return
        }
        waiting = text to id
        if (tts == null) tts = TextToSpeech(context.applicationContext, ::initialized)
    }

    override fun stop() {
        waiting = null
        if (ready) tts?.stop()
    }

    private fun initialized(status: Int) {
        main.post {
            val queued = waiting
            waiting = null
            if (status != TextToSpeech.SUCCESS) {
                tts = null
                queued?.let { listener?.onStopped(it.second) }
                return@post
            }
            ready = true
            tts?.setOnUtteranceProgressListener(Progress())
            queued?.let { utter(it.first, it.second) }
        }
    }

    private fun utter(text: String, id: Int) {
        // Ranges are offsets into what is spoken, so a cut answer still highlights correctly.
        val spoken = text.take(TextToSpeech.getMaxSpeechInputLength())
        if (tts?.speak(spoken, TextToSpeech.QUEUE_FLUSH, null, id.toString()) != TextToSpeech.SUCCESS) {
            listener?.onStopped(id)
        }
    }

    private inner class Progress : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) = Unit

        override fun onRangeStart(utteranceId: String, start: Int, end: Int, frame: Int) {
            report(utteranceId) { onRange(it, end) }
        }

        override fun onDone(utteranceId: String) {
            report(utteranceId) { onDone(it) }
        }

        override fun onStop(utteranceId: String, interrupted: Boolean) {
            report(utteranceId) { onStopped(it) }
        }

        @Deprecated("The platform still requires the override")
        override fun onError(utteranceId: String) {
            report(utteranceId) { onStopped(it) }
        }

        override fun onError(utteranceId: String, errorCode: Int) {
            report(utteranceId) { onStopped(it) }
        }

        private fun report(utteranceId: String, event: SpeechEngine.Listener.(Int) -> Unit) {
            val id = utteranceId.toIntOrNull() ?: return
            main.post { listener?.event(id) }
        }
    }
}
