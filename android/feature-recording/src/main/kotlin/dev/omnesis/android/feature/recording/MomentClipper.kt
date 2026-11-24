// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.util.Log
import java.io.File

/** The audio of a moment the owner marked, ready to be saved as a note. */
data class MarkedClip(
    val file: File,
    /** When the owner marked the moment, epoch ms. */
    val markedAtMs: Long,
    /** Where the clip's audio starts, epoch ms: up to [MomentClipper.PRE_ROLL_MS] before the mark. */
    val startedAtMs: Long,
    val durationMs: Long,
)

/**
 * Cuts the audio of a marked moment out of a stream that is being recorded
 * anyway. It keeps the last [PRE_ROLL_MS] of audio at all times, so a mark
 * reaches back to what was said just before it; the clip then goes on until
 * the speech pauses for [PAUSE_MS], at least [MIN_AFTER_MS] and at most
 * [MAX_AFTER_MS] after the mark, or until the stream itself pauses.
 *
 * Pauses in speech are judged by a fresh [SpeechDetector] per clip; without
 * one, a clip runs to [MAX_AFTER_MS] or to the stream's own pause.
 *
 * Not thread-safe: the recorder calls it from its one worker thread.
 */
class MomentClipper(
    private val newFile: () -> File,
    private val encoders: PcmChunkEncoderFactory,
    private val detectors: () -> SpeechDetector?,
    private val onClip: (MarkedClip) -> Unit,
) {
    private val ring = ShortArray(samplesOf(PRE_ROLL_MS))
    /** Index of the oldest sample held. */
    private var ringStart = 0
    private var ringCount = 0
    /** Wall-clock end of the audio offered so far; null before any. */
    private var audioEndMs: Long? = null

    private class Clip(
        val file: File,
        val encoder: PcmChunkEncoder,
        val markedAtMs: Long,
        val startedAtMs: Long,
        val detector: SpeechDetector?,
    ) {
        var samples = 0L
        var afterMark = 0L
        val frame = FloatArray(ChunkPolicy.FRAME_SAMPLES)
        var framed = 0
        var quietFrames = 0
    }

    private var clip: Clip? = null

    val clipping: Boolean get() = clip != null

    /**
     * Mark a moment at [atMs]: open a clip that starts with the audio held.
     * False when a clip is already open or its file cannot be written.
     */
    fun mark(atMs: Long): Boolean {
        if (clip != null) return false
        val file = newFile()
        val encoder = try {
            encoders.open(file)
        } catch (e: Exception) {
            Log.w(TAG, "Could not open a marked moment's clip: ${e.message}")
            file.delete()
            return false
        }
        val heldMs = ringCount * 1000L / ChunkPolicy.SAMPLE_RATE_HZ
        val open = Clip(file, encoder, atMs, (audioEndMs ?: atMs) - heldMs, detectors())
        clip = open
        val tail = ring.size - ringStart
        if (ringCount <= tail) {
            write(open, ring.copyOfRange(ringStart, ringStart + ringCount), afterMark = false)
        } else {
            write(open, ring.copyOfRange(ringStart, ring.size), afterMark = false)
            write(open, ring.copyOfRange(0, ringCount - tail), afterMark = false)
        }
        return true
    }

    /** The next stretch of audio, ending at [endMs]. */
    fun offer(pcm: ShortArray, endMs: Long) {
        hold(pcm)
        audioEndMs = endMs
        val open = clip ?: return
        if (!write(open, pcm, afterMark = true)) return
        val after = open.afterMark * 1000L / ChunkPolicy.SAMPLE_RATE_HZ
        val pausedMs = (open.quietFrames * ChunkPolicy.FRAME_MS).toLong()
        if (after >= MAX_AFTER_MS || (after >= MIN_AFTER_MS && pausedMs >= PAUSE_MS)) finish()
    }

    /** The stream paused or ended: close an open clip there. */
    fun finish() {
        val open = clip ?: return
        clip = null
        (open.detector as? AutoCloseable)?.let { runCatching { it.close() } }
        try {
            open.encoder.finish()
        } catch (e: Exception) {
            Log.w(TAG, "Could not finish a marked moment's clip: ${e.message}")
            open.file.delete()
            return
        }
        if (open.samples == 0L || !open.file.exists() || open.file.length() == 0L) {
            open.file.delete()
            return
        }
        onClip(MarkedClip(open.file, open.markedAtMs, open.startedAtMs, open.samples * 1000L / ChunkPolicy.SAMPLE_RATE_HZ))
    }

    /** Close an open clip and forget the audio held: what follows does not continue it. */
    fun reset() {
        finish()
        ringStart = 0
        ringCount = 0
        audioEndMs = null
    }

    private fun hold(pcm: ShortArray) {
        for (sample in pcm) {
            val at = (ringStart + ringCount) % ring.size
            ring[at] = sample
            if (ringCount < ring.size) ringCount++ else ringStart = (ringStart + 1) % ring.size
        }
    }

    /** Write to the clip and judge its speech; false when the clip failed and was dropped. */
    private fun write(open: Clip, pcm: ShortArray, afterMark: Boolean): Boolean {
        if (pcm.isEmpty()) return true
        try {
            open.encoder.write(pcm, pcm.size)
        } catch (e: Exception) {
            Log.w(TAG, "A marked moment's clip could not be written: ${e.message}")
            clip = null
            (open.detector as? AutoCloseable)?.let { runCatching { it.close() } }
            runCatching { open.encoder.finish() }
            open.file.delete()
            return false
        }
        open.samples += pcm.size
        if (afterMark) open.afterMark += pcm.size
        val detector = open.detector ?: return true
        for (sample in pcm) {
            open.frame[open.framed++] = sample / 32768f
            if (open.framed == open.frame.size) {
                open.framed = 0
                val speech = runCatching { detector.probability(open.frame) }.getOrDefault(1f)
                // Only quiet after the mark counts toward the pause that ends the clip.
                open.quietFrames = if (afterMark && speech < ChunkPolicy.SPEECH_END_THRESHOLD) open.quietFrames + 1 else 0
            }
        }
        return true
    }

    companion object {
        private const val TAG = "Omnesis:Recording"

        /** Audio kept from before a mark. */
        const val PRE_ROLL_MS = 30_000L

        /** A clip never ends sooner than this after its mark. */
        const val MIN_AFTER_MS = 2_000L

        /** A pause in speech this long ends the clip. */
        const val PAUSE_MS = 1_200L

        /** A clip ends this long after its mark whatever is said. */
        const val MAX_AFTER_MS = 60_000L

        private fun samplesOf(ms: Long): Int = (ms * ChunkPolicy.SAMPLE_RATE_HZ / 1000).toInt()
    }
}
