// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The indicator follows the screen's in-flight flag, not its data.
 *
 * The failure this guards against is the ordinary case, not an exotic one: pulling a list that
 * is already up to date returns a value equal to the last one, `StateFlow` conflates equal
 * values so nothing is emitted at all, and an indicator waiting for the data to *change* stays
 * on screen forever.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PullToRefreshTest {

    @get:Rule
    val compose = createComposeRule()

    private val spinner = SemanticsMatcher.keyIsDefined(
        androidx.compose.ui.semantics.SemanticsProperties.ProgressBarRangeInfo,
    )

    @Test
    fun the_indicator_retires_when_the_refresh_settles_even_if_nothing_changed() {
        val refreshing = mutableStateOf(true)
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PullToRefresh(
                    refreshing = refreshing.value,
                    onRefresh = {},
                    modifier = Modifier.fillMaxSize(),
                ) { Text("a list that did not change") }
            }
        }

        compose.onNode(spinner).assertIsDisplayed()

        // The refresh settles and returns exactly what was already there: no new data, only the
        // flag going false.
        compose.runOnIdle { refreshing.value = false }

        compose.onNode(spinner).assertDoesNotExist()
        compose.onNodeWithText("a list that did not change").assertIsDisplayed()
    }

    @Test
    fun a_disabled_surface_shows_no_indicator_and_cannot_be_pulled() {
        var pulls = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PullToRefresh(
                    refreshing = true,
                    onRefresh = { pulls += 1 },
                    enabled = false,
                ) { Text("first load still running") }
            }
        }

        compose.onNode(spinner).assertDoesNotExist()
        compose.runOnIdle { check(pulls == 0) }
    }
}
