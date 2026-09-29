// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

/**
 * One dictation, from [start] until [Listener.onEnded]. Every surface that turns
 * speech into text — Tell Omnesis, the Assistant action, the agent composer —
 * drives this interface, so it reads the same callbacks whichever engine does the
 * work:
 *
 * - [OnDeviceVoiceInput] runs the platform recognizer and streams live text
 *   ([Listener.onPartial] / [Listener.onText]) while it listens.
 * - [GatewayVoiceInput] records audio ([Listener.onRecording]), then sends it to
 *   the gateway's transcriber ([Listener.onTranscribing]) and delivers the
 *   transcript as one [Listener.onText].
 *
 * All calls come from the main thread, and callbacks arrive on it. After [cancel],
 * or once [Listener.onEnded] reported anything but a retryable failure, the input
 * reports nothing more.
 */
interface VoiceInput {
    /** Whether this engine can run on this device at all. */
    fun isAvailable(): Boolean

    fun start(endpointing: Endpointing, listener: Listener)

    /**
     * Stops capturing. Speech already heard is still delivered: on-device as the
     * recognizer's final text, on the gateway once the recording is transcribed.
     */
    fun stop()

    /** Abandons the dictation: no further callbacks, and any kept recording is deleted. */
    fun cancel()

    /**
     * Sends the kept recording again after a [VoiceInputEnd.Failed] whose failure is
     * [DictationFailure.retryable]. Does nothing otherwise.
     */
    fun retry()

    interface Listener {
        /** The recognizer's in-flight hypothesis for the current utterance; replaces the previous one. */
        fun onPartial(text: String) {}

        /** Text that is final for this dictation; the surface appends it. */
        fun onText(text: String)

        /**
         * The microphone is recording for the gateway. Reported once as soon as it
         * opens, then several times a second. [level] is 0–1.
         */
        fun onRecording(level: Float, elapsedMs: Long) {}

        /** Recording finished; the gateway is transcribing it. */
        fun onTranscribing() {}

        fun onEnded(end: VoiceInputEnd)
    }
}

/** When a dictation stops capturing on its own. */
enum class Endpointing {
    /** Only when the surface calls [VoiceInput.stop] (or a size or duration cap is reached). */
    MANUAL,

    /**
     * When the speaker finishes — for hands-free surfaces that act on the result.
     * A dictation that hears nothing ends as [VoiceInputEnd.NoSpeech] rather than
     * waiting forever.
     */
    SPEECH_END,
}

/** How a dictation ended. */
sealed interface VoiceInputEnd {
    /** Everything heard was delivered through [VoiceInput.Listener.onText]. */
    data object Finished : VoiceInputEnd

    /** Nobody spoke before the hands-free dictation gave up. */
    data object NoSpeech : VoiceInputEnd

    /** A recognizer fault ended a hands-free dictation; trying again may work. */
    data object Fault : VoiceInputEnd

    /** RECORD_AUDIO is not granted. */
    data object Denied : VoiceInputEnd

    /** The recognizer supports the language but its offline model is not installed. */
    data object LanguageNotDownloaded : VoiceInputEnd

    /** The recognizer has no support for the device's language. */
    data object LanguageNotSupported : VoiceInputEnd

    /** Speech recognition is not usable on this device. */
    data object Unavailable : VoiceInputEnd

    /** The gateway could not transcribe the recording. */
    data class Failed(val failure: DictationFailure) : VoiceInputEnd
}

/**
 * Why gateway dictation failed, in words for the person dictating. When [retryable],
 * the recording is kept so [VoiceInput.retry] can send it again; otherwise it is
 * already deleted.
 */
data class DictationFailure(val message: String, val retryable: Boolean)
