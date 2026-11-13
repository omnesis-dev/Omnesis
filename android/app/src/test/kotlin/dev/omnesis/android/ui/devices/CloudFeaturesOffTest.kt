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
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.notifications.knownNotificationKind
import dev.omnesis.android.notifications.notificationAction
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import dev.omnesis.android.transport.dto.DeviceEnrollmentRecord
import dev.omnesis.android.transport.dto.DeviceRecord
import dev.omnesis.android.transport.routing.GatewayConnectionPath
import dev.omnesis.android.transport.ws.DeviceSocket
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.pairing.accountPairingConfigured
import dev.omnesis.android.ui.settings.AppearanceMode
import dev.omnesis.android.ui.settings.SettingsContent
import dev.omnesis.android.ui.settings.SettingsViewModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * With the cloud build flag off the app is the one on main, whatever a gateway sends. The
 * unchanged Devices and Settings goldens prove the pixels; this proves a gateway that does send
 * enrollment data cannot bring anything back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class CloudFeaturesOffTest {
    @get:Rule val compose = createComposeRule()

    private val now = 1_800_000_000_000L
    private val enrolled = DeviceRecord(
        id = "device-a", name = "Maya's Phone", kind = "android", pairedAt = now - 60_000, online = true, connectionPath = "relay",
        enrollment = DeviceEnrollmentRecord("automatic", "google", now - 60_000),
    )
    private val joinedCopy = "Joined with Omnesis account"
    private val settingsCopy = listOf("NEW DEVICES", "Join automatically", "Ask me first", "Omnesis account")

    private fun devices(cloudFeatures: Boolean) {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    DeviceCard(enrolled, tokens = null, isThis = false, startExpanded = true, now = now, cloudFeatures = cloudFeatures)
                }
            }
        }
    }

    private fun settings(cloudFeatures: Boolean, omnesisAccountOffered: Boolean = true) {
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
                        cloudFeatures = cloudFeatures,
                    )
                }
            }
        }
    }

    @Test fun `the default test build has the flag off, so the goldens render the build on main`() {
        assertFalse(BuildConfig.CLOUD_RELAY_ENABLED)
        assertFalse(accountPairingConfigured(relayOrigin = "https://relay.example.test", enabled = false))
    }

    @Test fun `the default build's manifest carries nothing from the sign-in libraries`() {
        val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        @Suppress("DEPRECATION")
        val info = context.packageManager.getPackageInfo(
            context.packageName,
            android.content.pm.PackageManager.GET_ACTIVITIES or android.content.pm.PackageManager.GET_SERVICES or
                android.content.pm.PackageManager.GET_PERMISSIONS,
        )
        val components = info.activities.orEmpty().map { it.name } + info.services.orEmpty().map { it.name }
        val added = components.filter { it.startsWith("androidx.credentials.") || it.startsWith("com.google.android.gms.auth.api.") }
        assertEquals(emptyList<String>(), added)
        val permissions = info.requestedPermissions.orEmpty().toSet()
        assertFalse("android.permission.USE_BIOMETRIC" in permissions)
        assertFalse("android.permission.USE_FINGERPRINT" in permissions)
    }

    @Test fun `the build's capabilities carry the flag the session and pairing follow`() {
        val capabilities = dev.omnesis.android.di.AppModule.provideDeviceCapabilities(emptySet(), AppVersionInfo("1.2.3", "42", 1))
        assertEquals(BuildConfig.CLOUD_RELAY_ENABLED, capabilities.pairingNotifications)
        assertFalse(capabilities.pairingNotifications)
    }

    private fun pairingTitle(cloudFeatures: Boolean): androidx.compose.ui.text.TextLayoutInput {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    dev.omnesis.android.ui.pairing.PairingContent(
                        state = dev.omnesis.android.ui.pairing.PairingViewModel.State(mode = dev.omnesis.android.ui.pairing.PairingViewModel.Mode.Manual),
                        onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
                        onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
                        cloudFeatures = cloudFeatures,
                    )
                }
            }
        }
        val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        compose.onNodeWithText("Pair with your gateway")
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult) { it(layouts) }
        return layouts.single().layoutInput
    }

    @Test fun `the pairing title wraps as before when off`() {
        val title = pairingTitle(cloudFeatures = false)
        assertEquals(Int.MAX_VALUE, title.maxLines)
        assertEquals(androidx.compose.ui.text.style.TextOverflow.Clip, title.overflow)
        compose.onNodeWithText("Google").assertDoesNotExist()
        compose.onNodeWithText("Sign in").assertDoesNotExist()
    }

    @Test fun `the pairing title stays on one line when on`() {
        val title = pairingTitle(cloudFeatures = true)
        assertEquals(1, title.maxLines)
        assertEquals(androidx.compose.ui.text.style.TextOverflow.Ellipsis, title.overflow)
    }

    @Test fun `a device card shows no way of joining or route when off`() {
        devices(cloudFeatures = false)
        assertEquals(0, compose.onAllNodesWithText(joinedCopy).fetchSemanticsNodes().size)
        compose.onNodeWithTag("device.joined").assertDoesNotExist()
        compose.onNodeWithTag("gateway.connectionPath", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun `a device card shows how the device joined when on`() {
        devices(cloudFeatures = true)
        compose.onNodeWithText(joinedCopy).assertIsDisplayed()
    }

    @Test fun `settings show no enrollment section or route when off`() {
        settings(cloudFeatures = false)
        for (text in settingsCopy) assertEquals(text, 0, compose.onAllNodesWithText(text).fetchSemanticsNodes().size)
        compose.onNodeWithTag("gateway.connectionPath", useUnmergedTree = true).assertDoesNotExist()
    }

    /** "New devices" lives on the Omnesis account screen only. */
    @Test fun `settings never show the enrollment choice themselves`() {
        settings(cloudFeatures = true)
        for (text in listOf("NEW DEVICES", "Join automatically", "Ask me first")) {
            assertEquals(text, 0, compose.onAllNodesWithText(text).fetchSemanticsNodes().size)
        }
    }

    @Test fun `settings offer the Omnesis account only when on and the gateway has it`() {
        settings(cloudFeatures = true)
        assertEquals(1, compose.onAllNodesWithText("Omnesis account").fetchSemanticsNodes().size)
    }

    @Test fun `a gateway without Omnesis account settings gets no row for them`() {
        settings(cloudFeatures = true, omnesisAccountOffered = false)
        assertEquals(0, compose.onAllNodesWithText("Omnesis account").fetchSemanticsNodes().size)
    }

    @Test fun `the list offers no pairing requests when off`() {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    DevicesContent(devices = Loadable.Content(listOf(enrolled)), tokens = emptyMap(), onBack = {}, onRetry = {}, onPairingRequests = null, cloudFeatures = false)
                }
            }
        }
        compose.onNodeWithContentDescription("Pairing requests").assertDoesNotExist()
    }

    private fun pairSheet(cloudFeatures: Boolean, kind: String = "ios") {
        val state = DevicesViewModel.PairState(
            gatewayUrl = "https://gateway.example:7600",
            identities = listOf(
                dev.omnesis.android.transport.dto.NetworkIdentity("192.0.2.42", "LAN (en0)", "lan", false),
                dev.omnesis.android.transport.dto.NetworkIdentity("198.51.100.7", "Tailscale", "tailscale", true),
            ),
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
                OmnesisTheme { PairDeviceSheetContent(state, {}, {}, {}, repairTarget = null, cloudFeatures = cloudFeatures) }
            }
        }
    }

    @Test fun `the pair sheet is main's network-identity picker when off`() {
        pairSheet(cloudFeatures = false)
        compose.onNodeWithText("Address the new device will connect to").assertExists()
        compose.onNodeWithText("192.0.2.42 — LAN (en0)").assertExists()
        compose.onNodeWithText("Scan with the Omnesis app on the new device").assertExists()
        compose.onNodeWithText("Or paste this payload manually").assertExists()
        compose.onNodeWithContentDescription("Copy pairing payload").assertExists()
        compose.onNodeWithText("Can't scan the code?").assertDoesNotExist()
        compose.onNodeWithTag("pair.reach").assertDoesNotExist()
    }

    @Test fun `an agent's commands name the chosen network identity when off`() {
        pairSheet(cloudFeatures = false, kind = "agent")
        compose.onNodeWithText("Address the agent host will connect to").assertExists()
        compose.onNodeWithText("omnesis connect openclaw --gateway-url https://192.0.2.42:7600 --code 7K3M-9QX2").assertExists()
    }

    @Test fun `the pair sheet shows the gateway's address plan when on`() {
        pairSheet(cloudFeatures = true)
        compose.onNodeWithTag("pair.reach").assertExists()
        compose.onNodeWithText("Address the new device will connect to").assertDoesNotExist()
        compose.onNodeWithText("Or paste this payload manually").assertDoesNotExist()
    }

    @Test fun `forgetting a device keeps main's wording when off`() {
        assertEquals("Forget Maya's Phone?", forgetDeviceTitle(enrolled, cloudFeatures = false))
        assertEquals(
            "Deletes the device for good. A device that still hosts sources is refused — remove those sources first.",
            forgetDeviceBody(enrolled, cloudFeatures = false),
        )
        assertEquals("Forget device?", forgetDeviceTitle(enrolled, cloudFeatures = true))
    }

    @Test fun `the main screen never reads pairing requests when off`() {
        assertFalse(dev.omnesis.android.access.PairingPendingRequests.polls())
        assertFalse(dev.omnesis.android.access.PairingPendingRequests.polls(cloudEnabled = false))
        org.junit.Assert.assertTrue(dev.omnesis.android.access.PairingPendingRequests.polls(cloudEnabled = true))
    }

    @Test fun `no cloud notification kind is routed when off`() {
        for (kind in listOf("device-pairing", "device-joined")) {
            assertFalse(knownNotificationKind(kind, cloudEnabled = false))
            assertNull(notificationAction(delivery(kind), cloudEnabled = false))
        }
    }

    private fun delivery(kind: String) = ClaimedNotificationDelivery(
        id = "00000000-0000-4000-8000-000000000100", kind = kind, targetId = "pairing",
        title = "Fictional", body = "Fictional", collapseId = "$kind:fictional",
    )
}
