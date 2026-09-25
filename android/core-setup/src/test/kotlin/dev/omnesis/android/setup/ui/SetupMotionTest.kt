// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.ui

import android.content.Context
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Connected's travelling packet: it moves from this phone to the gateway at a
 * steady pace and loops, fading at both ends, and rests only while Android's
 * animations are off.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SetupMotionTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun thePacketTravelsFromThisPhoneToTheGatewayAndLoops() {
        assertEquals(0f, connectionPacketPhase(0), 0f)
        assertEquals(0.5f, connectionPacketPhase(CONNECTION_CYCLE_MILLIS / 2), 0.001f)
        assertTrue(connectionPacketPhase(2_000) > connectionPacketPhase(1_000))
        assertEquals("the loop starts again at this phone", connectionPacketPhase(300), connectionPacketPhase(CONNECTION_CYCLE_MILLIS + 300), 0.001f)
    }

    @Test
    fun thePacketFadesInAtThisPhoneAndOutAtTheGateway() {
        assertEquals(0f, connectionPacketAlpha(0f), 0f)
        assertEquals(1f, connectionPacketAlpha(0.5f), 0f)
        assertEquals(0f, connectionPacketAlpha(1f), 0.0001f)
        assertEquals(0.6f, connectionPacketAlpha(0.1f), 0.001f)
    }

    @Test
    fun onlyAnimationsTurnedOffSystemWideStopTheMotion() {
        assertFalse("a phone with default animation settings animates", systemAnimationsDisabled(context))

        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1.5f)
        assertFalse(systemAnimationsDisabled(context))

        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        assertTrue(systemAnimationsDisabled(context))
    }
}
