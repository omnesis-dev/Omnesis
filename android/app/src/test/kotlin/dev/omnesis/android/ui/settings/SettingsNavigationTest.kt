// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performScrollTo
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.devices.DevicesContent
import dev.omnesis.android.ui.models.ModelsContent
import dev.omnesis.android.ui.models.sampleModelsOverview
import dev.omnesis.android.pairing.PairingTlsMode
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SettingsNavigationTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun gatewaySectionOpensModelAndDeviceManagement() {
        var modelsOpened = 0
        var devicesOpened = 0
        var policiesOpened = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                SettingsContent(
                    gateway = SettingsViewModel.GatewayInfo(
                        name = "Studio Northstar",
                        url = "https://gateway.example.com:7600",
                        deviceId = "dev-example",
                        scopes = listOf("read", "admin"),
                    ),
                    connection = ConnectionState.Connected(
                        deviceId = "dev-example",
                        deviceName = "Studio Northstar",
                        scopes = listOf("read", "admin"),
                    ),
                    mode = AppearanceMode.SYSTEM,
                    appVersion = sampleAppVersion(),
                    onClose = {},
                    onSetAppearance = {},
                    onSaveUrl = { null },
                    onUnpair = {},
                    onOpenModels = { modelsOpened += 1 },
                    onOpenDevices = { devicesOpened += 1 },
                    onOpenPolicies = { policiesOpened += 1 },
                )
            }
        }

        compose.onNodeWithText("Configure Models").assertIsDisplayed().performClick()
        compose.onNodeWithText("Configure Devices").assertIsDisplayed().performClick()
        // The gateway's own policy documents, distinct from the published app-store policy
        // the Legal section links out to.
        compose.onNodeWithText("Policies").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals(1, modelsOpened)
            assertEquals(1, devicesOpened)
            assertEquals(1, policiesOpened)
        }
    }

    @Test
    fun legalSectionOpensThePublishedMobilePrivacyPolicy() {
        var opened = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                SettingsContent(
                    gateway = null,
                    connection = ConnectionState.Disconnected,
                    mode = AppearanceMode.SYSTEM,
                    appVersion = sampleAppVersion(),
                    onClose = {},
                    onSetAppearance = {},
                    onSaveUrl = { null },
                    onUnpair = {},
                    onOpenPrivacyPolicy = { opened += 1 },
                )
            }
        }

        compose.onNodeWithText("Mobile privacy policy").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1, opened) }
        assertEquals("https", android.net.Uri.parse(MOBILE_PRIVACY_POLICY_URL).scheme)
    }

    @Test
    fun gatewayUrlValidationErrorIsShownInsteadOfEscapingTheClickHandler() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                SettingsContent(
                    gateway = SettingsViewModel.GatewayInfo(
                        name = "Public gateway",
                        url = "https://public-gateway.example.com",
                        deviceId = "dev-public",
                        scopes = listOf("read", "admin"),
                        tlsMode = PairingTlsMode.SYSTEM,
                    ),
                    connection = ConnectionState.Disconnected,
                    mode = AppearanceMode.SYSTEM,
                    appVersion = sampleAppVersion(),
                    onClose = {},
                    onSetAppearance = {},
                    onSaveUrl = { "Re-pair to change this gateway authority" },
                    onUnpair = {},
                )
            }
        }

        compose.onNodeWithText("Edit").performClick()
        compose.onNodeWithText("Save").performClick()
        compose.onNodeWithText("Re-pair to change this gateway authority").assertIsDisplayed()
    }

    @Test
    fun successfulGatewayUrlSaveRecomposesWithTheNewUrl() {
        val original = "https://gateway.example.com:7600"
        val updated = "https://gateway.tailnet.example:7600"
        compose.setContent {
            var gateway by remember {
                mutableStateOf(
                    SettingsViewModel.GatewayInfo(
                        name = "Studio Northstar",
                        url = original,
                        deviceId = "dev-example",
                        scopes = listOf("read", "admin"),
                    ),
                )
            }
            OmnesisTheme(darkTheme = false) {
                SettingsContent(
                    gateway = gateway,
                    connection = ConnectionState.Disconnected,
                    mode = AppearanceMode.SYSTEM,
                    appVersion = sampleAppVersion(),
                    onClose = {},
                    onSetAppearance = {},
                    onSaveUrl = { value -> gateway = gateway.copy(url = value); null },
                    onUnpair = {},
                )
            }
        }

        compose.onNodeWithText("Edit").performClick()
        compose.onNodeWithText(original).performTextReplacement(updated)
        compose.onNodeWithText("Save").performClick()
        compose.onNodeWithText(updated).assertIsDisplayed()
    }

    @Test
    fun modelsLeadingActionReturnsToSettings() {
        var backs = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                ModelsContent(
                    state = Loadable.Loading,
                    connection = ConnectionState.Disconnected,
                    onBack = { backs += 1 },
                    onRetry = {},
                )
            }
        }

        compose.onNodeWithContentDescription("Back to Settings").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, backs) }
    }

    @Test
    fun modelsBackendActionOpensBackendManagement() {
        var backendsOpened = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                ModelsContent(
                    state = Loadable.Content(sampleModelsOverview()),
                    connection = ConnectionState.Disconnected,
                    onBack = {},
                    onRetry = {},
                    onOpenBackends = { backendsOpened += 1 },
                )
            }
        }

        compose.onNodeWithText("Configure backends").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, backendsOpened) }
    }

    @Test
    fun devicesLeadingActionReturnsToSettings() {
        var backs = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                DevicesContent(
                    devices = Loadable.Loading,
                    tokens = emptyMap(),
                    onBack = { backs += 1 },
                    onRetry = {},
                )
            }
        }

        compose.onNodeWithContentDescription("Back to Settings").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, backs) }
    }
}
