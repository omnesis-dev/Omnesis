// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import dev.omnesis.android.voice.SilenceDetector.Verdict
import org.junit.Assert.assertEquals
import org.junit.Test

class SilenceDetectorTest {

    private val loud = 6_000
    private val quiet = 300

    /** Feeds one sample per 100 ms and returns the verdict of the last one. */
    private fun SilenceDetector.feed(samples: List<Int>, startMs: Long = 100): Pair<Verdict, Long> {
        var t = startMs
        var verdict = Verdict.LISTENING
        for (a in samples) {
            verdict = onSample(a, t)
            if (verdict != Verdict.LISTENING) return verdict to t
            t += 100
        }
        return verdict to t - 100
    }

    @Test
    fun speech_then_trailing_silence_ends_the_recording() {
        val detector = SilenceDetector()
        val (verdict, at) = detector.feed(List(10) { loud } + List(30) { quiet })
        assertEquals(Verdict.SPEECH_ENDED, verdict)
        // The last loud sample was at 1000 ms; the end lands 1.8 s after it.
        assertEquals(2_800L, at)
    }

    @Test
    fun a_pause_shorter_than_the_trailing_window_keeps_recording() {
        val detector = SilenceDetector()
        val (verdict, _) = detector.feed(List(5) { loud } + List(12) { quiet } + List(5) { loud })
        assertEquals(Verdict.LISTENING, verdict)
    }

    @Test
    fun a_single_click_is_not_speech_so_silence_after_it_times_out_as_no_speech() {
        val detector = SilenceDetector()
        val (verdict, at) = detector.feed(listOf(loud) + List(100) { quiet })
        assertEquals(Verdict.NO_SPEECH, verdict)
        assertEquals(8_000L, at)
    }

    @Test
    fun room_tone_alone_never_ends_as_speech() {
        val detector = SilenceDetector()
        val (verdict, _) = detector.feed(List(79) { quiet })
        assertEquals(Verdict.LISTENING, verdict)
    }

    @Test
    fun speech_that_started_late_is_not_cut_off_by_the_no_speech_timeout() {
        val detector = SilenceDetector()
        val (verdict, _) = detector.feed(List(70) { quiet } + List(20) { loud })
        assertEquals(Verdict.LISTENING, verdict)
    }
}
