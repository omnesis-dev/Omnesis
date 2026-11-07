// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.ui.pairing.PairingConfirmationSheet
import dev.omnesis.android.ui.devices.GatewayPairingApprovalContent
import dev.omnesis.android.ui.common.GatewayConnectionPill
import dev.omnesis.android.pairing.GatewayPairingApprovalController
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.ws.DeviceSocket
import dev.omnesis.android.ui.settings.AppearanceMode
import dev.omnesis.android.ui.settings.SettingsContent
import dev.omnesis.android.ui.settings.SettingsViewModel
import dev.omnesis.android.AppVersionInfo
import java.net.ConnectException
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.transport.routing.GatewayConnectionPath
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.pairing.GoogleCloudPairingPane
import dev.omnesis.android.ui.pairing.PairingContent
import dev.omnesis.android.ui.pairing.PairingViewModel
import dev.omnesis.android.ui.pairing.googlePairingPreviewState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class GoogleCloudPairingScreenshotTest {
    @Test fun all_pairing_states_light_and_dark() {
        for (phase in PairingViewModel.GooglePhase.entries) for (dark in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/google-pairing-${phase.name.lowercase()}-${if (dark) "dark" else "light"}.png") {
                CompositionLocalProvider(LocalInspectionMode provides true) {
                    SnapshotTheme(darkTheme = dark) { GoogleCloudPairingPane(googlePairingPreviewState(phase), {}, {}, {}) }
                }
            }
        }
    }
    @Test fun google_buttons_and_entry_remain_visible_with_large_text() {
        for (dark in listOf(false, true)) for (phase in listOf(PairingViewModel.GooglePhase.Idle, PairingViewModel.GooglePhase.Failed)) {
            captureRoboImage(filePath = "src/test/roborazzi/google-pairing-${phase.name.lowercase()}-large-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current.density
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density, fontScale = 2f)) {
                    SnapshotTheme(darkTheme = dark) { GoogleCloudPairingPane(googlePairingPreviewState(phase), {}, {}, {}) }
                }
            }
        }
        for (dark in listOf(false, true)) for (large in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/google-pairing-entry-${if (large) "large" else "standard"}-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current.density
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density, fontScale = if (large) 2f else 1f)) {
                    SnapshotTheme(darkTheme = dark) {
                        PairingContent(
                            state = PairingViewModel.State(mode = PairingViewModel.Mode.Manual, googleAvailable = true),
                            onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
                            onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
                        )
                    }
                }
            }
        }
    }
    @Test fun large_text_preserves_every_code_group() {
        for (dark in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/google-pairing-ready-large-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current.density
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density, fontScale = 2f)) {
                    SnapshotTheme(darkTheme = dark) { GoogleCloudPairingPane(googlePairingPreviewState(PairingViewModel.GooglePhase.Ready), {}, {}, {}) }
                }
            }
        }
    }
    @Test fun key_confirmation_full_digest_light_dark_and_large_text() {
        for (dark in listOf(false, true)) for (large in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/chapter-two-key-${if (large) "large" else "standard"}-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current.density
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density, fontScale = if (large) 2f else 1f)) {
                    SnapshotTheme(darkTheme = dark) {
                        PairingConfirmationSheet("gateway.example.test", "Verified gateway public key (V4)", PairingViewModel.TrustKind.PinnedKey,
                            "ab".repeat(32), false, {}, {}, Modifier.fillMaxSize())
                    }
                }
            }
        }
    }

    @Test fun owner_approval_comparison_and_status_light_dark_and_large_text() {
        val row = GatewayPairingApprovalRequest("00000000-0000-4000-8000-000000000901", "android", "Test phone", "pending", "AAAA-BBBB-CCCC-DDDD-EEEE", 1_100_000)
        for (dark in listOf(false, true)) for (compared in listOf(false, true)) for (large in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/chapter-two-approval-${if (compared) "compared" else "pending"}-${if (large) "large" else "standard"}-${if (dark) "dark" else "light"}.png") {
                val density = LocalDensity.current.density
                CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density, fontScale = if (large) 2f else 1f)) {
                    SnapshotTheme(darkTheme = dark) {
                        GatewayPairingApprovalContent(GatewayPairingApprovalController.State(requests = listOf(row),
                            compared = if (compared) mapOf(row.requestId to row.verificationCode) else emptyMap()), 1_000_000, { _, _ -> }, {}, { _, _ -> }, {})
                    }
                }
            }
        }
        for (dark in listOf(false, true)) {
            captureRoboImage(filePath = "src/test/roborazzi/chapter-two-paths-${if (dark) "dark" else "light"}.png") {
                SnapshotTheme(darkTheme = dark) {
                    Column(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(24.dp)) {
                        GatewayConnectionPath.entries.forEach { GatewayConnectionPill(it) }
                    }
                }
            }
        }
    }

    @Test fun owner_approval_errors_and_settings_routes() {
        val row = GatewayPairingApprovalRequest("00000000-0000-4000-8000-000000000901", "android", "Test phone", "pending", "AAAA-BBBB-CCCC-DDDD-EEEE", 1_100_000)
        for (dark in listOf(false, true)) {
            for (cached in listOf(false, true)) {
                captureRoboImage(filePath = "src/test/roborazzi/chapter-two-approval-${if (cached) "cached-error" else "unavailable"}-${if (dark) "dark" else "light"}.png") {
                    SnapshotTheme(darkTheme = dark) {
                        GatewayPairingApprovalContent(GatewayPairingApprovalController.State(requests = if (cached) listOf(row) else emptyList(),
                            error = GatewayException.Network(ConnectException("Unavailable"))),
                            1_000_000, { _, _ -> }, {}, { _, _ -> }, {})
                    }
                }
            }
            for (path in GatewayConnectionPath.entries) {
                captureRoboImage(filePath = "src/test/roborazzi/chapter-two-settings-${path.name.lowercase()}-${if (dark) "dark" else "light"}.png") {
                    SnapshotTheme(darkTheme = dark) {
                        SettingsContent(
                            gateway = SettingsViewModel.GatewayInfo(name = "Test gateway", url = "https://gateway.example.test", deviceId = "test-device",
                                scopes = listOf("read", "admin"), tlsMode = PairingTlsMode.PINNED_KEY_STRICT, usesDirectRouting = true),
                            connection = if (path == GatewayConnectionPath.RECONNECTING) DeviceSocket.ConnectionState.Connecting else
                                DeviceSocket.ConnectionState.Connected("test-device", "Test phone", listOf("read", "admin"), path),
                            mode = if (dark) AppearanceMode.DARK else AppearanceMode.LIGHT,
                            appVersion = AppVersionInfo("1.2.3", "42", 1),
                            onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {})
                    }
                }
            }
        }
    }

}

/** Match the existing screenshot harness: retain a real spinner arc without an unbounded frame loop. */
@Composable
private fun SnapshotTheme(darkTheme: Boolean, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalInspectionMode provides true) {
        OmnesisTheme(darkTheme = darkTheme, content = content)
    }
}
