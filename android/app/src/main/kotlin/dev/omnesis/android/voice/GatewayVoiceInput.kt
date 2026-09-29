// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.DictationOutcome
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Gateway dictation: records the microphone into a cache file, then sends the
 * file to the gateway's transcriber and delivers the transcript.
 *
 * The platform recognizer cannot share the microphone with a recording, so there
 * is no on-device draft to fall back on. A failed transcription that might succeed
 * later keeps the recording for [retry]; the file is deleted after a transcript,
 * on [cancel], and on any failure a retry cannot fix.
 *
 * One dictation per instance. [scope] owns the level sampling and the upload, so a
 * surface that goes away takes them with it.
 */
class GatewayVoiceInput(
    private val recorder: AudioRecorder,
    private val newRecordingFile: () -> File,
    private val transcribe: suspend (File) -> DictationOutcome,
    private val scope: CoroutineScope,
    /** The gateway's advertised `maxAudioBytes`; 0 when it advertised none. */
    private val maxAudioBytes: Long,
    /**
     * Re-reads the gateway's dictation status. Called when the gateway says dictation is
     * off, absent or cannot run, so the next dictation picks its engine from the truth.
     */
    private val refreshStatus: suspend () -> Unit,
    /** Monotonic milliseconds. */
    private val clock: () -> Long,
    private val maxDurationMs: Long = MAX_DURATION_MS,
) : VoiceInput {

    private enum class Phase { READY, RECORDING, TRANSCRIBING, FAILED, ENDED }

    private var phase = Phase.READY
    private var listener: VoiceInput.Listener? = null
    private var file: File? = null
    private var startedAtMs = 0L
    private var detector: SilenceDetector? = null
    private var sampling: Job? = null
    private var upload: Job? = null

    override fun isAvailable(): Boolean = true

    override fun start(endpointing: Endpointing, listener: VoiceInput.Listener) {
        check(phase == Phase.READY) { "a GatewayVoiceInput runs one dictation" }
        this.listener = listener
        val target = newRecordingFile()
        file = target
        val opened = recorder.start(
            file = target,
            maxBytes = recordingByteCap(),
            maxDurationMs = maxDurationMs,
            onLimitReached = { if (phase == Phase.RECORDING) finishRecording() },
        )
        if (opened != RecordingStart.STARTED) {
            deleteRecording()
            end(
                if (opened == RecordingStart.DENIED) {
                    VoiceInputEnd.Denied
                } else {
                    VoiceInputEnd.Failed(DictationFailure("Couldn't start recording.", retryable = false))
                },
            )
            return
        }
        phase = Phase.RECORDING
        startedAtMs = clock()
        detector = if (endpointing == Endpointing.SPEECH_END) SilenceDetector() else null
        listener.onRecording(0f, 0)
        sampling = scope.launch {
            while (isActive) {
                delay(SAMPLE_INTERVAL_MS)
                sample()
            }
        }
    }

    override fun stop() {
        if (phase == Phase.RECORDING) finishRecording()
    }

    override fun cancel() {
        val wasRecording = phase == Phase.RECORDING
        phase = Phase.ENDED
        listener = null
        sampling?.cancel()
        upload?.cancel()
        if (wasRecording) recorder.release()
        deleteRecording()
    }

    override fun retry() {
        if (phase == Phase.FAILED && file?.exists() == true) sendRecording()
    }

    private fun sample() {
        if (phase != Phase.RECORDING) return
        val amplitude = recorder.maxAmplitude()
        val elapsed = clock() - startedAtMs
        listener?.onRecording(audioLevel(amplitude), elapsed)
        when (detector?.onSample(amplitude, elapsed)) {
            SilenceDetector.Verdict.SPEECH_ENDED -> finishRecording()
            SilenceDetector.Verdict.NO_SPEECH -> {
                sampling?.cancel()
                recorder.release()
                deleteRecording()
                end(VoiceInputEnd.NoSpeech)
            }
            SilenceDetector.Verdict.LISTENING, null -> Unit
        }
    }

    private fun finishRecording() {
        sampling?.cancel()
        if (!recorder.stop()) {
            // Stopped before anything was captured: there is nothing to transcribe.
            deleteRecording()
            end(VoiceInputEnd.Finished)
            return
        }
        sendRecording()
    }

    private fun sendRecording() {
        val recording = file ?: return
        phase = Phase.TRANSCRIBING
        listener?.onTranscribing()
        upload = scope.launch {
            val outcome = try {
                transcribe(recording)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                DictationOutcome.Failed(GatewayException.InvalidResponse(e.message ?: "transcription failed"))
            }
            if (phase != Phase.TRANSCRIBING) return@launch
            deliver(outcome)
        }
    }

    private suspend fun deliver(outcome: DictationOutcome) {
        when (outcome) {
            is DictationOutcome.Transcribed -> {
                deleteRecording()
                val text = outcome.text.trim()
                if (text.isNotEmpty()) listener?.onText(text)
                end(VoiceInputEnd.Finished)
            }
            else -> {
                val failure = failureFor(outcome)
                if (failure.retryable) {
                    // Kept for retry; the listener stays attached for the retry's result.
                    phase = Phase.FAILED
                    listener?.onEnded(VoiceInputEnd.Failed(failure))
                } else {
                    deleteRecording()
                    end(VoiceInputEnd.Failed(failure))
                }
                if (outcome.questionsTheGate()) refreshStatus()
            }
        }
    }

    /**
     * The file-size cap handed to the recorder. MPEG-4 writes its index when the
     * recording stops, after the cap is checked, so the cap leaves room for it.
     */
    private fun recordingByteCap(): Long =
        if (maxAudioBytes <= 0) 0 else (maxAudioBytes - CONTAINER_HEADROOM_BYTES).coerceAtLeast(maxAudioBytes / 2)

    private fun deleteRecording() {
        file?.delete()
        file = null
    }

    private fun end(end: VoiceInputEnd) {
        phase = Phase.ENDED
        val out = listener ?: return
        listener = null
        out.onEnded(end)
    }

    companion object {
        /** A dictation, not a meeting: long enough for a considered note. */
        const val MAX_DURATION_MS = 5 * 60 * 1000L
        const val SAMPLE_INTERVAL_MS = 100L
        private const val CONTAINER_HEADROOM_BYTES = 64 * 1024L

        /**
         * The words a failed transcription shows. Only a failure that sending the same
         * recording again could fix is retryable — an unreachable gateway, a transcriber
         * that failed this once, a server error — and only those keep the recording.
         */
        fun failureFor(outcome: DictationOutcome): DictationFailure = when (outcome) {
            is DictationOutcome.Unreachable -> DictationFailure("Couldn't reach your gateway.", retryable = true)
            is DictationOutcome.TranscriberUnavailable ->
                DictationFailure("Your gateway couldn't transcribe this recording.", retryable = true)
            is DictationOutcome.Failed -> when (val error = outcome.error) {
                is GatewayException.Unauthorized, is GatewayException.Forbidden ->
                    DictationFailure("Your gateway no longer accepts this phone. Pair it again.", retryable = false)
                is GatewayException.Decoding ->
                    DictationFailure("Your gateway's reply couldn't be read.", retryable = false)
                is GatewayException.ServerError ->
                    DictationFailure("Transcription didn't finish.", retryable = error.status >= 500)
                else -> DictationFailure("Transcription didn't finish.", retryable = true)
            }
            DictationOutcome.Disabled -> DictationFailure("Gateway dictation is switched off.", retryable = false)
            DictationOutcome.Unsupported ->
                DictationFailure("Your gateway doesn't offer dictation.", retryable = false)
            DictationOutcome.TooLarge ->
                DictationFailure("This recording is too long for your gateway.", retryable = false)
            is DictationOutcome.Transcribed -> error("a transcript is not a failure")
        }

        /** Refusals that mean the advertised status may be stale. */
        private fun DictationOutcome.questionsTheGate(): Boolean =
            this == DictationOutcome.Unsupported ||
                this == DictationOutcome.Disabled ||
                this is DictationOutcome.TranscriberUnavailable
    }
}
