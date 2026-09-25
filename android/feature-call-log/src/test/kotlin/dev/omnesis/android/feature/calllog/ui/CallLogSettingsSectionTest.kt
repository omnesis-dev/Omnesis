// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog.ui

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallLogSettingsSectionTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun hardDenialShowsClickableSettingsRemediationInsteadOfSetup() {
        compose.setContent {
            OmnesisTheme(darkTheme = true) {
                CallLogSettingsSectionContent(
                    state = CallLogViewModel.UiState(permissionPermanentlyDenied = true),
                    onSetUp = {},
                    onSyncNow = {},
                    onOpenAppSettings = {},
                    onDisable = {},
                )
            }
        }

        compose.onNodeWithText("Permission denied").assertIsDisplayed().assertHasClickAction()
        compose.onNodeWithText("grant it from system Settings instead", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Set up Call Log").assertDoesNotExist()
    }
}
