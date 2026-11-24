// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MomentClipperTest {
    private val dir: File = Files.createTempDirectory("moments").toFile()
    private val clips = mutableListOf<MarkedClip>()
    /** Samples each clip file received, by name. */
    private val written = mutableMapOf<String, Int>()
    private var withDetector = true
    private var files = 0

    private val clipper = MomentClipper(
        newFile = { File(dir, "moment-${files++}.m4a") },
        encoders = { file -> FakeEncoder(file) },
        detectors = { if (withDetector) LoudnessDetector() else null },
        onClip = { clips += it },
    )

    /** The wall clock where the audio offered so far ends. */
    private var clock = 1_000_000L

    /** Offer [ms] of audio in 20 ms frames, speech when [speech]. */
    private fun audio(ms: Long, speech: Boolean) {
        repeat((ms / 20).toInt()) {
            clock += 20
            clipper.offer(ShortArray(320) { if (speech) 2_000 else 0 }, clock)
        }
    }

    @Test fun aMarkReachesBackThirtySecondsAndEndsAtThePauseAfterIt() {
        audio(45_000, speech = true)
        val markedAt = clock
        assertTrue(clipper.mark(markedAt))
        audio(3_000, speech = true)
        audio(5_000, speech = false)

        val clip = clips.single()
        assertEquals(markedAt, clip.markedAtMs)
        assertEquals(markedAt - MomentClipper.PRE_ROLL_MS, clip.startedAtMs)
        // Thirty seconds before, three of speech after, then the pause that ended it.
        assertTrue("${clip.durationMs}", clip.durationMs in 34_200L..34_400L)
        assertEquals(clip.durationMs * 16, written[clip.file.name]!!.toLong())
        assertFalse(clipper.clipping)
    }

    @Test fun aPauseRightAfterTheMarkDoesNotEndItTooSoon() {
        audio(10_000, speech = true)
        clipper.mark(clock)
        audio(5_000, speech = false)
        // Only the audio held before the mark, then the shortest clip after it.
        assertTrue("${clips.single().durationMs}", clips.single().durationMs in 12_000L..12_100L)
    }

    @Test fun aClipEndsAMinuteAfterTheMarkWhateverIsSaid() {
        audio(30_000, speech = true)
        clipper.mark(clock)
        audio(90_000, speech = true)
        assertEquals(30_000L + MomentClipper.MAX_AFTER_MS, clips.single().durationMs)
    }

    @Test fun withoutADetectorTheStreamsOwnPauseEndsTheClip() {
        withDetector = false
        audio(5_000, speech = true)
        clipper.mark(clock)
        audio(10_000, speech = false)
        assertTrue(clips.isEmpty())
        clipper.finish()
        assertEquals(15_000L, clips.single().durationMs)
    }

    @Test fun aSecondMarkWhileTheFirstIsOpenIsRefused() {
        audio(1_000, speech = true)
        assertTrue(clipper.mark(clock))
        assertFalse(clipper.mark(clock))
        clipper.finish()
        assertEquals(1, clips.size)
        // Once it closed, the next mark opens another.
        assertTrue(clipper.mark(clock))
    }

    @Test fun aResetForgetsTheAudioHeld() {
        audio(20_000, speech = true)
        clipper.reset()
        audio(2_000, speech = true)
        clipper.mark(clock)
        clipper.finish()
        assertEquals(clock - 2_000, clips.single().startedAtMs)
        assertEquals(2_000L, clips.single().durationMs)
    }

    @Test fun aMarkWithNothingHeardSavesNothing() {
        assertTrue(clipper.mark(clock))
        clipper.finish()
        assertTrue(clips.isEmpty())
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test fun aClipThatCannotBeOpenedIsRefused() {
        val failing = MomentClipper(
            newFile = { File(dir, "moment.m4a") },
            encoders = { throw java.io.IOException("disk full") },
            detectors = { null },
            onClip = { clips += it },
        )
        failing.offer(ShortArray(320), clock)
        assertFalse(failing.mark(clock))
        assertFalse(failing.clipping)
    }

    /** Speech wherever the frame is not silent. */
    private class LoudnessDetector : SpeechDetector {
        override fun reset() = Unit
        override fun probability(frame: FloatArray): Float = if (frame.any { it != 0f }) 0.9f else 0.05f
    }

    private inner class FakeEncoder(private val file: File) : PcmChunkEncoder {
        private var samples = 0
        override fun write(pcm: ShortArray, length: Int) {
            samples += length
        }
        override fun finish() {
            written[file.name] = samples
            file.writeBytes(if (samples > 0) byteArrayOf(1) else byteArrayOf())
        }
    }
}
