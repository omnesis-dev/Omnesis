// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * LIVE reveal regression for the working dots — the half a seeded golden cannot catch.
 *
 * The dots are debounced ([rememberWorkingDotsRevealed]): from a hidden start they must NOT reveal
 * instantly, must STAY hidden partway through the quiet window (so a token arriving before it
 * elapses re-arms the timer rather than flashing the dots), and must reveal once the window fully
 * passes. This drives the frame clock manually to assert all three, exercising the exact production
 * reveal path (`rememberWorkingDotsRevealed` gating [WorkingDots]).
 *
 * (This guards the class of bug that shipped on iOS: a reveal effect that never fired, which a
 * seeded snapshot renders around and stays green on.) The revealed frame doubles as the golden.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentWorkingIndicatorRevealTest {

    @get:Rule val compose = createComposeRule()

    @Test fun dots_reveal_only_after_the_debounce_from_a_hidden_start() {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = true) {
                    Box(Modifier.background(OmTheme.colors.bgPrimary).padding(24.dp)) {
                        if (rememberWorkingDotsRevealed(active = true, revision = 0)) {
                            WorkingDots(Modifier.testTag("workingDots"))
                        }
                    }
                }
            }
        }

        // Hidden immediately after mount, and STILL hidden partway through the quiet window: the
        // reveal must wait, so a token arriving before it elapses would re-arm rather than flash.
        compose.onNodeWithTag("workingDots").assertDoesNotExist()
        compose.mainClock.advanceTimeBy(250) // < 350ms debounce
        compose.onNodeWithTag("workingDots").assertDoesNotExist()

        // Once the full quiet window passes, the dots reveal.
        compose.mainClock.advanceTimeBy(200) // total 450ms > 350ms
        compose.onNodeWithTag("workingDots").assertIsDisplayed()

        compose.onRoot().captureRoboImage("src/test/roborazzi/agent-working-dots-revealed.png")
    }
}
