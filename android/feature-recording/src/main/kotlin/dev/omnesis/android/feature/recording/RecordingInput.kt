// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import kotlinx.coroutines.flow.StateFlow

/** Where a recording's audio comes from. */
enum class RecordingInput {
    /** The phone's own microphone. */
    PHONE,

    /** A paired wearable that streams Opus frames ([WearableAudio]). */
    WEARABLE,
}

/**
 * Records a session's audio into dense, numbered chunks for the controller.
 * Driven from the service's main thread. Every chunk is reported through the
 * callback the recorder was built with before [pause] or [stop] returns, so
 * [chunksRecorded] is final once they do.
 */
interface ChunkRecorder {
    val chunksRecorded: Int
    val isRecording: Boolean

    /** Start, or resume after [pause] or a lost input. False when the input could not be opened. */
    fun start(): Boolean

    /** Close the current chunk and stop; [start] resumes with a new chunk. */
    fun pause()

    /** Close the last chunk and stop for good. */
    fun stop()
}

/**
 * An audio input worn by the user: a pendant that streams 20 ms Opus frames
 * of 16 kHz mono speech. The device-specific link implements it; the recorder
 * only sees frames and whether the link holds.
 */
interface WearableAudio {
    /** The device's name as the user knows it, for the notification and the screen. */
    val name: String

    /** Linked, and able to stream audio now. */
    val ready: StateFlow<Boolean>

    /**
     * Start sending frames to [sink], from any thread, in order. False when
     * the device is not ready. Until [stopStreaming] the device captures audio.
     */
    fun startStreaming(sink: FrameSink): Boolean

    /** Stop sending frames; the device stops capturing. */
    fun stopStreaming()

    interface FrameSink {
        /** One whole Opus frame, received at [receivedAtMs] (wall clock). */
        fun onFrame(frame: ByteArray, receivedAtMs: Long)

        /** The link dropped while streaming. No frame follows until [startStreaming] is called again. */
        fun onLinkLost()
    }
}

/** Saves a marked moment's clip as a note of recording [recordingId], and owns the file from then on. */
fun interface MarkedMomentSink {
    suspend fun save(clip: MarkedClip, recordingId: String)
}
