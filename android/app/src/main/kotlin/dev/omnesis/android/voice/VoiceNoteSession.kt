// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import dev.omnesis.android.notes.VoiceNoteAudio
import dev.omnesis.android.notes.VoiceNoteFiles
import dev.omnesis.android.transport.dto.DictationStatusDto
import dev.omnesis.android.ui.capture.RecognizerAudioInput
import kotlinx.coroutines.flow.StateFlow

/**
 * The audio of one Tell Omnesis dictation, kept so the note can be sent with it for the
 * gateway to transcribe later. The screen keeps its live on-device transcript: each
 * recognizer session reads a copy of the recording through [recognizerInput]. All calls
 * and [Listener] callbacks happen on the main thread.
 */
interface VoiceNoteSession {
    /** Audio for the next recognizer session, or null once the recording was [Listener.onLost]. */
    fun recognizerInput(): RecognizerAudioInput?

    /** Stops the microphone; [resume] continues the same recording. */
    fun pause()

    /** False when the microphone could not be reopened. */
    fun resume(): Boolean

    /** Stops recording and hands over the file; null when nothing usable was recorded. */
    fun finish(): VoiceNoteAudio?

    /** Stops recording and deletes it. */
    fun discard()

    var listener: Listener?

    interface Listener {
        /** Each chunk's peak amplitude (0–32767) and the audio time so far, for end-of-speech detection. */
        fun onPeak(peak: Int, elapsedMs: Long) {}

        /** The recording hit the gateway's size or the duration cap and stopped growing. */
        fun onLimitReached() {}

        /**
         * The microphone was taken from the recording — a recognizer that ignored the audio
         * it was handed and opened the microphone itself. The recording is already discarded.
         */
        fun onLost() {}
    }
}

/** Starts a [VoiceNoteSession] when the paired gateway transcribes voice notes. */
fun interface VoiceNoteSessions {
    /**
     * A recording for a new dictation, or null when the note should carry the phone's
     * transcript only: gateway dictation inactive, Android older than 13 (no way to share
     * the microphone with the recognizer), or the microphone unavailable.
     */
    fun begin(): VoiceNoteSession?
}

/** The app's [VoiceNoteSessions]: decides from the gateway's `/status` dictation gate at each start. */
class GatewayVoiceNoteSessions(
    private val context: Context,
    private val gatewayStatus: StateFlow<DictationStatusDto?>,
    private val files: VoiceNoteFiles,
) : VoiceNoteSessions {

    override fun begin(): VoiceNoteSession? {
        val status = gatewayStatus.value?.takeIf { it.active } ?: return null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
        val session = RecordingVoiceNoteSession(context, files.newRecording("wav"), status.maxAudioBytes)
        return session.takeIf { it.start() }
    }
}

private class RecordingVoiceNoteSession(
    context: Context,
    private val file: java.io.File,
    maxAudioBytes: Long,
) : VoiceNoteSession {

    private val main = Handler(Looper.getMainLooper())
    override var listener: VoiceNoteSession.Listener? = null
    private var lost = false

    private val recorder = VoiceNoteRecorder(
        source = AudioRecordPcmSource(context) { main.post { onSilenced() } },
        file = file,
        maxFileBytes = maxAudioBytes,
        maxDurationMs = MAX_DURATION_MS,
        onPeak = { peak, elapsed -> main.post { if (!lost) listener?.onPeak(peak, elapsed) } },
        onLimitReached = { main.post { if (!lost) listener?.onLimitReached() } },
    )

    fun start(): Boolean = recorder.start().also { if (!it) file.delete() }

    override fun recognizerInput(): RecognizerAudioInput? {
        if (lost) return null
        val (read, write) = ParcelFileDescriptor.createPipe()
        recorder.attachSink(ParcelFileDescriptor.AutoCloseOutputStream(write))
        return RecognizerAudioInput(read, AudioRecordPcmSource.SAMPLE_RATE_HZ)
    }

    override fun pause() = recorder.pause()

    override fun resume(): Boolean = !lost && recorder.resume()

    override fun finish(): VoiceNoteAudio? {
        if (lost) return null
        lost = true
        return if (recorder.finish()) {
            VoiceNoteAudio(file, WavWriter.MIME_TYPE)
        } else {
            file.delete()
            null
        }
    }

    override fun discard() {
        if (lost) return
        lost = true
        recorder.discard()
    }

    private fun onSilenced() {
        if (lost) return
        discard()
        listener?.onLost()
    }

    private companion object {
        /** A dictated note, not a meeting. */
        const val MAX_DURATION_MS = 5 * 60 * 1000L
    }
}
