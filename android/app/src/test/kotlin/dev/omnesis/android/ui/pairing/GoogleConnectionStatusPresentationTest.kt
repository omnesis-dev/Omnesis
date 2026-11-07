// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import dev.omnesis.android.AppVersionInfo
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.dto.DeviceRecord
import dev.omnesis.android.transport.routing.GatewayConnectionPath
import dev.omnesis.android.transport.ws.DeviceSocket
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.devices.DevicesContent
import dev.omnesis.android.ui.settings.AppearanceMode
import dev.omnesis.android.ui.settings.SettingsContent
import dev.omnesis.android.ui.settings.SettingsViewModel
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class GoogleConnectionStatusPresentationTest {
    @get:Rule val compose = createComposeRule()

    @Test fun device_status_ignores_unknown_or_revoked_advisory_paths_and_opens_approval_only_when_available() {
        val row = mutableStateOf(DeviceRecord("device", "Test phone", "android", online = true))
        val mayApprove = mutableStateOf(false)
        var opens = 0
        compose.setContent { OmnesisTheme {
            DevicesContent(devices = Loadable.Content(listOf(row.value)), thisDeviceId = "device", tokens = emptyMap(),
                onBack = {}, onRetry = {}, onPairingRequests = if (mayApprove.value) ({ opens++ }) else null)
        } }
        compose.onNodeWithContentDescription("Pairing requests").assertDoesNotExist()
        for ((wire, label) in listOf("local" to "Local", "relay" to "Relay", "reconnecting" to "Reconnecting")) {
            compose.runOnIdle { row.value = row.value.copy(connectionPath = wire) }
            compose.onNodeWithTag("gateway.connectionPath", useUnmergedTree = true).performScrollTo().assertTextEquals(label)
        }
        for (wire in listOf(null, "unrecognized")) {
            compose.runOnIdle { row.value = row.value.copy(connectionPath = wire) }
            compose.onNodeWithTag("gateway.connectionPath", useUnmergedTree = true).assertDoesNotExist()
        }
        compose.runOnIdle { row.value = row.value.copy(connectionPath = "local", revokedAt = 1L); mayApprove.value = true }
        compose.onNodeWithTag("gateway.connectionPath", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithContentDescription("Pairing requests").performClick()
        assertEquals(1, opens)
    }

    @Test fun settings_keep_ordinary_connections_unchanged_and_show_only_the_selected_routed_path() {
        val state = mutableStateOf<DeviceSocket.ConnectionState>(DeviceSocket.ConnectionState.Connected("device", "Test phone", listOf("read")))
        val routed = mutableStateOf(false)
        compose.setContent { CompositionLocalProvider(LocalInspectionMode provides true) { OmnesisTheme {
            SettingsContent(gateway = SettingsViewModel.GatewayInfo("Test gateway", "https://gateway.example.test", "device",
                listOf("read"), PairingTlsMode.PINNED_KEY_STRICT, usesDirectRouting = routed.value),
                connection = state.value, mode = AppearanceMode.SYSTEM, appVersion = AppVersionInfo("1.2.3", "42", 1),
                onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {})
        } } }
        compose.onNodeWithTag("gateway.connectionPath", useUnmergedTree = true).assertDoesNotExist()
        for (path in GatewayConnectionPath.entries) {
            compose.runOnIdle { routed.value = true; state.value = DeviceSocket.ConnectionState.Connected("device", "Test phone", listOf("read"), path) }
            compose.onNodeWithTag("gateway.connectionPath", useUnmergedTree = true).performScrollTo().assertTextEquals(path.name.lowercase().replaceFirstChar { it.uppercase() })
        }
        compose.runOnIdle { state.value = DeviceSocket.ConnectionState.Connecting }
        compose.onNodeWithTag("gateway.connectionPath", useUnmergedTree = true).assertTextEquals("Reconnecting")
        compose.runOnIdle { routed.value = false }
        compose.onNodeWithTag("gateway.connectionPath", useUnmergedTree = true).assertDoesNotExist()
    }
}
