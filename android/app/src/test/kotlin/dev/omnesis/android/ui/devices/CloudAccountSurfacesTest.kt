// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import dev.omnesis.android.AppVersionInfo
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.DeviceEnrollmentRecord
import dev.omnesis.android.transport.dto.DeviceRecord
import dev.omnesis.android.transport.routing.GatewayConnectionPath
import dev.omnesis.android.transport.ws.DeviceSocket
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.settings.AppearanceMode
import dev.omnesis.android.ui.settings.SettingsContent
import dev.omnesis.android.ui.settings.SettingsViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** What the Omnesis account adds to Devices, Settings and pairing, in every build. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class CloudAccountSurfacesTest {
    @get:Rule val compose = createComposeRule()

    private val now = 1_800_000_000_000L
    private val enrolled = DeviceRecord(
        id = "device-a", name = "Maya's Phone", kind = "android", pairedAt = now - 60_000, online = true, connectionPath = "relay",
        enrollment = DeviceEnrollmentRecord("automatic", "google", now - 60_000),
    )
    private val joinedCopy = "Joined with Omnesis account"

    private fun devices() {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    DeviceCard(enrolled, tokens = null, isThis = false, startExpanded = true, now = now)
                }
            }
        }
    }

    private fun settings(omnesisAccountOffered: Boolean = true) {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    SettingsContent(
                        gateway = SettingsViewModel.GatewayInfo("Test gateway", "https://gateway.example.test", "device", listOf("read", "admin"), PairingTlsMode.PINNED_KEY_STRICT, usesDirectRouting = true),
                        connection = DeviceSocket.ConnectionState.Connected("device", "Test phone", listOf("read"), GatewayConnectionPath.RELAY),
                        mode = AppearanceMode.SYSTEM,
                        appVersion = AppVersionInfo("1.2.3", "42", 1),
                        onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {},
                        omnesisAccountOffered = omnesisAccountOffered,
                    )
                }
            }
        }
    }

    @Test fun `the build announces that it routes pairing notifications`() {
        val capabilities = dev.omnesis.android.di.AppModule.provideDeviceCapabilities(emptySet(), AppVersionInfo("1.2.3", "42", 1))
        assertTrue(capabilities.pairingNotifications)
    }

    private fun pairingTitle(): androidx.compose.ui.text.TextLayoutInput {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    dev.omnesis.android.ui.pairing.PairingContent(
                        state = dev.omnesis.android.ui.pairing.PairingViewModel.State(mode = dev.omnesis.android.ui.pairing.PairingViewModel.Mode.Manual),
                        onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
                        onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
                    )
                }
            }
        }
        val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        compose.onNodeWithText("Pair with your gateway")
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult) { it(layouts) }
        return layouts.single().layoutInput
    }

    @Test fun `the pairing title stays on one line`() {
        val title = pairingTitle()
        assertEquals(1, title.maxLines)
        assertEquals(androidx.compose.ui.text.style.TextOverflow.Ellipsis, title.overflow)
    }

    @Test fun `a device card shows how the device joined`() {
        devices()
        compose.onNodeWithText(joinedCopy).assertIsDisplayed()
    }

    /** "New devices" lives on the Omnesis account screen only. */
    @Test fun `settings never show the enrollment choice themselves`() {
        settings()
        for (text in listOf("NEW DEVICES", "Join automatically", "Ask me first")) {
            assertEquals(text, 0, compose.onAllNodesWithText(text).fetchSemanticsNodes().size)
        }
    }

    @Test fun `settings offer the Omnesis account when the gateway has it`() {
        settings()
        assertEquals(1, compose.onAllNodesWithText("Omnesis account").fetchSemanticsNodes().size)
    }

    @Test fun `a gateway without Omnesis account settings gets no row for them`() {
        settings(omnesisAccountOffered = false)
        assertEquals(0, compose.onAllNodesWithText("Omnesis account").fetchSemanticsNodes().size)
    }

    private fun pairSheet(kind: String = "ios") {
        val state = DevicesViewModel.PairState(
            addressPlan = dev.omnesis.android.transport.dto.PairingAddressPlan(
                "ios",
                listOf(dev.omnesis.android.transport.dto.PairingAddressOption("https://gateway.example:7600", "gateway.example", "Public address", usable = true, systemTrust = true)),
                recommendedUrl = "https://gateway.example:7600",
            ),
            selectedUrl = "https://gateway.example:7600",
            pending = dev.omnesis.android.transport.dto.PendingPairing("7K3M-9QX2", now + 540_000),
            kind = kind,
            qrPayload = "{\"v\":4}",
        )
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme { PairDeviceSheetContent(state, {}, {}, repairTarget = null) }
            }
        }
    }

    @Test fun `the pair sheet shows the gateway's address plan`() {
        pairSheet()
        compose.onNodeWithTag("pair.reach").assertExists()
        compose.onNodeWithText("Address the new device will connect to").assertDoesNotExist()
        compose.onNodeWithText("Or paste this payload manually").assertDoesNotExist()
    }

    /** A gateway that advertises the feature but then answers 404 still leaves the screen as it was. */
    @Test fun `a gateway without Tailscale joins offers no pairing requests to a phone that cannot review sign-ins`() {
        val gateway = object : dev.omnesis.android.transport.dto.TailscaleJoinApproving {
            override suspend fun tailscaleJoinRequests(): List<dev.omnesis.android.transport.dto.TailscaleJoinRequest> =
                throw GatewayException.NotFound("Not Found")
            override suspend fun decideTailscaleJoin(id: String, approve: Boolean) = "approved"
        }
        val joins = TailscaleJoinRequestsViewModel { gateway }
        joins.refresh()
        compose.waitUntil(timeoutMillis = 5_000) { joins.state.value.loaded }
        assertEquals(false, joins.state.value.available)
        assertFalse(deviceApprovalsOffered(null, joins.state.value.available))
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    DevicesContent(
                        devices = Loadable.Content(listOf(enrolled)), tokens = emptyMap(), onBack = {}, onRetry = {},
                        onPairingRequests = if (deviceApprovalsOffered(null, joins.state.value.available)) ({}) else null,
                    )
                }
            }
        }
        compose.onNodeWithContentDescription("Pairing requests").assertDoesNotExist()
    }
}
