// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.ui.capture.SpeechTranscriber

/**
 * Dictation on the phone's own recognizer. The platform recognizer works one
 * utterance at a time, so this input chains its sessions into one dictation:
 *
 * - [Endpointing.MANUAL] restarts after every utterance until [stop], so the mic
 *   stays hot across pauses.
 * - [Endpointing.SPEECH_END] ends after the first utterance that produced text,
 *   and restarts through silence until someone speaks.
 *
 * A partial the recognizer never finalized (a session ending on an error, or a
 * restart) is delivered as text before the next session starts, so its words are
 * never replaced by the next session's first partial.
 */
class OnDeviceVoiceInput(private val transcriber: SpeechTranscriber) : VoiceInput {

    private var listener: VoiceInput.Listener? = null
    private var endpointing = Endpointing.MANUAL

    /** True until [stop]: sessions restart after each utterance while it holds. */
    private var wantListening = false

    /** Whether this dictation delivered any text yet. */
    private var heardText = false

    private var partial = ""

    /**
     * Consecutive sessions that ended on a recognizer fault. Faults end a session
     * on arrival, so retrying without a bound spins the mic at full speed; past
     * [MAX_CONSECUTIVE_FAULTS] the recognizer is treated as unusable. Ordinary
     * silence never counts.
     */
    private var consecutiveFaults = 0

    /** Identifies the recognizer session whose callbacks are current; bumped on every restart and cancel. */
    private var session = 0L

    override fun isAvailable(): Boolean = transcriber.isAvailable()

    override fun start(endpointing: Endpointing, listener: VoiceInput.Listener) {
        this.listener = listener
        this.endpointing = endpointing
        wantListening = true
        heardText = false
        partial = ""
        consecutiveFaults = 0
        beginSession()
    }

    override fun stop() {
        if (listener == null) return
        // The partial stays uncommitted: the recognizer still delivers the
        // utterance's final result after stop(), which replaces it.
        wantListening = false
        transcriber.stop()
    }

    override fun cancel() {
        listener = null
        wantListening = false
        session++
        transcriber.cancel()
    }

    override fun retry() = Unit

    private fun beginSession() {
        session++
        transcriber.start(sessionListener(session))
    }

    private fun sessionListener(id: Long) = object : SpeechTranscriber.Listener {
        override fun onPartial(text: String) {
            val out = listener?.takeIf { id == session } ?: return
            partial = text
            out.onPartial(text)
        }

        override fun onFinal(text: String) {
            val out = listener?.takeIf { id == session } ?: return
            partial = ""
            heardText = true
            out.onText(text)
        }

        override fun onEnded(reason: SpeechTranscriber.EndReason) {
            if (listener == null || id != session) return
            consecutiveFaults = if (reason == SpeechTranscriber.EndReason.FAULT) consecutiveFaults + 1 else 0
            when (reason) {
                SpeechTranscriber.EndReason.DENIED -> end(VoiceInputEnd.Denied)
                SpeechTranscriber.EndReason.LANGUAGE_NOT_DOWNLOADED -> end(VoiceInputEnd.LanguageNotDownloaded)
                SpeechTranscriber.EndReason.LANGUAGE_NOT_SUPPORTED -> end(VoiceInputEnd.LanguageNotSupported)
                SpeechTranscriber.EndReason.FAULT -> when {
                    // A hands-free surface has nobody watching a retry loop; say so at once.
                    endpointing == Endpointing.SPEECH_END -> end(VoiceInputEnd.Fault)
                    consecutiveFaults >= MAX_CONSECUTIVE_FAULTS -> end(VoiceInputEnd.Unavailable)
                    else -> continueOrFinish()
                }
                SpeechTranscriber.EndReason.NORMAL -> continueOrFinish()
            }
        }
    }

    private fun continueOrFinish() {
        commitPartial()
        val done = !wantListening || (endpointing == Endpointing.SPEECH_END && heardText)
        if (done) end(VoiceInputEnd.Finished) else beginSession()
    }

    private fun commitPartial() {
        val text = partial
        partial = ""
        if (text.isNotBlank()) {
            heardText = true
            listener?.onText(text)
        }
    }

    private fun end(end: VoiceInputEnd) {
        commitPartial()
        val out = listener ?: return
        listener = null
        wantListening = false
        session++
        // Releases the recognizer binding: each dictation gets a fresh transcriber, so one
        // left open here would stay bound to the speech service after its dictation ended.
        transcriber.cancel()
        out.onEnded(end)
    }

    private companion object {
        /** Transient recognizer faults do happen; a run this long is not transient. */
        const val MAX_CONSECUTIVE_FAULTS = 5
    }
}
