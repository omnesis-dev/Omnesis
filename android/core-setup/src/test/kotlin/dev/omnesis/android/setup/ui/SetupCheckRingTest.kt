// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.ui

import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.setup.flow.SetupOutcome
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The success ring when an outcome changes in place on the same page, as it
 * does when the app returns from Settings and the enable continues: it draws
 * again for every new success, and always ends fully drawn.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SetupCheckRingTest {
    @get:Rule
    val compose = createComposeRule()

    private var outcome by mutableStateOf<SetupOutcome>(SetupOutcome.NotAllowed)

    private fun showOutcome() {
        compose.setContent {
            OmnesisTheme {
                val current = outcome
                if (current.kind.contributing) {
                    SetupCheckRing(Color(0xFF4B9BFF), drawKey = current)
                } else {
                    Box(Modifier.size(1.dp))
                }
            }
        }
    }

    /** Changes the outcome while the clock is paused, and lets the page recompose for it in the next frame. */
    private fun changeOutcomeWithClockPaused(next: SetupOutcome) {
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { outcome = next }
        Snapshot.sendApplyNotifications()
        compose.mainClock.advanceTimeByFrame()
    }

    private fun fullyDrawn(): Boolean =
        compose.onNodeWithContentDescription("Done").fetchSemanticsNode().config[SetupCheckRingFullyDrawn]

    @Test
    fun aNewSuccessOnTheSamePageDrawsTheRingAgain() {
        outcome = SetupOutcome.Limited
        showOutcome()
        compose.waitForIdle()
        assertTrue(fullyDrawn())

        changeOutcomeWithClockPaused(SetupOutcome.On)
        compose.mainClock.advanceTimeBy(150)
        assertFalse("the draw starts again for the new outcome, not left as it was", fullyDrawn())

        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertTrue(fullyDrawn())
    }

    @Test
    fun withAnimationsOffTheRingIsDrawnCompleteAtOnce() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        showOutcome()
        changeOutcomeWithClockPaused(SetupOutcome.On)
        compose.mainClock.advanceTimeByFrame()
        assertTrue(fullyDrawn())
    }
}
