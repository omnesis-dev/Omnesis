// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.BriefRecordDto
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class BriefsWarningTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun missingBackgroundAgentWarnsWithoutHidingStoredBriefs() {
        var configureCount = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                BriefsListContent(
                    feed = BriefsFeedState().replacing(
                        listOf(BriefRecordDto(id = "brief-example", title = "Review the quarterly plan")),
                    ),
                    loading = false,
                    loadError = null,
                    onOpen = {},
                    onQuickClear = {},
                    onAsk = {},
                    onMoreOptions = {},
                    onRetry = {},
                    onRefresh = {},
                    needsBackgroundAgent = true,
                    onConfigureBackgroundAgent = { configureCount += 1 },
                )
            }
        }

        compose.onNodeWithText("Review the quarterly plan").assertIsDisplayed()
        compose.onNodeWithText("Background agent needs attention")
            .assertIsDisplayed()
            .performClick()
        compose.runOnIdle { assertEquals(1, configureCount) }
    }
}
