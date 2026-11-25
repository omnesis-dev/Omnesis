// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

/**
 * Scores mono 16 kHz audio for speech, one [ChunkPolicy.FRAME_SAMPLES] frame
 * at a time, samples in -1..1. Stateful: each frame is judged in the context
 * of the ones before it, so [reset] between unrelated pieces of audio. Not
 * thread-safe.
 */
interface SpeechDetector {
    fun reset()

    /** The probability, 0..1, that [frame] holds speech. */
    fun probability(frame: FloatArray): Float
}

/** What a scan of one chunk found. */
enum class SpeechVerdict {
    Speech,
    NoSpeech,

    /** The audio could not be read or scored. Treated as speech, so a failure never loses audio. */
    Unknown,
}

/** What the scan of one closed chunk decided. */
data class ChunkSpeech(
    val verdict: SpeechVerdict,
    /** Speech in the chunk's last [ChunkPolicy.TAIL_MS], or not known: the next chunk keeps its audio. */
    val speechAtEnd: Boolean,
)

/**
 * Turns per-frame probabilities into speech segments the way Silero's
 * `get_speech_timestamps` does (see [ChunkPolicy]), reporting as soon as one
 * segment is long enough. Lengths are counted in frames of
 * [ChunkPolicy.FRAME_MS].
 */
class SpeechSegmenter(
    private val threshold: Float = ChunkPolicy.SPEECH_THRESHOLD,
    private val endThreshold: Float = ChunkPolicy.SPEECH_END_THRESHOLD,
    minSpeechMs: Int = ChunkPolicy.MIN_SPEECH_MS,
    minSilenceMs: Int = ChunkPolicy.MIN_SILENCE_MS,
) {
    private val minSpeechFrames = kotlin.math.ceil(minSpeechMs / ChunkPolicy.FRAME_MS).toInt()
    private val minSilenceFrames = kotlin.math.ceil(minSilenceMs / ChunkPolicy.FRAME_MS).toInt()
    private var frame = 0
    /** First frame of the open segment, or -1 outside one. */
    private var start = -1
    /** First frame of the quiet stretch inside the open segment, or -1. */
    private var quietSince = -1

    /** Frames the longest segment so far lasted, open or closed. */
    var longestFrames = 0
        private set

    /** Feed the next frame's probability; true once a segment reached the minimum length. */
    fun offer(probability: Float): Boolean {
        val at = frame++
        if (start < 0) {
            if (probability >= threshold) start = at else return false
        }
        when {
            probability >= threshold -> quietSince = -1
            probability < endThreshold -> {
                if (quietSince < 0) quietSince = at
                if (at + 1 - quietSince >= minSilenceFrames) {
                    // The segment ended where the quiet began.
                    longestFrames = maxOf(longestFrames, quietSince - start)
                    start = -1
                    quietSince = -1
                    return false
                }
            }
        }
        // The segment lasts at least to where any quiet stretch began, or to this frame.
        val length = (if (quietSince >= 0) quietSince else at + 1) - start
        longestFrames = maxOf(longestFrames, length)
        return length >= minSpeechFrames
    }

    fun reset() {
        frame = 0
        start = -1
        quietSince = -1
        longestFrames = 0
    }
}

/** Decoded audio, read in order: mono 16-bit PCM at [ChunkPolicy.SAMPLE_RATE_HZ]. */
fun interface PcmSource {
    /** Fill [into] from the start; the number of samples read, or -1 at the end. */
    fun read(into: ShortArray): Int
}

/** How a scan ended, for the per-chunk log line that tunes the thresholds. */
data class SpeechScan(
    val verdict: SpeechVerdict,
    /** Where the segment that decided it reached the minimum length, ms into the audio; null without speech. */
    val speechAtMs: Long?,
    /** The highest probability any frame reached. */
    val maxProbability: Float,
    /** Frames scored, and how many reached the start and the end threshold. */
    val frames: Int = 0,
    val framesAtThreshold: Int = 0,
    val framesAtEndThreshold: Int = 0,
    /** The longest segment heard, ms. */
    val longestSpeechMs: Long = 0,
    /** The loudest sample decoded, 0–32767, to compare with a plain level gate. */
    val peak: Int = 0,
)

/**
 * Score [source] frame by frame and stop at the first segment of speech long
 * enough. A trailing partial frame is padded with silence. Exceptions
 * propagate; the caller turns them into [SpeechVerdict.Unknown].
 */
fun scanForSpeech(source: PcmSource, detector: SpeechDetector, segmenter: SpeechSegmenter = SpeechSegmenter()): SpeechScan {
    detector.reset()
    segmenter.reset()
    val frameSize = ChunkPolicy.FRAME_SAMPLES
    val pcm = ShortArray(frameSize)
    val frame = FloatArray(frameSize)
    var filled = 0
    var frames = 0
    var atThreshold = 0
    var atEnd = 0
    var max = 0f
    var peak = 0

    fun msOf(n: Int) = (n * ChunkPolicy.FRAME_MS).toLong()
    fun scan(verdict: SpeechVerdict) = SpeechScan(
        verdict = verdict,
        speechAtMs = if (verdict == SpeechVerdict.Speech) msOf(frames) else null,
        maxProbability = max,
        frames = frames,
        framesAtThreshold = atThreshold,
        framesAtEndThreshold = atEnd,
        longestSpeechMs = msOf(segmenter.longestFrames),
        peak = peak,
    )

    fun score(): Boolean {
        val p = detector.probability(frame)
        frames++
        if (p > max) max = p
        if (p >= ChunkPolicy.SPEECH_THRESHOLD) atThreshold++
        if (p >= ChunkPolicy.SPEECH_END_THRESHOLD) atEnd++
        return segmenter.offer(p)
    }

    while (true) {
        val read = source.read(pcm)
        if (read < 0) break
        for (i in 0 until read) {
            val sample = pcm[i].toInt()
            if (sample > peak) peak = sample else if (-sample > peak) peak = minOf(-sample, Short.MAX_VALUE.toInt())
            frame[filled++] = sample / 32768f
            if (filled == frameSize) {
                filled = 0
                if (score()) return scan(SpeechVerdict.Speech)
            }
        }
    }
    if (filled > 0) {
        frame.fill(0f, filled, frameSize)
        if (score()) return scan(SpeechVerdict.Speech)
    }
    return scan(SpeechVerdict.NoSpeech)
}
