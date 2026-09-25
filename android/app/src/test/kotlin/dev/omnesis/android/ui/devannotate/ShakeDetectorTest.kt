// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devannotate

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShakeDetectorTest {

    @Test
    fun rest_and_footsteps_stay_below_threshold() {
        // At rest the accelerometer reads ~1g straight down.
        assertFalse(ShakeDetector.exceedsShakeThreshold(0f, 0f, 9.81f))
        assertFalse(ShakeDetector.exceedsShakeThreshold(0f, 9.81f, 0f))
        // A brisk walk peaks well under the ~2.7g bar.
        assertFalse(ShakeDetector.exceedsShakeThreshold(8f, 8f, 12f))
    }

    @Test
    fun deliberate_shake_trips_the_threshold() {
        assertTrue(ShakeDetector.exceedsShakeThreshold(16f, 16f, 16f))
        // Direction doesn't matter — the magnitude decides.
        assertTrue(ShakeDetector.exceedsShakeThreshold(-18f, -14f, -14f))
    }
}
