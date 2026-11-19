// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DecimatorTest {
    private fun tone(hz: Double, rate: Int, n: Int) = ShortArray(n) { (10_000 * sin(2 * PI * hz * it / rate)).toInt().toShort() }

    private fun peak(samples: ShortArray, skip: Int) = samples.drop(skip).maxOf { abs(it.toInt()) }

    @Test fun keepsOneSampleInThree() {
        val d = Decimator(3)
        // Split across calls the way decoder output arrives.
        val total = listOf(960, 959, 1, 961).sumOf { d.process(ShortArray(it)).size }
        assertEquals((2_881 + 2) / 3, total) // the first sample is kept, so rounded up
    }

    @Test fun speechBandPassesAndAliasesAreRemoved() {
        val voice = Decimator(3).process(tone(1_000.0, 48_000, 4_800))
        assertTrue("1 kHz peak ${peak(voice, 64)}", peak(voice, 64) in 9_000..11_000)
        // 12 kHz would fold onto 4 kHz at 16 kHz; it must be gone.
        val alias = Decimator(3).process(tone(12_000.0, 48_000, 4_800))
        assertTrue("12 kHz peak ${peak(alias, 64)}", peak(alias, 64) < 300)
    }

    @Test fun factorOneIsACopy() {
        val input = shortArrayOf(1, 2, 3)
        assertEquals(input.toList(), Decimator(1).process(input).toList())
    }
}
