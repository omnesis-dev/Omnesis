// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechScanTest {
    /** Frames needed for 250 ms (8) and for 100 ms of silence (4) at 32 ms a frame. */
    private fun segmenter() = SpeechSegmenter(threshold = 0.5f, endThreshold = 0.35f, minSpeechMs = 250, minSilenceMs = 100)

    private fun SpeechSegmenter.feed(vararg p: Float): Boolean = p.map { offer(it) }.last()

    @Test fun aSegmentStartsAtTheThresholdAndNeedsTheMinimumLength() {
        val s = segmenter()
        assertFalse(s.feed(0.49f, 0.49f, 0.49f)) // never reached the start threshold
        assertFalse(s.feed(0.5f, 0.9f, 0.9f, 0.9f, 0.9f, 0.9f, 0.9f)) // 7 frames
        assertTrue(s.offer(0.9f)) // the 8th
    }

    @Test fun aQuietVoiceBetweenTheTwoThresholdsKeepsItsSegment() {
        // One frame at the start threshold, then a voice hovering at 0.4: one segment, not a broken run.
        assertTrue(segmenter().feed(0.6f, 0.4f, 0.45f, 0.38f, 0.42f, 0.4f, 0.36f, 0.41f))
    }

    @Test fun shortDipsBelowTheEndThresholdDoNotEndTheSegment() {
        // Three quiet frames (96 ms) are not the 100 ms that ends a segment; the dip still counts toward its length.
        assertTrue(segmenter().feed(0.8f, 0.8f, 0.8f, 0.1f, 0.1f, 0.1f, 0.8f, 0.8f))
    }

    @Test fun aLongEnoughSilenceEndsTheSegmentAndAKnockStaysShort() {
        val s = segmenter()
        // A knock: three loud frames, then silence long enough to close it.
        assertFalse(s.feed(0.9f, 0.9f, 0.9f, 0.1f, 0.1f, 0.1f, 0.1f))
        assertEquals(3, s.longestFrames)
        // A quiet stretch after it never reaches the start threshold: no new segment.
        assertFalse(s.feed(0.4f, 0.4f, 0.4f, 0.4f, 0.4f, 0.4f, 0.4f, 0.4f, 0.4f))
        s.reset()
        assertEquals(0, s.longestFrames)
    }

    /** Scores each frame by its first sample, so a test chooses the probabilities through the audio. */
    private class FirstSampleDetector : SpeechDetector {
        var resets = 0
        val scored = mutableListOf<Float>()

        override fun reset() {
            resets++
        }

        override fun probability(frame: FloatArray): Float = frame[0].also { scored += it }
    }

    /** PCM made of whole frames whose first sample is the given probability; read in odd-sized pieces. */
    private fun frames(vararg probabilities: Float, piece: Int = 300): PcmSource {
        val pcm = ShortArray(probabilities.size * ChunkPolicy.FRAME_SAMPLES)
        probabilities.forEachIndexed { i, p -> pcm[i * ChunkPolicy.FRAME_SAMPLES] = (p * 32768f).toInt().coerceAtMost(Short.MAX_VALUE.toInt()).toShort() }
        var at = 0
        return PcmSource { into ->
            if (at >= pcm.size) return@PcmSource -1
            val n = minOf(piece, into.size, pcm.size - at)
            pcm.copyInto(into, 0, at, at + n)
            at += n
            n
        }
    }

    @Test fun stopsAtTheFirstRunOfSpeech() {
        val detector = FirstSampleDetector()
        val scan = scanForSpeech(frames(0.1f, 0.9f, 0.9f, 0.9f, 0.9f), detector, SpeechSegmenter(minSpeechMs = 64))
        assertEquals(SpeechVerdict.Speech, scan.verdict)
        assertEquals(3, detector.scored.size) // the last two frames are never decoded or scored
        assertEquals(3L * ChunkPolicy.FRAME_SAMPLES * 1000 / ChunkPolicy.SAMPLE_RATE_HZ, scan.speechAtMs)
        assertEquals(1, detector.resets)
    }

    @Test fun reportsNoSpeechWithTheHighestProbability() {
        val scan = scanForSpeech(frames(0.1f, 0.4f, 0.9f, 0.2f, 0.2f, 0.2f, 0.2f), FirstSampleDetector(), SpeechSegmenter(minSpeechMs = 64))
        assertEquals(SpeechVerdict.NoSpeech, scan.verdict)
        assertNull(scan.speechAtMs)
        assertEquals(0.9f, scan.maxProbability, 0.001f)
        assertEquals((0.9f * 32768f).toInt(), scan.peak)
    }

    @Test fun padsATrailingPartialFrameWithSilence() {
        val detector = FirstSampleDetector()
        // One whole frame of silence, then 100 samples whose first one is loud.
        val pcm = ShortArray(ChunkPolicy.FRAME_SAMPLES + 100).also { it[ChunkPolicy.FRAME_SAMPLES] = Short.MAX_VALUE }
        var offset = 0
        val source = PcmSource { into ->
            if (offset >= pcm.size) return@PcmSource -1
            val n = minOf(into.size, pcm.size - offset)
            pcm.copyInto(into, 0, offset, offset + n)
            offset += n
            n
        }
        scanForSpeech(source, detector)
        assertEquals(2, detector.scored.size)
        assertEquals(0f, detector.scored[0], 0f)
        assertTrue(detector.scored[1] > 0.99f)
    }
}
