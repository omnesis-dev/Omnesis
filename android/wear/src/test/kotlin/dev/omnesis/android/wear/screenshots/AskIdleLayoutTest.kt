// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import dev.omnesis.android.wear.ui.OmnesisWearTheme
import dev.omnesis.android.wear.ui.TimeRoom
import dev.omnesis.android.wear.ui.WatchActions
import dev.omnesis.android.wear.ui.WatchPresentation
import dev.omnesis.android.wear.ui.WatchRoot
import dev.omnesis.android.wear.ui.WatchUiState
import dev.omnesis.android.wearprotocol.WearLine
import kotlin.math.abs
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Where the idle ask screen puts its block of controls: in the middle of the
 * room under the time, on every display shape, with none of it cut off.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AskIdleLayoutTest {
    @get:Rule
    val compose = createComposeRule()

    private fun bounds(): Triple<Rect, Rect, Rect> {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisWearTheme { WatchRoot(WatchUiState(), WatchPresentation(), WatchActions()) }
            }
        }
        compose.waitForIdle()
        val screen = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val name = compose.onNodeWithText(WearLine.APP_NAME.text).fetchSemanticsNode().boundsInRoot
        val lowest = compose.onNodeWithContentDescription(WearLine.TYPE_A_QUESTION.text)
            .fetchSemanticsNode().boundsInRoot
        return Triple(screen, name, lowest)
    }

    private fun assertCentredUnderTheTime() {
        val (screen, name, lowest) = bounds()
        val density = compose.density.density
        val timeRoom = TimeRoom.value * density
        // The mark beside the name is the tallest thing in the top row.
        val blockTop = name.center.y - MARK_HEIGHT_DP * density / 2
        val blockBottom = lowest.bottom
        assertTrue("the block starts under the time", blockTop >= timeRoom)
        assertTrue("the block ends on the screen", blockBottom <= screen.bottom)
        val above = blockTop - timeRoom
        val below = screen.bottom - blockBottom
        assertTrue(
            "the block is centred under the time: ${above / density}dp above it, ${below / density}dp below",
            abs(above - below) <= 2 * density,
        )
    }

    @Test
    @Config(qualifiers = "w227dp-h227dp-small-notlong-round-watch-xhdpi-keyshidden-nonav")
    fun on_a_large_round_display() = assertCentredUnderTheTime()

    @Test
    @Config(qualifiers = "w192dp-h192dp-small-notlong-round-watch-xhdpi-keyshidden-nonav")
    fun on_the_smallest_round_display() = assertCentredUnderTheTime()

    private companion object {
        const val MARK_HEIGHT_DP = 26f
    }
}
