// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import dev.omnesis.android.AppVersionInfo
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The About section is how an operator reads back which build a phone is
 * running — the first question asked when a device misbehaves — so each of
 * the three numbers has to reach the screen, not just the data class.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SettingsAboutTest {
    @get:Rule
    val compose = createComposeRule()

    private val version = AppVersionInfo(version = "9.8.7", build = "4242", wireProtocol = 7)

    private fun showSettings(paired: Boolean = true) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                SettingsContent(
                    gateway = if (paired) {
                        SettingsViewModel.GatewayInfo(
                            name = "Studio Northstar",
                            url = "https://gateway.example.com:7600",
                            deviceId = "dev-example",
                            scopes = listOf("read"),
                        )
                    } else {
                        null
                    },
                    connection = ConnectionState.Disconnected,
                    mode = AppearanceMode.SYSTEM,
                    appVersion = version,
                    onClose = {},
                    onSetAppearance = {},
                    onSaveUrl = { null },
                    onUnpair = {},
                )
            }
        }
    }

    @Test
    fun aboutSectionShowsEveryVersionThisBuildCanState() {
        showSettings()
        // The section header is drawn upper-cased, like every other one.
        compose.onNodeWithText("ABOUT").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Version").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("9.8.7").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Build").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("4242").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Wire protocol").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("7").performScrollTo().assertIsDisplayed()
    }

    /**
     * An unpaired phone hides the whole Gateway card. The build it is running
     * is exactly what someone debugging a failed pairing needs, so About must
     * not travel with it.
     */
    @Test
    fun aboutSectionSurvivesAnUnpairedPhone() {
        showSettings(paired = false)
        compose.onNodeWithText("9.8.7").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("4242").performScrollTo().assertIsDisplayed()
    }
}
