// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

/**
 * Records a session's audio into dense, numbered chunks for the controller.
 * Driven from the service's main thread. Every chunk is reported through the
 * callback the recorder was built with before [pause] or [stop] returns, so
 * [chunksRecorded] is final once they do.
 */
interface ChunkRecorder {
    val chunksRecorded: Int
    val isRecording: Boolean

    /** Start, or resume after [pause] or a lost microphone. False when the microphone could not be opened. */
    fun start(): Boolean

    /** Close the current chunk and stop; [start] resumes with a new chunk. */
    fun pause()

    /** Close the last chunk and stop for good. */
    fun stop()
}
