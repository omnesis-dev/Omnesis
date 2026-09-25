// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The "still working" dots must read as a WAVE — one dot cresting at a time, the crest
 * travelling rightwards — the way the portal `@keyframes agent-thinking-dot` and the iOS
 * indicator do. Three dots pulsing in near-unison look static at a glance, which is what
 * a seeded golden (rendered under inspection, with the animation frozen) can never catch.
 *
 * Two halves: the pure shape ([waveCrest]) and the live wiring (the animation actually
 * advancing under a hand-driven frame clock, without inspection mode).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentWaveDotsTest {

    @get:Rule val compose = createComposeRule()


    @Test fun crest_follows_the_portal_keyframes() {
        assertEquals("at rest as the cycle opens", 0f, waveCrest(0f), 0.001f)
        assertEquals("crests at 35% of the cycle", 1f, waveCrest(0.35f), 0.001f)
        assertEquals("back at rest by 70%", 0f, waveCrest(0.70f), 0.001f)
        assertEquals("and stays at rest to the end", 0f, waveCrest(0.95f), 0.001f)
    }

    // A staggered dot's phase runs negative for part of the cycle, so the wrap has to land it
    // on the same crest a positive phase would give — checked inside the active leg, where the
    // two sides of the wrap differ if it is wrong (in the rest region both are flat zero).
    @Test fun a_shifted_phase_wraps_instead_of_going_negative() {
        assertEquals(waveCrest(0.35f), waveCrest(-0.65f), 0.001f)
        assertEquals(waveCrest(0.2f), waveCrest(1.2f), 0.001f)
    }

    // The wave itself: at the moment dot 0 crests, the dots behind it are still climbing, so
    // the row is visibly uneven end to end — that unevenness IS the wave.
    @Test fun the_three_dots_sit_at_different_heights_at_any_instant() {
        val cycle = 0.35f // dot 0 at its crest
        val crests = List(3) { i -> waveCrest(cycle - WaveStagger[i]) }
        assertEquals("the leading dot crests", 1f, crests[0], 0.001f)
        assertTrue("the row descends left to right", crests[0] > crests[1] && crests[1] > crests[2])
        assertTrue("and end to end the difference is plain", crests[0] - crests[2] > 0.5f)
    }

    // Every dot reaches the crest, and each does so LATER than the one to its left: the crest
    // travels along the row rather than one dot doing all the work or all three rising together.
    @Test fun the_crest_travels_along_the_row() {
        val peakAt = List(3) { i ->
            (0..1000).maxByOrNull { step -> waveCrest(step / 1000f - WaveStagger[i]) }!! / 1000f
        }
        repeat(3) { i ->
            assertTrue("dot $i crests somewhere in the cycle", waveCrest(peakAt[i] - WaveStagger[i]) > 0.99f)
        }
        assertTrue("each dot crests after the one before it", peakAt[0] < peakAt[1] && peakAt[1] < peakAt[2])
    }

    // The live half: with the frame clock driven by hand and inspection mode OFF (so the real
    // infinite transition runs), the dots must actually move — and must be at three DIFFERENT
    // heights while they do, which is the part a frozen golden cannot assert.
    @Test fun the_dots_ride_the_wave_as_the_frame_clock_advances() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OmnesisTheme(darkTheme = true) {
                // Inset so the lift has room above the row: a dot riding off the top of the
                // window would report a clamped position and hide a real animation.
                Box(Modifier.padding(24.dp)) { AgentWaveDots(dotSize = 6.dp, lift = 6.dp) }
            }
        }

        compose.mainClock.advanceTimeByFrame()
        val atRest = dotTops()
        // 455ms is 35% of the 1300ms cycle — the instant the leading dot reaches its crest.
        compose.mainClock.advanceTimeBy(455)
        val atCrest = dotTops()

        assertTrue("the leading dot rises off its rest position", atCrest[0] < atRest[0])
        // Lower `top` is higher on screen, so a travelling crest leaves the row descending
        // left to right. Were the stagger lost, all three would sit at the same height here.
        assertTrue(
            "the crest is on the leading dot, with the others still climbing behind it",
            atCrest[0] < atCrest[1] && atCrest[1] < atCrest[2],
        )
    }

    private fun dotTops(): List<Dp> = List(3) { i ->
        compose.onNodeWithTag("agentWaveDot$i", useUnmergedTree = true).getUnclippedBoundsInRoot().top
    }
}
